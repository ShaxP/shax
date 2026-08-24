mod agent;
mod blocks;
mod disk;
mod ipc;
mod menu;
mod mux;
mod netif;
mod power;
mod preferences;
mod pty;
mod safety;
mod search;
mod status;
mod store;
mod themes;
mod vt;
mod wifi;

use std::sync::Arc;

use agent::{
    claude_cli_probe, claude_cli_stream, claude_stream, clear_chat_history,
    delete_assistant_api_key, get_assistant_config, get_chat_history, has_assistant_api_key,
    ollama_probe, ollama_probe_model, ollama_stream, set_assistant_api_key, set_assistant_config,
    set_chat_history,
};
use ipc::{
    app_state_load, app_state_save, block_get_output, close_window_confirmed, git_branches,
    git_diff, git_root_for, git_status_porcelain, git_user_email, home_dir, list_branches,
    list_community_commands, list_community_formatters, list_cwds, list_themes, open_new_window,
    pty_get_block_output, pty_kill, pty_list_blocks, pty_resize, pty_running_commands, pty_spawn,
    pty_write, quit_confirmed, read_dir_entries, read_file_bytes, search_blocks, stat_file,
};
use preferences::Preferences;
use pty::PtyManager;
use store::{default_db_path, Store};
use tauri::{Emitter as _, Manager as _};

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

/// Embedding indexer progress under the currently-active
/// model. The search overlay's semantic tier surfaces
/// `indexed / total` as a tiny "N of M indexed" indicator so
/// users know whether a query runs against the full history
/// yet. `model_id` lets the frontend distinguish the real
/// ONNX model from the mock fallback and adjust its copy
/// (a `model_id` starting with `mock-` means semantic search
/// is running on placeholder vectors).
#[derive(serde::Serialize)]
struct EmbeddingProgress {
    indexed: u64,
    total: u64,
    model_id: String,
}

#[tauri::command]
fn embedding_progress(
    manager: tauri::State<'_, Arc<PtyManager>>,
    embedder: tauri::State<'_, SharedEmbedder>,
) -> Result<EmbeddingProgress, String> {
    let model_id = embedder.model_id().to_string();
    let Some(store) = manager.store() else {
        return Ok(EmbeddingProgress {
            indexed: 0,
            total: 0,
            model_id,
        });
    };
    let (indexed, total) = store
        .embedding_progress(&model_id)
        .map_err(|e| e.to_string())?;
    Ok(EmbeddingProgress {
        indexed,
        total,
        model_id,
    })
}

/// One semantic-search result. Mirrors `SearchHit`'s shape
/// so the frontend can render both tiers with the same row
/// component, but replaces `snippet` / `fuzzy` (both
/// FTS-specific) with a `similarity` score in `[-1.0, 1.0]`.
#[derive(serde::Serialize)]
struct SemanticHit {
    block: crate::blocks::BlockSummary,
    pane_id: crate::pty::PtyId,
    similarity: f32,
}

