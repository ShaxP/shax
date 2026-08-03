//! Native multiplexing.
//!
//! Today this module owns the multi-window registry (M9.1). The tab and
//! split-layout tree stay in frontend React state — the backend only needs
//! to know which OS window is talking to it so per-window state
//! (session-restore records, chat conversations, PTY ownership) doesn't
//! collapse onto a single implicit "the app" scope.
//!
//! Grows over M9.2-9.5 into the full multi-window lifecycle (session
//! restore for N windows, per-OS quit rules, cross-window PTY teardown).
//! Everything here is `pub(crate)` where possible so the surface stays
//! small until we actually need to widen it.
//!
//! See `specs/15-multi-window.md`.
//!
//! Design notes:
//!
//! - `WindowId` wraps the Tauri window label — a stable string chosen
//!   when the `WebviewWindow` is created. For today's static single
//!   window it's always `"main"` (from `tauri.conf.json`). Once M9.3
//!   spawns windows dynamically, labels will be generated per-window
//!   at spawn time (probably `"w-<uuid>"`) so they survive restart.
//! - The registry is a `tokio::sync::Mutex` because IPC command
//!   handlers are `async`. Contention is negligible — one lock per
//!   command call, no long-held guards.
//! - Windows are registered lazily via `touch()` on the first command
//!   invocation that references them. No explicit "hello" step from
//!   the frontend at boot.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Mutex;

use crate::pty::PtyId;

/// Identifier of an OS-level Tauri window. Backed by the window label.
///
/// Newtype rather than a bare `String` so the compiler catches
/// accidental "pass any string" bugs during the multi-window rollout.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct WindowId(pub String);

impl WindowId {
    /// Construct from a Tauri window label. The label is expected to
    /// be non-empty; `tauri.conf.json` guarantees this for static
    /// windows and `WebviewWindowBuilder::label()` requires it for
    /// dynamic ones.
    pub fn from_label(label: &str) -> Self {
        Self(label.to_string())
    }

    /// The label backing this `WindowId`. Useful when handing the
    /// value back to Tauri APIs (e.g. `AppHandle::get_webview_window`).
    pub fn label(&self) -> &str {
        &self.0
    }
}

impl From<&str> for WindowId {
    fn from(s: &str) -> Self {
        Self::from_label(s)
    }
}

impl From<String> for WindowId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl std::fmt::Display for WindowId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Per-window mutable state tracked by the backend. Kept intentionally
/// small: today it's just the set of PTYs the window owns, so a future
/// window-close handler (M9.4) can reap them without iterating every
/// live PTY across the app.
#[derive(Debug, Default)]
pub struct WindowState {
    /// PTYs (panes) owned by this window. Populated on `pty_spawn`,
    /// consulted on window-close teardown (M9.4).
    ptys: HashSet<PtyId>,
    /// M9.6 close-confirmation bypass. Set to `true` by
    /// `close_window_confirmed` (frontend has already shown the
    /// warning modal and the user clicked "Close anyway"). The
    /// window-close intercept in `menu::register_close_teardown`
    /// consumes the flag on entry — if set, it skips the
    /// running-command check and proceeds straight to teardown;
    /// if not set, it runs the check and may prevent the close.
    close_confirmed: AtomicBool,
}

impl WindowState {
    /// The PTYs currently owned by this window. Read-only snapshot.
    #[allow(dead_code)] // consumed by M9.4 window-close teardown
    pub fn ptys(&self) -> impl Iterator<Item = &PtyId> {
        self.ptys.iter()
    }
}

/// Registry of every live window the backend knows about. Managed as a
/// `tauri::State` singleton alongside `PtyManager`.
#[derive(Debug, Default)]
pub struct Windows {
    inner: Mutex<HashMap<WindowId, WindowState>>,
    /// M9.6 app-wide quit-confirmation bypass. Set by the
    /// `quit_confirmed` IPC command after the frontend's warning
    /// modal has been dismissed via "Quit anyway". The
    /// `RunEvent::ExitRequested` handler consumes the flag on
    /// entry (see `Windows::consume_quit_confirmed`). Atomic so
    /// the lifecycle handler doesn't need to acquire the
    /// registry lock.
    quit_confirmed: AtomicBool,
}

