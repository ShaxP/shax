//! Chat history persistence — one JSON file per window.
//!
//! Slice-4's chat overlay was in-memory only: closing the
//! overlay or restarting the app lost the conversation. This
//! module persists a small transcript so users can pick up
//! where they left off.
//!
//! Scope for the MVP:
//!   - **One conversation per window** (M9.1). Each window
//!     has its own independent transcript on disk, keyed by
//!     the Tauri window label (`crate::mux::WindowId`). No
//!     named sessions inside a window, no sidebar — the
//!     "New" button in the header clears the current
//!     window's history.
//!   - **Capped at `MAX_TURNS` entries** — the file stays
//!     small and load is cheap. Older turns fall off the
//!     front when the cap is exceeded.
//!   - **Same platform config dir** as `assistant.json`:
//!     `~/Library/Application Support/shax` on macOS,
//!     `%APPDATA%/shax` on Windows,
//!     `$XDG_CONFIG_HOME/shax` on Linux. Windowed layout:
//!     `<config>/shax/chat-history/<window_id>.json`.
//!   - **Atomic writes** — write to a sibling tempfile then
//!     rename. Prevents partial writes if the app crashes
//!     mid-save.
//!   - **Legacy-file migration** — the pre-M9.1 build wrote
//!     a single `<config>/shax/chat-history.json`. On first
//!     use we rename it into place as `main.json` so users
//!     don't lose their existing conversation. Idempotent
//!     and lazy — every path resolution checks in case a
//!     downgrade-then-upgrade left the legacy file behind.
//!
//! Errors from the persistence layer never bubble up to the
//! chat UI as a fatal error — a corrupt or unreadable file
//! resets to an empty history so the overlay stays usable.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;

use super::config::platform_config_dir;

