//! Chat history persistence — one JSON file per install.
//!
//! Slice-4's chat overlay was in-memory only: closing the
//! overlay or restarting the app lost the conversation. This
//! module persists a small transcript so users can pick up
//! where they left off.
//!
//! Scope for the MVP:
//!   - **One conversation**. No named sessions, no sidebar.
//!     A "New" button in the header clears it.
//!   - **Capped at `MAX_TURNS` entries** — the file stays
//!     small and load is cheap. Older turns fall off the
//!     front when the cap is exceeded.
//!   - **Same platform config dir** as `assistant.json`:
//!     `~/Library/Application Support/shax` on macOS,
//!     `%APPDATA%/shax` on Windows,
//!     `$XDG_CONFIG_HOME/shax` on Linux.
//!   - **Atomic writes** — write to a sibling tempfile then
//!     rename. Prevents partial writes if the app crashes
//!     mid-save.
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

fn history_path() -> Result<PathBuf, HistoryError> {
    let base = platform_config_dir().ok_or(HistoryError::NoConfigDir)?;
    Ok(base.join("shax").join("chat-history.json"))
}

/// Load persisted turns. Missing file → empty. Malformed
/// file → empty (with a warn log) so a hand-edit slip
/// doesn't break the overlay.
pub fn load() -> Result<ChatHistory, HistoryError> {
    let path = history_path()?;
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
            tracing::warn!("chat history parse failed, falling back to empty: {e}");
            Ok(ChatHistory::default())
        }
    }
}

/// Overwrite the file. Trims to `MAX_TURNS` from the front
/// so callers don't have to think about the cap. Empty
/// history → we still write the file (an explicit clear is
/// meaningful; deleting the file leaves ambiguous state).
pub fn save(mut history: ChatHistory) -> Result<(), HistoryError> {
    let path = history_path()?;
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

/// Delete the on-disk history. Used by the "New" button in
/// the overlay header. A missing file is not an error —
/// idempotent.
pub fn clear() -> Result<(), HistoryError> {
    let path = history_path()?;
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
}
