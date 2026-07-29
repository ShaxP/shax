//! macOS app menu, window spawn helper, and lifecycle utilities (M9.4).
//!
//! Owns three things:
//!
//! 1. **Menu construction** (`build_app_menu`) — the macOS-native app menu
//!    with Shax / File / Edit / Window submenus. Attached once on
//!    `.setup(...)` in `lib.rs`.
//! 2. **Menu event dispatch** (`handle_menu_event`) — routes menu-item
//!    activations to either backend actions (spawn a window, close a
//!    window) or frontend event emits (`shax:menu-*` events that App.tsx
//!    listens for).
//! 3. **`spawn_new_window`** — sync helper that builds a fresh
//!    `WebviewWindow`, registers window-close PTY teardown, and returns
//!    the new label. Shared between the `open_new_window` IPC command
//!    and the `RunEvent::Reopen` handler for macOS dock-icon clicks.
//!
//! macOS-only surface — non-macOS builds compile every function but
//! `build_app_menu` returns `None` because a webview menu doesn't fit
//! Shax's design. Windows and Linux continue to use the existing
//! frontend keydown handlers for `⌘N/⌘T/⌘W/⌘,`.
//!
//! See `specs/15-multi-window.md`.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use uuid::Uuid;

use crate::mux::{WindowId, Windows};
use crate::pty::PtyManager;

// ─── Menu item ids ─────────────────────────────────────────────────
//
// Exported as constants so `build_app_menu` and `handle_menu_event`
// reference the same string — a rename in one place breaks tests
// covering the other. Each id also becomes the CustomEvent name the
// frontend listens for where the action is frontend-owned.

pub const MENU_ID_NEW_WINDOW: &str = "menu.file.new-window";
pub const MENU_ID_NEW_TAB: &str = "menu.file.new-tab";
pub const MENU_ID_CLOSE_TAB: &str = "menu.file.close-tab";
pub const MENU_ID_CLOSE_WINDOW: &str = "menu.file.close-window";
pub const MENU_ID_PREFERENCES: &str = "menu.shax.preferences";

/// Custom event names emitted to the focused webview for menu items
/// whose action lives on the frontend side. Match the ids above so
/// the mapping is one-to-one.
pub const EVENT_MENU_NEW_TAB: &str = "shax:menu-new-tab";
pub const EVENT_MENU_CLOSE_TAB: &str = "shax:menu-close-tab";
pub const EVENT_MENU_PREFERENCES: &str = "shax:menu-open-preferences";

// ─── Menu construction ─────────────────────────────────────────────

/// Build the macOS app menu. Returns `None` on other platforms — the
/// caller then skips `set_menu`.
///
/// Uses `PredefinedMenuItem::*` for standard items (Hide, Quit, Cut,
/// Copy, Paste, etc.) so Tauri picks up the correct localized labels
/// and default accelerators. Custom items get explicit accelerators
/// via `MenuItem::with_id`. All ids match the `MENU_ID_*` constants
/// above.
#[cfg(target_os = "macos")]
pub fn build_app_menu<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<Option<tauri::menu::Menu<R>>> {
    use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};

    let preferences = MenuItem::with_id(
        app,
        MENU_ID_PREFERENCES,
        "Preferences…",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    let shax_menu = SubmenuBuilder::new(app, "Shax")
        .about(None)
        .item(&preferences)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_window = MenuItem::with_id(
        app,
        MENU_ID_NEW_WINDOW,
        "New Window",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let new_tab = MenuItem::with_id(app, MENU_ID_NEW_TAB, "New Tab", true, Some("CmdOrCtrl+T"))?;
    let close_tab = MenuItem::with_id(
        app,
        MENU_ID_CLOSE_TAB,
        "Close Tab",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let close_window = MenuItem::with_id(
        app,
        MENU_ID_CLOSE_WINDOW,
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .item(&new_tab)
        .separator()
        .item(&close_tab)
        .item(&close_window)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&shax_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;

    Ok(Some(menu))
}

/// Non-macOS builds skip the menu entirely — the app renders its own
/// title-bar chrome and keyboard bindings via the frontend, and a
/// webview-embedded menu would just get in the way.
#[cfg(not(target_os = "macos"))]
pub fn build_app_menu<R: tauri::Runtime>(
    _app: &AppHandle<R>,
) -> tauri::Result<Option<tauri::menu::Menu<R>>> {
    Ok(None)
}

// ─── Menu event dispatch ───────────────────────────────────────────

/// Handle a menu item activation. Called from the closure passed to
/// `AppHandle::on_menu_event`. Backend-owned actions run inline;
/// frontend-owned actions emit a `shax:menu-*` custom event to the
/// currently-focused window and return.
pub fn handle_menu_event<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        MENU_ID_NEW_WINDOW => {
            if let Err(e) = spawn_new_window(app) {
                tracing::warn!("menu: spawn_new_window failed: {e}");
            }
        }
        MENU_ID_CLOSE_WINDOW => {
            if let Some(window) = focused_webview_window(app) {
                if let Err(e) = window.close() {
                    tracing::warn!("menu: close focused window failed: {e}");
                }
            }
        }
        MENU_ID_NEW_TAB => emit_to_focused(app, EVENT_MENU_NEW_TAB),
        MENU_ID_CLOSE_TAB => emit_to_focused(app, EVENT_MENU_CLOSE_TAB),
        MENU_ID_PREFERENCES => emit_to_focused(app, EVENT_MENU_PREFERENCES),
        // Predefined menu items (Quit, About, Hide, Undo, ...) don't
        // reach this handler — Tauri wires them to their native
        // actions. Anything else falling here is a menu item we
        // shipped without a dispatch arm.
        other => tracing::warn!("menu: unhandled menu id {other}"),
    }
}

fn emit_to_focused<R: tauri::Runtime>(app: &AppHandle<R>, event: &str) {
    let Some(window) = focused_webview_window(app) else {
        // No focused window is a legitimate state on macOS when the
        // menu is triggered with no visible windows. Silently drop —
        // there's nothing to dispatch to.
        return;
    };
    if let Err(e) = window.emit(event, ()) {
        tracing::warn!("menu: emit {event} failed: {e}");
    }
}

/// The `WebviewWindow` currently owning focus, if any. Tauri's
/// `get_focused_window()` returns the underlying `Window`; we need
/// the wrapping `WebviewWindow` because `emit` is defined there.
/// Iterate the small (N ≤ handful) set of live windows and pick the
/// focused one.
fn focused_webview_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Option<tauri::WebviewWindow<R>> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
}