impl Windows {
    /// Ensure a `WindowState` exists for `window_id`, creating it if
    /// necessary. Idempotent — safe to call on every command entry.
    pub async fn touch(&self, window_id: &WindowId) {
        let mut guard = self.inner.lock().await;
        guard.entry(window_id.clone()).or_default();
    }

    /// Record that `pty_id` belongs to `window_id`. Called from
    /// `pty_spawn`. Creates the window entry if it doesn't already
    /// exist (spawn is often the first thing a fresh window does).
    pub async fn register_pty(&self, window_id: &WindowId, pty_id: PtyId) {
        let mut guard = self.inner.lock().await;
        guard
            .entry(window_id.clone())
            .or_default()
            .ptys
            .insert(pty_id);
    }

    /// Remove `pty_id` from whichever window owned it, if any. Called
    /// from `menu::register_close_teardown` when a window closes
    /// (M9.4). Returns the owning `WindowId` so callers can log or
    /// assert if useful.
    pub async fn unregister_pty(&self, pty_id: &PtyId) -> Option<WindowId> {
        let mut guard = self.inner.lock().await;
        for (window_id, state) in guard.iter_mut() {
            if state.ptys.remove(pty_id) {
                return Some(window_id.clone());
            }
        }
        None
    }

    /// The number of windows currently registered. Test / diagnostics
    /// use only; production code should not branch on this.
    #[allow(dead_code)] // diagnostics + tests only
    pub async fn window_count(&self) -> usize {
        self.inner.lock().await.len()
    }

    /// Snapshot the PTYs owned by `window_id`. Returns an empty vec
    /// if the window isn't registered — callers treat "unknown
    /// window" as "no PTYs to reap". Consumed by
    /// `menu::register_close_teardown` when a window closes (M9.4).
    pub async fn ptys_of(&self, window_id: &WindowId) -> Vec<PtyId> {
        self.inner
            .lock()
            .await
            .get(window_id)
            .map(|s| s.ptys.iter().copied().collect())
            .unwrap_or_default()
    }

    /// The window that owns `pty_id`, or `None` if no window owns it.
    /// Used by PTY-touching IPC commands to enforce that a window
    /// only mutates PTYs it spawned itself. Today N=1 always, so
    /// this always returns `Some(main)` for live PTYs — the check
    /// is belt-and-suspenders for once M9.3+ spawns real second
    /// windows.
    #[allow(dead_code)] // consumed by M9.3+ cross-window enforcement
    pub async fn owner_of(&self, pty_id: &PtyId) -> Option<WindowId> {
        let guard = self.inner.lock().await;
        for (window_id, state) in guard.iter() {
            if state.ptys.contains(pty_id) {
                return Some(window_id.clone());
            }
        }
        None
    }

    /// M9.6: mark a window's next close as confirmed. Called by
    /// `close_window_confirmed` before it re-triggers the close.
    /// The window's `on_window_event` intercept sees the flag on
    /// the following `CloseRequested` and skips its running-
    /// command check.
    pub async fn set_close_confirmed(&self, window_id: &WindowId) {
        let mut guard = self.inner.lock().await;
        guard
            .entry(window_id.clone())
            .or_default()
            .close_confirmed
            .store(true, Ordering::SeqCst);
    }

    /// Consume the close-confirmed flag on `window_id`, returning
    /// its prior value. Called from the close intercept on entry.
    /// Returns `false` if the window isn't in the registry.
    pub async fn consume_close_confirmed(&self, window_id: &WindowId) -> bool {
        let guard = self.inner.lock().await;
        guard
            .get(window_id)
            .map(|state| state.close_confirmed.swap(false, Ordering::SeqCst))
            .unwrap_or(false)
    }

    /// M9.6: mark the app's next `ExitRequested` as confirmed.
    /// Called by `quit_confirmed` before `app.exit(0)` runs.
    pub fn set_quit_confirmed(&self) {
        self.quit_confirmed.store(true, Ordering::SeqCst);
    }

