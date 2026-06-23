//! Tauri commands and channels: the IPC contract between the Rust backend and the frontend.
//!
//! All commands return `Result<_, String>` at the IPC boundary. Internally they use
//! typed `PtyError` values that are converted to strings with `.map_err(|e| e.to_string())`.

pub use crate::blocks::{BlockId, BlockSummary};
pub use crate::pty::{PtyEvent, PtyId, SpawnOpts};

use crate::pty::PtyManager;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
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

/// Return the captured stdout/stderr bytes for one completed block.
///
/// The bytes are base64-encoded for IPC transit using the same engine as
/// `PtyEvent::Output`. An unknown pane or block id, or a block that is still
/// running, returns an empty string rather than an error — the frontend treats
/// "no bytes available" uniformly.
#[tauri::command]
pub async fn pty_get_block_output(
    id: PtyId,
    block_id: BlockId,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<String, String> {
    let bytes = manager.get_block_output(id, block_id).await;
    Ok(B64.encode(&bytes))
}

/// Return the captured bytes for one block by id alone, going straight to
/// the persistent store. Used by the search-results viewer modal: search
/// surfaces blocks from previous sessions whose owning pane no longer
/// exists, so a `(pty_id, block_id)` lookup wouldn't have anywhere to go.
/// Returns an empty base64 string for an unknown id.
#[tauri::command]
pub async fn block_get_output(
    block_id: BlockId,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<String, String> {
    let Some(store) = manager.store() else {
        return Ok(String::new());
    };
    let bytes = store
        .load_output(block_id)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(B64.encode(&bytes))
}

/// Load the persisted app-state JSON (tabs + layout tree + focused pane),
/// or `null` if the user has no prior session yet. The frontend hydrates
/// its tab reducer from this on mount; if the store isn't attached (rare,
/// only in bare `cargo test`-style runs without a DB), returns `null` too.
#[tauri::command]
pub async fn app_state_load(manager: State<'_, Arc<PtyManager>>) -> Result<Option<String>, String> {
    let Some(store) = manager.store() else {
        return Ok(None);
    };
    store.load_app_state().map_err(|e| e.to_string())
}

/// Persist the app-state JSON (tabs + layout tree + focused pane) so the
/// next launch can restore the user's layout. Called debounced by the
/// frontend whenever a tab is opened, closed, or split.
#[tauri::command]
pub async fn app_state_save(
    json: String,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<(), String> {
    let Some(store) = manager.store() else {
        return Ok(());
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    store
        .save_app_state(&json, now_ms)
        .map_err(|e| e.to_string())
}

/// Full-text search across all persisted block summaries. `query` is the
/// raw FTS5 MATCH expression — multiple whitespace-separated words are
/// AND'd implicitly; users wanting fancier syntax (`OR`, `*`, quoted
/// phrases) can spell it out. An empty / whitespace-only query returns
/// no rows; invalid FTS5 syntax (a half-typed `"`, …) also returns no
/// rows rather than surfacing an error so the search overlay can show
/// "no results" cleanly while the user keeps typing.
#[tauri::command]
pub async fn search_blocks(
    query: String,
    limit: usize,
    offset: usize,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<Vec<BlockSummary>, String> {
    let Some(store) = manager.store() else {
        return Ok(Vec::new());
    };
    store
        .search(&query, limit, offset)
        .map_err(|e| e.to_string())
}