// ─── Window spawn helper ───────────────────────────────────────────

/// Spawn a fresh Shax window and register its close-teardown hook.
/// Returns the new `WindowId` (also usable as a Tauri window label).
///
/// Sync entry point shared between the `open_new_window` IPC command
/// (called from the frontend palette / `⌘N` binding) and the
/// `RunEvent::Reopen` handler for macOS dock-icon clicks.
pub fn spawn_new_window<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<WindowId> {
    let label = format!("w-{}", Uuid::new_v4().simple());
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Shax")
        .inner_size(800.0, 600.0);
    // See `open_new_window` doc: `title_bar_style` and
    // `hidden_title` are macOS-only methods on the builder.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build()?;
    register_close_teardown(app, &window);
    Ok(WindowId::from_label(&label))
}

/// Hook a window's `CloseRequested` event to reap any PTYs the window
/// owned. Called once per spawned window (in `spawn_new_window`) and
/// once for the main window (from `.setup(...)` in `lib.rs`).
///
/// Public so `lib.rs` can wire the main window during setup — every
/// other window goes through `spawn_new_window` which calls it
/// internally.
pub fn register_close_teardown<R: tauri::Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) {
    let label = window.label().to_string();
    let handle = app.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::CloseRequested { .. }) {
            return;
        }
        let window_id = WindowId::from_label(&label);
        let Some(windows) = handle.try_state::<Arc<Windows>>() else {
            return;
        };
        let Some(manager) = handle.try_state::<Arc<PtyManager>>() else {
            return;
        };
        // Snapshot the PTYs owned by this window, then drop each one
        // from the registry and kill the child. `block_on` is OK here
        // — the closure runs on a Tauri thread that isn't the tokio
        // runtime worker, and the window is going away anyway so a
        // brief block is fine.
        let ptys = tauri::async_runtime::block_on(windows.ptys_of(&window_id));
        if ptys.is_empty() {
            return;
        }
        tracing::info!(
            "window {} closing; reaping {} owned PTY{}",
            label,
            ptys.len(),
            if ptys.len() == 1 { "" } else { "s" },
        );
        for pty in ptys {
            tauri::async_runtime::block_on(windows.unregister_pty(&pty));
            let manager = Arc::clone(&manager);
            tauri::async_runtime::spawn(async move {
                if let Err(e) = manager.kill(pty).await {
                    tracing::warn!("window-close: kill pty {pty} failed: {e}");
                }
            });
        }
    });
}

// ─── Lifecycle helpers ─────────────────────────────────────────────

/// Whether a `RunEvent::ExitRequested` should be prevented so the
/// process stays alive.
///
/// The rule (macOS): `code: None` means "the runtime decided to exit"
/// — typically the last window just closed. Prevent it. `code:
/// Some(_)` means `app.exit(n)` was called explicitly (Quit menu or
/// `⌘Q`); let it proceed.
///
/// On other platforms this is always `false` — Windows and Linux quit
/// on last-window-close by convention.
pub fn should_prevent_exit(code: Option<i32>) -> bool {
    #[cfg(target_os = "macos")]
    {
        code.is_none()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = code;
        false
    }
}

// ─── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards against a menu id string being renamed in one place
    /// and not the other. The test can't spin up a Tauri app, but it
    /// can pin the exact strings we ship as ids and events.
    #[test]
    fn menu_ids_are_stable() {
        assert_eq!(MENU_ID_NEW_WINDOW, "menu.file.new-window");
        assert_eq!(MENU_ID_NEW_TAB, "menu.file.new-tab");
        assert_eq!(MENU_ID_CLOSE_TAB, "menu.file.close-tab");
        assert_eq!(MENU_ID_CLOSE_WINDOW, "menu.file.close-window");
        assert_eq!(MENU_ID_PREFERENCES, "menu.shax.preferences");
    }

    #[test]
    fn frontend_event_names_are_stable() {
        // Match what App.tsx listens for. If either side renames,
        // the CI on the other catches it.
        assert_eq!(EVENT_MENU_NEW_TAB, "shax:menu-new-tab");
        assert_eq!(EVENT_MENU_CLOSE_TAB, "shax:menu-close-tab");
        assert_eq!(EVENT_MENU_PREFERENCES, "shax:menu-open-preferences");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_prevents_exit_only_when_runtime_triggered() {
        // code: None → last window closed / runtime decision
        //           → prevent exit so the process stays alive.
        assert!(should_prevent_exit(None));
        // code: Some(_) → explicit app.exit() (Quit menu, Cmd+Q)
        //              → let it proceed.
        assert!(!should_prevent_exit(Some(0)));
        assert!(!should_prevent_exit(Some(1)));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn non_macos_always_allows_exit() {
        assert!(!should_prevent_exit(None));
        assert!(!should_prevent_exit(Some(0)));
    }
}
