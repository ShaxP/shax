mod agent;
mod blocks;
mod ipc;
mod mux;
mod pty;
mod safety;
mod search;
mod store;
mod vt;

use std::sync::Arc;

use ipc::{pty_get_block_output, pty_kill, pty_list_blocks, pty_resize, pty_spawn, pty_write};
use pty::PtyManager;
use store::{default_db_path, Store};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Open the persistent store under the user's app data dir. If the open
    // fails (no writable disk, corrupted DB, etc.) we fall back to a
    // memory-only manager so the terminal still functions — losing history
    // is preferable to refusing to launch.
    let store = match Store::open(&default_db_path()) {
        Ok(s) => Some(Arc::new(s)),
        Err(e) => {
            tracing::warn!("failed to open SQLite store; running without persistence: {e}");
            None
        }
    };
    let manager = Arc::new(match store {
        Some(s) => PtyManager::with_store(s),
        None => PtyManager::new(),
    });

    // The reader thread runs outside Tauri State and reaches the manager via
    // a process-global Arc.
    pty::set_global_manager(Arc::clone(&manager));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Persists window size + position to a JSON file under the app data
        // dir so relaunches restore what the user last had. The plugin
        // installs window-event handlers automatically; no other glue needed.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(manager)
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_list_blocks,
            pty_get_block_output,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