/// Upper bound on stored turns. Keeps the JSON file small
/// (a few dozen KB at most) and load / save both cheap.
/// Older turns fall off the front on overflow.
pub const MAX_TURNS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatHistory {
    /// Ordered oldest → newest. Renderer converts to bubbles.
    #[serde(default)]
    pub turns: Vec<ChatTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurn {
    /// `"user"` | `"assistant"` | `"error"`. String rather
    /// than enum to keep old files loadable when new roles
    /// arrive.
    pub role: String,
    pub content: String,
    /// Unix-epoch milliseconds. Displayed as a hover on the
    /// bubble — not used for ordering (that's array order).
    #[serde(default)]
    pub created_ms: i64,
}

#[derive(Debug, Error)]
pub enum HistoryError {
    #[error("no config directory available")]
    NoConfigDir,
    #[error("io: {0}")]
    Io(String),
    #[error("json: {0}")]
    Json(String),
}

impl From<std::io::Error> for HistoryError {
    fn from(e: std::io::Error) -> Self {
        HistoryError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for HistoryError {
    fn from(e: serde_json::Error) -> Self {
        HistoryError::Json(e.to_string())
    }
}

/// Resolve the on-disk history file for `window_id`, migrating
/// the legacy single-file layout into place as `main.json` on
/// first call after the upgrade. Idempotent.
fn history_path(window_id: &str) -> Result<PathBuf, HistoryError> {
    let base = platform_config_dir().ok_or(HistoryError::NoConfigDir)?;
    let shax_dir = base.join("shax");
    let new_dir = shax_dir.join("chat-history");
    migrate_legacy_if_needed(&shax_dir, &new_dir)?;
    Ok(new_dir.join(format!("{}.json", sanitize_filename(window_id))))
}

/// If the pre-M9.1 single-file history exists and the new
/// per-window file for `main` doesn't, move the file into
/// place. Anything else is a no-op — running an old build
/// after this migration would just write a fresh
/// `chat-history.json` next to the new directory, and the
/// next new-build run would migrate that too.
fn migrate_legacy_if_needed(
    shax_dir: &std::path::Path,
    new_dir: &std::path::Path,
) -> Result<(), HistoryError> {
    let legacy = shax_dir.join("chat-history.json");
    let main_path = new_dir.join("main.json");
    if legacy.exists() && !main_path.exists() {
        std::fs::create_dir_all(new_dir)?;
        std::fs::rename(&legacy, &main_path)?;
    }
    Ok(())
}

/// Constrain a window label to characters safe inside a
/// filename on every supported platform. Tauri already
/// requires alphanumeric labels, so this is defence in
/// depth — any unexpected character maps to `_` rather
/// than reaching the filesystem.
fn sanitize_filename(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Load persisted turns for `window_id`. Missing file →
/// empty. Malformed file → empty (with a warn log) so a
/// hand-edit slip doesn't break the overlay.
pub fn load(window_id: &str) -> Result<ChatHistory, HistoryError> {
    let path = history_path(window_id)?;
    if !path.exists() {
        return Ok(ChatHistory::default());
    }
    let text = std::fs::read_to_string(&path)?;
    match serde_json::from_str::<ChatHistory>(&text) {
        Ok(mut history) => {
            // Enforce cap even if a hand-edited file exceeded
            // it. Keeps the invariant simple everywhere else.
            if history.turns.len() > MAX_TURNS {
                let drop = history.turns.len() - MAX_TURNS;
                history.turns.drain(..drop);
            }
            Ok(history)
        }
        Err(e) => {
            tracing::warn!(
                "chat history for window {window_id} parse failed, falling back to empty: {e}"
            );
            Ok(ChatHistory::default())
        }
    }
}

/// Overwrite the file for `window_id`. Trims to `MAX_TURNS`
/// from the front so callers don't have to think about the
/// cap. Empty history → we still write the file (an
/// explicit clear is meaningful; deleting the file leaves
/// ambiguous state).
pub fn save(window_id: &str, mut history: ChatHistory) -> Result<(), HistoryError> {
    let path = history_path(window_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if history.turns.len() > MAX_TURNS {
        let drop = history.turns.len() - MAX_TURNS;
        history.turns.drain(..drop);
    }
    let json = serde_json::to_string_pretty(&history)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Delete the on-disk history for `window_id`. Used by the
/// "New" button in the overlay header. A missing file is
/// not an error — idempotent.
pub fn clear(window_id: &str) -> Result<(), HistoryError> {
    let path = history_path(window_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_enforced_on_load() {
        let mut turns = vec![];
        for i in 0..(MAX_TURNS + 5) {
            turns.push(ChatTurn {
                role: "user".into(),
                content: format!("turn {i}"),
                created_ms: i as i64,
            });
        }
        let history = ChatHistory { turns };
        // Simulate the truncate-on-load path directly, since
        // `load()` reads from disk.
        let mut copy = history.clone();
        if copy.turns.len() > MAX_TURNS {
            let drop = copy.turns.len() - MAX_TURNS;
            copy.turns.drain(..drop);
        }
        assert_eq!(copy.turns.len(), MAX_TURNS);
        // Oldest kept turn is the (5+1)th of the input:
        // indices 0..5 were dropped, so first surviving is
        // "turn 5".
        assert_eq!(copy.turns[0].content, "turn 5");
    }

    #[test]
    fn empty_history_default() {
        let h = ChatHistory::default();
        assert!(h.turns.is_empty());
    }

    #[test]
    fn deserialises_missing_created_ms_as_zero() {
        let json = r#"{"turns":[{"role":"user","content":"hi"}]}"#;
        let h: ChatHistory = serde_json::from_str(json).unwrap();
        assert_eq!(h.turns.len(), 1);
        assert_eq!(h.turns[0].created_ms, 0);
    }

    #[test]
    fn deserialises_unknown_role_string() {
        let json = r#"{"turns":[{"role":"future_role","content":"?"}]}"#;
        let h: ChatHistory = serde_json::from_str(json).unwrap();
        assert_eq!(h.turns[0].role, "future_role");
    }

    #[test]
    fn sanitize_filename_replaces_unsafe_chars() {
        // Alphanumeric, dash, underscore pass through.
        assert_eq!(sanitize_filename("main"), "main");
        assert_eq!(sanitize_filename("w-abc_123"), "w-abc_123");
        // Everything else becomes '_'.
        assert_eq!(sanitize_filename("../etc"), "___etc");
        assert_eq!(sanitize_filename("hello world"), "hello_world");
        assert_eq!(sanitize_filename("emoji_🚀"), "emoji__");
    }

    #[test]
    fn legacy_single_file_migrates_to_main_json() {
        // Point platform_config_dir at a fresh tempdir via a
        // per-test env var (config::platform_config_dir consults
        // XDG_CONFIG_HOME on Linux, HOME elsewhere). Since we
        // can't rely on any specific override, exercise the
        // migration helper directly — it's the load-bearing
        // piece and doesn't need the config-dir shim.
        let tmp = tempfile::tempdir().unwrap();
        let shax_dir = tmp.path().join("shax");
        let new_dir = shax_dir.join("chat-history");
        std::fs::create_dir_all(&shax_dir).unwrap();
        std::fs::write(
            shax_dir.join("chat-history.json"),
            r#"{"turns":[{"role":"user","content":"legacy"}]}"#,
        )
        .unwrap();

        migrate_legacy_if_needed(&shax_dir, &new_dir).unwrap();

        // Legacy file is gone; main.json exists with the same content.
        assert!(!shax_dir.join("chat-history.json").exists());
        let migrated = std::fs::read_to_string(new_dir.join("main.json")).unwrap();
        assert!(migrated.contains(r#""content":"legacy""#));
    }

    #[test]
    fn migration_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let shax_dir = tmp.path().join("shax");
        let new_dir = shax_dir.join("chat-history");
        std::fs::create_dir_all(&shax_dir).unwrap();
        std::fs::write(shax_dir.join("chat-history.json"), r#"{"turns":[]}"#).unwrap();

        migrate_legacy_if_needed(&shax_dir, &new_dir).unwrap();
        // Second run is a no-op — legacy is already gone.
        migrate_legacy_if_needed(&shax_dir, &new_dir).unwrap();
        assert!(new_dir.join("main.json").exists());
    }

    #[test]
    fn migration_skipped_when_main_already_exists() {
        // If the user has already used the new build and then
        // an old build re-created chat-history.json, the newer
        // main.json is authoritative — don't clobber it.
        let tmp = tempfile::tempdir().unwrap();
        let shax_dir = tmp.path().join("shax");
        let new_dir = shax_dir.join("chat-history");
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(
            new_dir.join("main.json"),
            r#"{"turns":[{"role":"user","content":"new"}]}"#,
        )
        .unwrap();
        std::fs::write(
            shax_dir.join("chat-history.json"),
            r#"{"turns":[{"role":"user","content":"stale"}]}"#,
        )
        .unwrap();

        migrate_legacy_if_needed(&shax_dir, &new_dir).unwrap();

        let kept = std::fs::read_to_string(new_dir.join("main.json")).unwrap();
        assert!(kept.contains(r#""content":"new""#));
        // Legacy is left in place — a future migration pass
        // could clean it up, but silently deleting it now
        // risks throwing away divergent hand-edits.
        assert!(shax_dir.join("chat-history.json").exists());
    }
}