/// Semantic nearest-neighbours query. Runs the active
/// embedder over the query, walks the k-NN over stored
/// block embeddings, then hydrates each hit back to a full
/// `BlockSummary + pane_id` so the frontend doesn't need a
/// second round-trip.
#[tauri::command]
fn semantic_search(
    query: String,
    limit: usize,
    manager: tauri::State<'_, Arc<PtyManager>>,
    embedder: tauri::State<'_, SharedEmbedder>,
) -> Result<Vec<SemanticHit>, String> {
    let Some(store) = manager.store() else {
        return Ok(vec![]);
    };
    if query.trim().is_empty() {
        // Similarity against an empty vector is meaningless —
        // short-circuit so we don't waste an inference call.
        return Ok(vec![]);
    }
    let vector = embedder.embed(&query);
    let ranked = store
        .nearest_neighbours(embedder.model_id(), &vector, limit)
        .map_err(|e| e.to_string())?;
    let ids: Vec<crate::blocks::BlockId> = ranked.iter().map(|(id, _)| *id).collect();
    let similarities: std::collections::HashMap<crate::blocks::BlockId, f32> =
        ranked.into_iter().collect();
    let hydrated = store.hydrate_blocks(&ids).map_err(|e| e.to_string())?;
    Ok(hydrated
        .into_iter()
        .filter_map(|(block, pane_id)| {
            similarities
                .get(&block.id)
                .copied()
                .map(|similarity| SemanticHit {
                    block,
                    pane_id,
                    similarity,
                })
        })
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
    // Eager-wake channel between the PTY reader (sender) and the
    // embedder task (receiver). Freshly-persisted blocks poke the
    // sweep straight away instead of waiting for the 30 s tick.
    let (wake_tx, wake_rx) = search::backfill::wake_channel();

    // M9.1: multi-window registry. Tracks which OS window owns
    // which PTY so window-close teardown (M9.4) can reap the right
    // set. Built BEFORE `PtyManager` so we can inject the registry
    // handle — every PTY removal path (kill / natural exit) then
    // unregisters from `Windows` atomically, keeping the two data
    // structures consistent.
    let windows = Arc::new(mux::Windows::default());

    let manager = Arc::new(
        match store {
            Some(s) => PtyManager::with_store(s),
            None => PtyManager::new(),
        }
        .with_indexer_notifier(wake_tx)
        .with_windows(Arc::clone(&windows)),
    );

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
        .manage(windows)
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
                std::mem::drop(search::backfill::spawn(store, embedder, wake_rx));
            }

            // M9.4 app menu (macOS only). Non-macOS returns Ok(None)
            // from build_app_menu — Windows/Linux keep their
            // in-frontend chrome and keydown handlers.
            let handle = app.handle().clone();
            if let Some(menu) = menu::build_app_menu(&handle)? {
                app.set_menu(menu)?;
                app.on_menu_event(move |app, event| {
                    menu::handle_menu_event(app, event.id().as_ref());
                });
            }

            // M9.4 window-close teardown: hook the main window so
            // closing it reaps any PTYs it owned. Spawned windows
            // (M9.3) get the same hook installed inside
            // `menu::spawn_new_window`.
            if let Some(window) = app.get_webview_window("main") {
                menu::register_close_teardown(&handle, &window);
            }

            // M13 refinement: one sampler for the whole app. CPU
            // usage is a delta between refreshes, so letting each
            // window poll on its own timer made every window's
            // reading depend on when the *others* last refreshed.
            // See `status::SystemLoadSeries`.
            status::spawn_sampler(app.handle().clone());

            // M9.5 session restore. Spawns any non-"main" windows
            // that were open at the previous quit. No-op on a
            // fresh install (empty session list). Runs AFTER the
            // main-window teardown wiring so restored windows go
            // through the standard hook path (they'll get their
            // own close teardowns from `spawn_window_with_label`).
            menu::restore_session_windows(&handle);

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
            open_new_window,
            pty_running_commands,
            close_window_confirmed,
            quit_confirmed,
            search_blocks,
            list_branches,
            list_cwds,
            git_root_for,
            block_get_output,
            read_file_bytes,
            read_dir_entries,
            git_status_porcelain,
            git_branches,
            git_user_email,
            home_dir,
            git_diff,
            list_community_formatters,
            list_community_commands,
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
            list_themes,
            status::system_battery,
            status::system_local_ip,
            status::system_load_series,
            status::system_ssid,
            power::power_keep_awake,
            power::power_keep_awake_state,
            wifi::wifi_info,
            wifi::wifi_request_ssid_access,
            netif::net_interfaces,
            disk::disk_volumes,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // M9.4 / M9.5 lifecycle event routing.
    //
    // - `ExitRequested { code: None }` on macOS: the runtime decided
    //   to quit (last window closed). Prevent it — the app stays
    //   alive in the menu bar / dock, matching macOS convention.
    //   `code: Some(_)` means an explicit `app.exit(n)` (Quit menu,
    //   ⌘Q) which is always allowed to proceed.
    // - `Reopen` on macOS (M9.5): user clicked the dock icon with
    //   no visible windows. Restore the previously-saved session;
    //   if the session was empty, fall back to spawning one fresh
    //   window so the dock click is never a silent no-op.
    // - `Exit`: save the (currently-empty, but here for
    //   completeness) window list once more, then reap every PTY
    //   child so no shell outlives the parent.
    app.run(move |handle, event| match event {
        // M9.4 stay-alive path: on macOS, the *runtime* fires
        // `ExitRequested { code: None }` when the last window is
        // closed. Prevent that so the app persists in the menu
        // bar + dock (matches macOS convention). Every other
        // ExitRequested — including ⌘Q from the app menu, which
        // routes through `NSApplication::terminate:` and *also*
        // fires with code=None but with windows still open — falls
        // through to the M9.6 arm below.
        //
        // The `webview_windows().is_empty()` check is the
        // distinguishing signal: last-window-close leaves zero
        // windows by the time ExitRequested fires; menu-Quit
        // leaves the windows in place until the exit actually
        // proceeds.
        tauri::RunEvent::ExitRequested { code, api, .. }
            if menu::should_prevent_exit(code) && handle.webview_windows().is_empty() =>
        {
            api.prevent_exit();
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            // M9.6: any ExitRequested reaching this arm is either
            // (a) our own custom Quit menu handler calling
            // `app.exit(0)` after clearing the modal check (or
            // after `quit_confirmed()` set the bypass flag), or
            // (b) a platform / IPC path (Linux OS shutdown,
            // Windows quit, `app.exit(...)` from anywhere). On
            // macOS, ⌘Q from our menu no longer routes here at
            // all — see `menu::handle_quit_request` — because
            // `PredefinedMenuItem::quit` bypasses ExitRequested,
            // so this arm cannot intercept it and we handle the
            // check in the menu handler instead.
            //
            // If the frontend already showed the warning modal
            // and the user confirmed, `consume_quit_confirmed()`
            // returns true and we let the exit proceed. Otherwise,
            // if any pane has a running non-alt-screen command,
            // prevent the exit and ask the focused window to show
            // the modal.
            let Some(windows) = handle.try_state::<Arc<mux::Windows>>() else {
                return;
            };
            if windows.consume_quit_confirmed() {
                return;
            }
            let Some(manager) = handle.try_state::<Arc<PtyManager>>() else {
                return;
            };
            let running = tauri::async_runtime::block_on(manager.running_command_pane_ids());
            if running.is_empty() {
                return;
            }
            api.prevent_exit();
            let target_label = handle
                .webview_windows()
                .into_iter()
                .find(|(_, w)| w.is_focused().unwrap_or(false))
                .or_else(|| handle.webview_windows().into_iter().next())
                .map(|(label, _)| label);
            if let Some(label) = target_label {
                // Targeted emit — `Manager::emit` (which
                // WebviewWindow inherits) is app-global, so a
                // plain `window.emit(...)` would open the quit
                // modal in every window, not just the focused
                // one. Same trap that hit the window-close
                // intercept before the M9.6 fix.
                if let Err(e) = handle.emit_to(
                    tauri::EventTarget::WebviewWindow { label },
                    "shax:confirm-quit",
                    serde_json::json!({ "count": running.len() }),
                ) {
                    tracing::warn!("quit-intercept: emit failed: {e}");
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            menu::restore_session_windows(handle);
            // If nothing was restored (empty saved session or all
            // labels failed to spawn), fall back to a fresh window
            // so the dock click never appears to do nothing.
            if handle.webview_windows().is_empty() {
                if let Err(e) = menu::spawn_new_window(handle) {
                    tracing::warn!("dock reopen: spawn_new_window fallback failed: {e}");
                }
            }
        }
        tauri::RunEvent::Exit => {
            menu::save_session_windows(handle);
            // M13.4: drop the keep-awake assertion before the process
            // goes. Leaving it held would outlive the app on Linux,
            // where the inhibitor lock belongs to a child process that
            // would otherwise be reparented and keep running.
            power::release_on_exit();
            tauri::async_runtime::block_on(manager_for_exit.shutdown_all());
        }
        _ => {}
    });
}
