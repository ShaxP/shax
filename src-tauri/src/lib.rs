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
use tauri::Manager as _;

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

/// Managed handle to the process-wide `Embedder`. Shared by
/// the background sweep task and the two semantic-search
/// commands so that every code path uses the same
/// `model_id()` — otherwise the sweep might index under one
/// tag while queries look up another and return nothing.
type SharedEmbedder = Arc<dyn search::embedding::Embedder>;

/// Try to load the real ONNX-backed embedder from the app's
/// resource dir. Falls back to the mock `HashEmbedder` if
/// the model / tokenizer files are missing (e.g. offline
/// build that skipped the fetch) or the ONNX runtime fails
/// to initialise. Never panics — semantic search degrades to
/// mock-quality rather than crashing the app.
fn load_embedder(app: &tauri::AppHandle) -> SharedEmbedder {
    // Prefer the bundled resource dir (packaged app). In dev
    // Tauri points this at `src-tauri/`, so the same lookup
    // works from `cargo tauri dev`.
    let resource_dir = match app.path().resource_dir() {
        Ok(dir) => dir,
        Err(e) => {
            tracing::warn!("no resource dir; using mock embedder: {e}");
            return Arc::new(search::embedding::HashEmbedder::default());
        }
    };
    let model = resource_dir.join("assets/all-MiniLM-L6-v2.onnx");
    let tokenizer = resource_dir.join("assets/tokenizer.json");
    if !model.exists() || !tokenizer.exists() {
        tracing::warn!(
            "onnx model or tokenizer missing under {}; using mock embedder",
            resource_dir.display()
        );
        return Arc::new(search::embedding::HashEmbedder::default());
    }
    match search::onnx::OnnxMiniLmEmbedder::load(&model, &tokenizer) {
        Ok(e) => {
            tracing::info!("loaded onnx embedder from {}", model.display());
            Arc::new(e)
        }
        Err(e) => {
            tracing::warn!("failed to init onnx embedder; using mock: {e:?}");
            Arc::new(search::embedding::HashEmbedder::default())
        }
    }
}

/// Embedding indexer progress: `(indexed, total)` block
/// counts under the currently-active model. The search
/// overlay's semantic tier (slice 3) surfaces this as a
/// tiny "N of M indexed" indicator so users know whether a
/// query is running against the full history yet.
#[tauri::command]
fn embedding_progress(
    manager: tauri::State<'_, Arc<PtyManager>>,
    embedder: tauri::State<'_, SharedEmbedder>,
) -> Result<(u64, u64), String> {
    let Some(store) = manager.store() else {
        return Ok((0, 0));
    };
    store
        .embedding_progress(embedder.model_id())
        .map_err(|e| e.to_string())
}

/// Semantic nearest-neighbours query over the block
/// embeddings. Returns `(block_id, similarity)` pairs
/// sorted by similarity descending.
#[tauri::command]
fn semantic_search(
    query: String,
    limit: usize,
    manager: tauri::State<'_, Arc<PtyManager>>,
    embedder: tauri::State<'_, SharedEmbedder>,
) -> Result<Vec<(String, f32)>, String> {
    let Some(store) = manager.store() else {
        return Ok(vec![]);
    };
    let vector = embedder.embed(&query);
    let hits = store
        .nearest_neighbours(embedder.model_id(), &vector, limit)
        .map_err(|e| e.to_string())?;
    Ok(hits
        .into_iter()
        .map(|(id, s)| (id.to_string(), s))
        .collect())
}

/// Install a `tracing` subscriber so `tracing::info!` /
/// `warn!` calls throughout the backend actually reach a
/// destination. Without this, every `tracing::*` call in the
/// codebase is a no-op — including the embedder sweep's
/// "indexed N block(s)" line.
///
/// Reads the `RUST_LOG` env var (e.g. `RUST_LOG=shax=info` to
/// see only our crate) and defaults to `info` for the `shax`
/// crate + `warn` globally so a fresh launch is quiet unless
/// something goes wrong.
///
/// Logs go to stderr, which `cargo tauri dev` surfaces in the
/// terminal you launched from, and the packaged app writes to
/// the OS-standard stderr sink.
fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn,shax=info"));
    // `try_init` — safe to call from tests that also set up a
    // subscriber, and avoids panicking if run() somehow fires
    // twice (e.g. a mobile-entry-point double-init).
    let _ = fmt().with_env_filter(filter).with_target(false).try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

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
        .setup(move |app| {
            // Prefer the real ONNX-backed `all-MiniLM-L6-v2`
            // model if the resource files are present; fall
            // back to the mock `HashEmbedder` otherwise so a
            // broken bundle never bricks the app — semantic
            // search just isn't meaningful until the model is
            // fixed. The same instance is shared with the
            // `embedding_progress` / `semantic_search`
            // commands via managed state so every path uses
            // the same `model_id()`.
            let embedder: SharedEmbedder = load_embedder(app.handle());
            app.manage(embedder.clone());
            // Kick off the background sweep. Skip when there's
            // no store (memory-only fallback).
            if let Some(store) = store_for_embedder.clone() {
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