    /// Consume the quit-confirmed flag, returning its prior value.
    /// The lifecycle handler in `lib.rs` calls this on every
    /// `ExitRequested`; if `true`, it skips the warning check and
    /// lets the exit proceed.
    pub fn consume_quit_confirmed(&self) -> bool {
        self.quit_confirmed.swap(false, Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_id_from_str_roundtrips_via_label() {
        let id = WindowId::from("main");
        assert_eq!(id.label(), "main");
        assert_eq!(id.to_string(), "main");
    }

    #[test]
    fn window_id_serializes_transparently_as_string() {
        let id = WindowId::from("w-abc");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"w-abc\"");
        let round: WindowId = serde_json::from_str(&json).unwrap();
        assert_eq!(round, id);
    }

    #[test]
    fn window_id_equality_and_hashing() {
        let a = WindowId::from("main");
        let b = WindowId::from("main");
        let c = WindowId::from("other");
        assert_eq!(a, b);
        assert_ne!(a, c);
        // Verify hash equivalence by using as a HashMap key.
        let mut map: HashMap<WindowId, i32> = HashMap::new();
        map.insert(a.clone(), 1);
        assert_eq!(map.get(&b), Some(&1));
        assert_eq!(map.get(&c), None);
    }

    #[tokio::test]
    async fn touch_is_idempotent() {
        let windows = Windows::default();
        let id = WindowId::from("main");
        windows.touch(&id).await;
        windows.touch(&id).await;
        windows.touch(&id).await;
        assert_eq!(windows.window_count().await, 1);
        assert!(windows.ptys_of(&id).await.is_empty());
    }

    #[tokio::test]
    async fn register_pty_creates_window_if_missing() {
        let windows = Windows::default();
        let id = WindowId::from("main");
        let pty = PtyId::new();
        windows.register_pty(&id, pty).await;
        assert_eq!(windows.window_count().await, 1);
        assert_eq!(windows.ptys_of(&id).await, vec![pty]);
    }

    #[tokio::test]
    async fn register_pty_two_windows_stay_isolated() {
        let windows = Windows::default();
        let a = WindowId::from("main");
        let b = WindowId::from("second");
        let pty_a = PtyId::new();
        let pty_b = PtyId::new();
        windows.register_pty(&a, pty_a).await;
        windows.register_pty(&b, pty_b).await;
        assert_eq!(windows.window_count().await, 2);
        assert_eq!(windows.ptys_of(&a).await, vec![pty_a]);
        assert_eq!(windows.ptys_of(&b).await, vec![pty_b]);
    }

    #[tokio::test]
    async fn unregister_pty_returns_owner_window() {
        let windows = Windows::default();
        let id = WindowId::from("main");
        let pty = PtyId::new();
        windows.register_pty(&id, pty).await;
        assert_eq!(windows.unregister_pty(&pty).await, Some(id.clone()));
        assert!(windows.ptys_of(&id).await.is_empty());
        // A second unregister is a no-op and reports no owner.
        assert_eq!(windows.unregister_pty(&pty).await, None);
    }

    #[tokio::test]
    async fn ptys_of_unknown_window_returns_empty() {
        let windows = Windows::default();
        assert!(windows.ptys_of(&WindowId::from("ghost")).await.is_empty());
    }

    #[tokio::test]
    async fn owner_of_returns_the_registering_window() {
        let windows = Windows::default();
        let main = WindowId::from("main");
        let other = WindowId::from("other");
        let pty_a = PtyId::new();
        let pty_b = PtyId::new();
        windows.register_pty(&main, pty_a).await;
        windows.register_pty(&other, pty_b).await;
        assert_eq!(windows.owner_of(&pty_a).await, Some(main));
        assert_eq!(windows.owner_of(&pty_b).await, Some(other));
    }

    #[tokio::test]
    async fn owner_of_unknown_pty_is_none() {
        let windows = Windows::default();
        let pty = PtyId::new();
        assert_eq!(windows.owner_of(&pty).await, None);
    }

    #[tokio::test]
    async fn owner_of_none_after_unregister() {
        let windows = Windows::default();
        let main = WindowId::from("main");
        let pty = PtyId::new();
        windows.register_pty(&main, pty).await;
        windows.unregister_pty(&pty).await;
        assert_eq!(windows.owner_of(&pty).await, None);
    }
}
