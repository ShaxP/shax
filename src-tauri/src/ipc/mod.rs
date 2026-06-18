//! Tauri commands and channels: the IPC contract between the Rust backend and the frontend.
//!
//! All commands return `Result<_, String>` at the IPC boundary. Internally they use
//! typed `PtyError` values that are converted to strings with `.map_err(|e| e.to_string())`.

pub use crate::blocks::BlockSummary;
pub use crate::pty::{PtyEvent, PtyId, SpawnOpts};

use crate::pty::PtyManager;
use std::sync::Arc;
use tauri::State;

/// Spawn a new PTY with a child shell.
///
/// `on_event` receives a stream of `PtyEvent::Output` chunks and a final
/// `PtyEvent::Exit` when the child terminates.  Additive events
/// (`AltScreenChanged`, `BlockStarted`, `BlockCompleted`) are interleaved.
#[tauri::command]
pub async fn pty_spawn(
    opts: SpawnOpts,
    on_event: tauri::ipc::Channel<PtyEvent>,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<PtyId, String> {
    manager
        .spawn(opts, on_event)
        .await
        .map_err(|e| e.to_string())
}

/// Write base64-encoded bytes to the PTY master (keystrokes, paste, etc.).
#[tauri::command]
pub async fn pty_write(
    id: PtyId,
    data: String,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<(), String> {
    manager.write(id, &data).await.map_err(|e| e.to_string())
}

/// Resize the PTY window for the given pane.
///
/// Must be called whenever the frontend's fit addon computes new dimensions so
/// that full-screen TUI programs (vim, htop, less) see the correct terminal size.
#[tauri::command]
pub async fn pty_resize(
    id: PtyId,
    rows: u16,
    cols: u16,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<(), String> {
    manager
        .resize(id, rows, cols)
        .await
        .map_err(|e| e.to_string())
}

/// Terminate the child process and remove the PTY from the registry.
///
/// Best-effort: if the child is already dead this succeeds silently.
#[tauri::command]
pub async fn pty_kill(id: PtyId, manager: State<'_, Arc<PtyManager>>) -> Result<(), String> {
    manager.kill(id).await.map_err(|e| e.to_string())
}

/// Return the current block list for a pane, oldest first.
///
/// Used by the dev status bar to show how many commands have been captured.
/// Returns an empty list for an unknown pane id.
#[tauri::command]
pub async fn pty_list_blocks(
    id: PtyId,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<Vec<BlockSummary>, String> {
    Ok(manager.list_blocks(id).await)
}
