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
use crate::pty::{PtyId, PtyManager};

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
/// Custom Quit item id. We use our own instead of
/// `PredefinedMenuItem::quit` because the predefined version calls
/// `NSApplication::terminate:` directly on macOS — that path bypasses
/// Tauri's `RunEvent::ExitRequested` entirely, so a listener there
/// cannot intercept ⌘Q. Owning the menu item lets us run the M9.6
/// running-command check before requesting the exit.
pub const MENU_ID_QUIT: &str = "menu.shax.quit";

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

    // Custom Quit item so `MENU_ID_QUIT` routes through
    // `handle_menu_event` where the M9.6 running-command check
    // lives — see the constant's doc for why we don't use
    // `PredefinedMenuItem::quit`.
    let quit = MenuItem::with_id(app, MENU_ID_QUIT, "Quit Shax", true, Some("CmdOrCtrl+Q"))?;

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
        .item(&quit)
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
        MENU_ID_QUIT => handle_quit_request(app),
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

/// Handle the custom Quit menu item (macOS Shax > Quit Shax / ⌘Q).
///
/// M9.6: if any pane holds a running non-alt-screen command, prevent
/// the exit and ask the focused window to show the confirmation modal.
/// Otherwise (or when the frontend has already set the "confirmed"
/// bypass flag via `quit_confirmed()`), request the exit through
/// `app.exit(0)` — which fires `RunEvent::ExitRequested` normally, so
/// the `Exit` handler in `lib.rs` still runs `shutdown_all` on the way
/// out.
fn handle_quit_request<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(windows) = app.try_state::<Arc<Windows>>() {
        if windows.consume_quit_confirmed() {
            app.exit(0);
            return;
        }
        let Some(manager) = app.try_state::<Arc<PtyManager>>() else {
            app.exit(0);
            return;
        };
        let running = tauri::async_runtime::block_on(manager.running_command_pane_ids());
        if !running.is_empty() {
            let target_label = app
                .webview_windows()
                .into_iter()
                .find(|(_, w)| w.is_focused().unwrap_or(false))
                .or_else(|| app.webview_windows().into_iter().next())
                .map(|(label, _)| label);
            if let Some(label) = target_label {
                if let Err(e) = app.emit_to(
                    tauri::EventTarget::WebviewWindow { label },
                    "shax:confirm-quit",
                    serde_json::json!({ "count": running.len() }),
                ) {
                    tracing::warn!("quit-menu: emit failed: {e}");
                }
            }
            return;
        }
    }
    app.exit(0);
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

/// Spawn a fresh Shax window with a newly-generated `w-<uuid>`
/// label. Thin wrapper over `spawn_window_with_label` — the label
/// generator lives here so callers that don't care about the
/// specific label (⌘N, palette entry, dock-icon fresh spawn) don't
/// have to think about it.
pub fn spawn_new_window<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<WindowId> {
    let label = format!("w-{}", Uuid::new_v4().simple());
    spawn_window_with_label(app, &label)
}

