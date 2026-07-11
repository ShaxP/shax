mod agent;
mod blocks;
mod ipc;
mod mux;
mod preferences;
mod pty;
mod safety;
mod search;
mod store;
mod vt;

use std::sync::Arc;

use agent::{
    claude_cli_probe, claude_cli_stream, claude_stream, clear_chat_history,
    delete_assistant_api_key, get_assistant_config, get_chat_history, has_assistant_api_key,
    ollama_probe, ollama_probe_model, ollama_stream, set_assistant_api_key, set_assistant_config,
    set_chat_history,
};
use ipc::{
    app_state_load, app_state_save, block_get_output, git_diff, git_root_for, git_status_porcelain,
    list_branches, list_community_formatters, list_cwds, pty_get_block_output, pty_kill,
    pty_list_blocks, pty_resize, pty_spawn, pty_write, read_dir_entries, read_file_bytes,
    search_blocks, stat_file,
};
use preferences::Preferences;
use pty::PtyManager;
use store::{default_db_path, Store};

/// Load the persisted app-level preferences (theme, etc.).
/// Missing / malformed file → defaults.
#[tauri::command]
fn get_preferences() -> Result<Preferences, String> {
    preferences::load().map_err(|e| e.to_string())
}

/// Overwrite the persisted app-level preferences.
#[tauri::command]
fn set_preferences(preferences: Preferences) -> Result<(), String> {
    preferences::save(&preferences).map_err(|e| e.to_string())
}

/// Embedding indexer progress: `(indexed, total)` block
/// counts under the currently-active model. The search
/// overlay's semantic tier (slice 3) surfaces this as a
/// tiny "N of M indexed" indicator so users know whether a
/// query is running against the full history yet.
#[tauri::command]
fn embedding_progress(manager: tauri::State<'_, Arc<PtyManager>>) -> Result<(u64, u64), String> {
    use search::embedding::Embedder as _;
    let Some(store) = manager.store() else {
        return Ok((0, 0));
    };
    let embedder = search::embedding::HashEmbedder::default();
    store
        .embedding_progress(embedder.model_id())
        .map_err(|e| e.to_string())
}

/// Semantic nearest-neighbours query over the block
/// embeddings. Returns `(block_id, similarity)` pairs
/// sorted by similarity descending. Wired now so slice 3
/// can start on the UI without waiting for the real model;
/// the mock embedder makes the results non-meaningful but
/// the plumbing works.
#[tauri::command]
fn semantic_search(
    query: String,
    limit: usize,
    manager: tauri::State<'_, Arc<PtyManager>>,
) -> Result<Vec<(String, f32)>, String> {
    use search::embedding::Embedder as _;
    let Some(store) = manager.store() else {
        return Ok(vec![]);
    };
    let embedder = search::embedding::HashEmbedder::default();
    let vector = embedder.embed(&query);
    let hits = store
        .nearest_neighbours(embedder.model_id(), &vector, limit)
        .map_err(|e| e.to_string())?;
    Ok(hits
        .into_iter()
        .map(|(id, s)| (id.to_string(), s))
        .collect())
}

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
    // Keep a second reference to the store for the semantic
    // search embedder task, which runs in the Tauri setup
    // callback (below) once the async runtime is ready.
    let store_for_embedder = store.clone();
    let manager = Arc::new(match store {
        Some(s) => PtyManager::with_store(s),
        None => PtyManager::new(),
    });

    // The reader thread runs outside Tauri State and reaches the manager via
    // a process-global Arc.
    pty::set_global_manager(Arc::clone(&manager));

    // Cloned for the exit-hook callback below — the original is moved
    // into `.manage()` for the command-state slot.
    let manager_for_exit = Arc::clone(&manager);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Persists window size + position to a JSON file under the app data
        // dir so relaunches restore what the user last had. The plugin
        // installs window-event handlers automatically; no other glue needed.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(manager)
        .setup(move |_app| {
            // Kick off the background embedder sweep once the
            // tokio runtime is up. Uses the mock hash embedder
            // for now — slice 2b swaps in the real
            // `all-MiniLM-L6-v2` ONNX model. When there's no
            // store (fell back to memory-only), skip the
            // sweep entirely.
            if let Some(store) = store_for_embedder.clone() {
                let embedder: Arc<dyn search::embedding::Embedder> =
                    Arc::new(search::embedding::HashEmbedder::default());
                // Fire-and-forget; the JoinHandle lives with
                // the runtime and doesn't need explicit
                // awaiting. `drop` on shutdown detaches it.
                std::mem::drop(search::backfill::spawn(store, embedder));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_list_blocks,
            pty_get_block_output,
            app_state_load,
            app_state_save,
            search_blocks,
            list_branches,
            list_cwds,
            git_root_for,
            block_get_output,
            read_file_bytes,
            read_dir_entries,
            git_status_porcelain,
            git_diff,
            list_community_formatters,
            stat_file,
            set_assistant_api_key,
            has_assistant_api_key,
            delete_assistant_api_key,
            claude_stream,
            claude_cli_probe,
            claude_cli_stream,
            ollama_probe,
            ollama_probe_model,
            ollama_stream,
            get_assistant_config,
            set_assistant_config,
            get_chat_history,
            set_chat_history,
            clear_chat_history,
            get_preferences,
            set_preferences,
            embedding_progress,
            semantic_search,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // RunEvent::Exit fires after the last window has closed and the event
    // loop is about to terminate. We use it to reap every PTY child so no
    // shell outlives the parent — without this, `tauri:dev` quits leave
    // orphan zsh / bash processes still bound to the old PTY masters.
    app.run(move |_handle, event| {
        if let tauri::RunEvent::Exit = event {
            tauri::async_runtime::block_on(manager_for_exit.shutdown_all());
        }
    });
}
