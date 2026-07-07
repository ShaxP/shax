//! Assistant runtime — provider execution + credential
//! storage. M6 (spec §09, §10).
//!
//! Providers are implemented as Tauri commands rather than
//! individual traits so the renderer's `AssistantProvider`
//! implementation can pick the right transport at runtime
//! without a Rust-side registry. The chokepoint invariant
//! (spec §10 safety gate) lives on the renderer — this
//! module streams events; the caller enforces the gate on
//! tool-call events before executing them.

pub mod anthropic;
pub mod claude_cli;
pub mod config;
pub mod keychain;
pub mod ollama;
pub mod sse;

use tauri::ipc::Channel;

use anthropic::{stream_messages, StreamEvent, StreamInput};
use claude_cli::{probe as probe_claude_cli, stream_via_cli};
use config::AssistantConfig;
use ollama::{probe as probe_ollama, stream_chat as stream_ollama, ProbeResult as OllamaProbe};

// --- Tauri commands ---------------------------------------

/// Persist an API key for the given provider slot in the
/// OS keychain. The key never touches disk in plain form.
#[tauri::command]
pub fn set_assistant_api_key(provider_id: String, secret: String) -> Result<(), String> {
    keychain::set_api_key(&provider_id, &secret).map_err(|e| e.to_string())
}

/// Report whether an API key is configured. Cheap — doesn't
/// actually decrypt or transport the key. Used by the
/// settings UI to render a "configured" / "not configured"
/// affordance without needing to hold the value.
#[tauri::command]
pub fn has_assistant_api_key(provider_id: String) -> Result<bool, String> {
    keychain::has_api_key(&provider_id).map_err(|e| e.to_string())
}

/// Remove the stored API key. Idempotent.
#[tauri::command]
pub fn delete_assistant_api_key(provider_id: String) -> Result<(), String> {
    keychain::delete_api_key(&provider_id).map_err(|e| e.to_string())
}

// --- Claude subscription lane (slice 2b) ------------------

/// Probe for the `claude` CLI on PATH. Returns the reported
/// version string on success, `None` when not installed.
/// Used by the settings UI to show a "Claude Code detected"
/// / "install Claude Code to use this lane" affordance.
#[tauri::command]
pub async fn claude_cli_probe() -> Result<Option<String>, String> {
    probe_claude_cli().await.map_err(|e| e.to_string())
}

/// Stream a chat completion via the locally installed
/// `claude` CLI (subscription lane, spec §09 hard licensing
/// rule). Same output shape as `claude_stream` — the
/// renderer routes both through the same
/// `ClaudeProvider` shim.
#[tauri::command]
pub async fn claude_cli_stream(
    input: StreamInput,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let emit = move |event: StreamEvent| {
        let _ = on_event.send(event);
    };
    stream_via_cli(input, emit).await.map_err(|e| e.to_string())
}

// --- Ollama lane (slice 3) --------------------------------

/// Probe the local Ollama daemon. Returns whether it's
/// reachable and, if so, the list of installed models. The
/// settings UI populates its model dropdown from this.
/// Never errors — an unreachable daemon is a valid state,
/// reported as `reachable: false`.
#[tauri::command]
pub async fn ollama_probe() -> OllamaProbe {
    probe_ollama().await
}

/// Stream a chat completion via the local Ollama daemon.
/// Same `StreamEvent` shape as `claude_stream` — the
/// renderer's `OllamaProvider` translates events for the
/// chat surface.
#[tauri::command]
pub async fn ollama_stream(
    input: StreamInput,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let emit = move |event: StreamEvent| {
        let _ = on_event.send(event);
    };
    stream_ollama(input, emit).await.map_err(|e| e.to_string())
}

// --- Config persistence -----------------------------------

/// Load the persisted assistant config (provider choice,
/// Claude lane, model override). Returns defaults when the
/// config file doesn't exist yet.
#[tauri::command]
pub fn get_assistant_config() -> Result<AssistantConfig, String> {
    config::load().map_err(|e| e.to_string())
}

/// Overwrite the persisted assistant config.
#[tauri::command]
pub fn set_assistant_config(config: AssistantConfig) -> Result<(), String> {
    config::save(&config).map_err(|e| e.to_string())
}

/// Stream a Messages request against Anthropic's API. Reads
/// the API key from the OS keychain — the renderer never
/// sees it. Events flow back over `on_event` (Tauri
/// `Channel`) as JSON-serialised `StreamEvent`s.
///
/// Streams synchronously until the response finishes;
/// callers should `await` the returned future to observe
/// stream completion. Errors mid-stream are also emitted as
/// `StreamEvent::Error` for the renderer to render, and
/// then this command returns `Ok(())` — the caller can
/// distinguish "stream never started" (`Err`) from "stream
/// started, then failed" (Ok + Error event) that way.
#[tauri::command]
pub async fn claude_stream(
    input: StreamInput,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let key = keychain::get_api_key("claude")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no Anthropic API key configured".to_string())?;

    let emit = move |event: StreamEvent| {
        // If the renderer has dropped the channel (window
        // closed, tab switched, etc.) the send fails; we
        // swallow silently. Nothing left to notify.
        let _ = on_event.send(event);
    };
    stream_messages(&key, input, emit)
        .await
        .map_err(|e| e.to_string())
}