/// Spawn a Shax window with an explicit label. Used by session
/// restore (M9.5) to spawn each window with its previously-used
/// label so the `tauri-plugin-window-state` plugin's per-label
/// bounds cache restores the correct size + position, and so the
/// M9.1 per-window `window_state` blob hydrates the correct tabs.
///
/// Every window path funnels through here: register close-teardown
/// (so PTY reap works for spawned + restored windows alike) and
/// save the updated session-window list (M9.5) so a fresh spawn
/// or restore is captured immediately, not just at graceful quit.
pub fn spawn_window_with_label<R: tauri::Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> tauri::Result<WindowId> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
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
    save_session_windows(app);
    Ok(WindowId::from_label(label))
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
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        let window_id = WindowId::from_label(&label);
        let Some(windows) = handle.try_state::<Arc<Windows>>() else {
            return;
        };
        let Some(manager) = handle.try_state::<Arc<PtyManager>>() else {
            return;
        };

        // M9.6 pre-teardown intercept. Consume the confirmation
        // flag first — if the frontend already showed the warning
        // and the user clicked "Close anyway", the flag is set
        // and we fall through to the standard teardown below.
        // Otherwise, check whether any PTY the window owns has a
        // running non-alt-screen command. If yes, prevent the
        // close, tell the frontend to show its modal, and return.
        let confirmed = tauri::async_runtime::block_on(windows.consume_close_confirmed(&window_id));
        if !confirmed {
            let owned: std::collections::HashSet<PtyId> =
                tauri::async_runtime::block_on(windows.ptys_of(&window_id))
                    .into_iter()
                    .collect();
            let running = tauri::async_runtime::block_on(manager.running_command_pane_ids());
            let running_here_count = running.iter().filter(|p| owned.contains(p)).count();
            if running_here_count > 0 {
                api.prevent_close();
                // On non-macOS platforms, closing the last window IS
                // the app quit — the process exits after this window
                // is gone. Route through the "app" verb path so the
                // modal reads "Quit anyway?" instead of the
                // confusing "Close window anyway?" (which technically
                // IS what's happening but understates the
                // consequence). On macOS the app stays alive after
                // last-window-close (M9.4) so this stays a window
                // scope.
                let is_last_window_on_platform_that_quits = {
                    #[cfg(target_os = "macos")]
                    {
                        false
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        handle.webview_windows().len() <= 1
                    }
                };
                let (event_name, payload_extra): (&str, serde_json::Value) =
                    if is_last_window_on_platform_that_quits {
                        (
                            "shax:confirm-quit",
                            serde_json::json!({ "count": running_here_count }),
                        )
                    } else {
                        (
                            "shax:confirm-close-window",
                            serde_json::json!({ "count": running_here_count }),
                        )
                    };
                // Target THIS window only. `WebviewWindow::emit` in
                // Tauri 2 broadcasts to every listener across every
                // window; without `emit_to(..., WebviewWindow{label})`
                // the confirmation modal opens in every open window
                // instead of just the one being closed.
                if let Err(e) = handle.emit_to(
                    tauri::EventTarget::WebviewWindow {
                        label: label.clone(),
                    },
                    event_name,
                    payload_extra,
                ) {
                    tracing::warn!("close-intercept: emit failed: {e}");
                }
                return;
            }
        }

        // Snapshot the PTYs owned by this window, then kill each
        // child. `PtyManager::kill` also unregisters from `windows`
        // internally, so no separate `unregister_pty` call is
        // needed here. `block_on` is OK — the closure runs on a
        // Tauri thread that isn't the tokio runtime worker, and
        // the window is going away anyway.
        //
        // A PTY that already exited between snapshot and kill
        // returns `PtyError::UnknownId`; that's expected under
        // that race and logged at debug level, not warn.
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
            let manager = Arc::clone(&manager);
            tauri::async_runtime::spawn(async move {
                if let Err(e) = manager.kill(pty).await {
                    tracing::debug!("window-close: kill pty {pty} failed: {e}");
                }
            });
        }
        // Intentional: no session save on individual window close
        // (M9.5, Safari-style restore). The session is only
        // updated on spawn and on graceful Exit — closing a
        // window individually leaves the session state alone so
        // that a subsequent macOS dock-reopen (or the next
        // launch) restores the last-quit set. See M9.5 PR body
        // for the rationale.
        let _ = &label; // captured only for the tracing above
    });
}

// ─── Session restore (M9.5) ────────────────────────────────────────

/// Persist the labels of every currently-open window so the next
/// launch (or macOS dock-reopen) can spawn the same set.
///
/// Called from two places (M9.5, Safari-style restore):
/// 1. Immediately after every successful spawn, so newly-created
///    windows join the persisted set.
/// 2. From `RunEvent::Exit`, so a graceful quit commits the
///    final open-window snapshot as the "restore target."
///
/// NOT called from `WindowEvent::CloseRequested`. Individual
/// window closes intentionally leave the session unchanged so
/// that dock-reopen (macOS) or the next launch can restore the
/// full last-quit set. If the user wanted a window gone
/// permanently, they close it and then quit — Exit captures the
/// new (smaller) set.
///
/// Best-effort: swallows and logs any error rather than
/// propagating, because we never want a persistence hiccup to
/// interfere with window management.
pub fn save_session_windows<R: tauri::Runtime>(app: &AppHandle<R>) {
    let labels: Vec<String> = app.webview_windows().into_keys().collect();
    persist_session_labels(app, labels);
}

fn persist_session_labels<R: tauri::Runtime>(app: &AppHandle<R>, labels: Vec<String>) {
    let Some(manager) = app.try_state::<Arc<PtyManager>>() else {
        return;
    };
    let Some(store) = manager.store() else {
        return;
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Err(e) = store.save_session_labels(&labels, now_ms) {
        tracing::warn!("session save failed: {e}");
    }
}

/// Read the saved session-window list and spawn any labels that
/// aren't already open. Called from `.setup(...)` at boot (after
/// the static "main" window is up) and from `RunEvent::Reopen` on
/// macOS when the user clicks the dock icon with no visible
/// windows. On both paths the "main" window may already exist —
/// the filter below skips it rather than trying to re-spawn.
///
/// If nothing was saved (fresh install, or the file was cleared),
/// returns without side effects. Callers that need a fallback
/// "spawn one fresh window" behaviour do so themselves after
/// checking `app.webview_windows()` post-restore.
pub fn restore_session_windows<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(manager) = app.try_state::<Arc<PtyManager>>() else {
        return;
    };
    let Some(store) = manager.store() else {
        return;
    };
    let labels = match store.load_session_labels() {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!("session restore: load_session_labels failed: {e}");
            return;
        }
    };
    if labels.is_empty() {
        return;
    }
    let existing: std::collections::HashSet<String> = app.webview_windows().into_keys().collect();
    let mut restored = 0usize;
    for label in labels {
        if existing.contains(&label) {
            continue;
        }
        match spawn_window_with_label(app, &label) {
            Ok(_) => restored += 1,
            Err(e) => tracing::warn!("session restore: spawn {label} failed: {e}"),
        }
    }
    if restored > 0 {
        tracing::info!("session restore: spawned {restored} window(s)");
    }
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
        assert_eq!(MENU_ID_QUIT, "menu.shax.quit");
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
