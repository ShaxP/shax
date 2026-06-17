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

use ipc::{pty_kill, pty_resize, pty_spawn, pty_write};
use pty::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager = Arc::new(PtyManager::new());

    // The reader thread runs outside Tauri State and reaches the manager via
    // a process-global Arc.
    pty::set_global_manager(Arc::clone(&manager));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(manager)
        .invoke_handler(tauri::generate_handler![
            pty_spawn, pty_write, pty_resize, pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
