//! Ollama transport — local provider (M6 slice 3).
//!
//! Ollama runs a small HTTP daemon on the user's machine
//! (default `http://localhost:11434`) and exposes chat
//! completions at `/api/chat`. No auth — anyone with access
//! to the socket can query it. That's fine for the M6 MVP:
//! Ollama is the reference **local** provider (spec §09
//! `privacyPosture: "local"` — nothing leaves the machine).
//!
//! Wire shape from Ollama is refreshingly simple compared
//! to Anthropic: newline-delimited JSON, one message per
//! line. Text arrives as `message.content` deltas; the last
//! line has `done: true` plus a `done_reason`. We translate
//! to the internal `StreamEvent` shape used by every
//! provider.
//!
//! MVP scope:
//!   - Text-only streaming. Tools are model-dependent; we
//!     declare `tools: false` on the provider and don't
//!     send a `tools` field. Enabling per-model tool
//!     capability probing is a follow-up.
//!   - No auth / API key — assumes local socket. If a user
//!     wants a remote Ollama they can proxy it themselves.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::anthropic::{Message, MessageContent, MessageRole, StreamEvent, StreamInput};

const DEFAULT_URL: &str = "http://localhost:11434";

// --- Public shapes -----------------------------------------

#[derive(Debug, Serialize)]
pub struct ProbeResult {
    /// Whether we could reach the Ollama daemon.
    pub reachable: bool,
    /// Model names installed locally. Empty when the daemon
    /// is reachable but no models are pulled yet.
    pub models: Vec<String>,
    /// Diagnostic message when unreachable. Not shown to the
    /// user directly; the UI shows a generic "not detected"
    /// hint.
    pub error: Option<String>,
}

// --- Errors -----------------------------------------------

#[derive(Debug, Error)]
pub enum OllamaError {
    #[error("http error: {0}")]
    Http(String),
    #[error("api error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("json error: {0}")]
    Json(String),
}

impl From<reqwest::Error> for OllamaError {
    fn from(e: reqwest::Error) -> Self {
        OllamaError::Http(e.to_string())
    }
}

impl From<serde_json::Error> for OllamaError {
    fn from(e: serde_json::Error) -> Self {
        OllamaError::Json(e.to_string())
    }
}

// --- Probe ------------------------------------------------

/// Ask the Ollama daemon for its installed models. When the
/// daemon isn't reachable (connection refused / DNS / timeout)
/// returns a `ProbeResult` with `reachable: false` — we don't
/// bubble up the error because "Ollama isn't running" is
/// normal, not exceptional.
pub async fn probe() -> ProbeResult {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build();
    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return ProbeResult {
                reachable: false,
                models: vec![],
                error: Some(e.to_string()),
            }
        }
    };
    let url = format!("{}/api/tags", DEFAULT_URL);
    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            match response.json::<TagsResponse>().await {
                Ok(tags) => ProbeResult {
                    reachable: true,
                    models: tags.models.into_iter().map(|m| m.name).collect(),
                    error: None,
                },
                Err(e) => ProbeResult {
                    reachable: true,
                    models: vec![],
                    error: Some(format!("could not parse /api/tags: {e}")),
                },
            }
        }
        Ok(response) => ProbeResult {
            reachable: false,
            models: vec![],
            error: Some(format!("http {}", response.status().as_u16())),
        },
        Err(e) => ProbeResult {
            reachable: false,
            models: vec![],
            error: Some(e.to_string()),
        },
    }
}

#[derive(Debug, Deserialize)]
struct TagsResponse {
    models: Vec<TagsModel>,
}

#[derive(Debug, Deserialize)]
struct TagsModel {
    name: String,
}

// --- Streaming --------------------------------------------

/// Send a chat completion request to the local Ollama daemon
/// and stream events into `emit`. Callers (the Tauri command)
/// forward those events over a `Channel<StreamEvent>`.
pub async fn stream_chat<F>(input: StreamInput, mut emit: F) -> Result<(), OllamaError>
where
    F: FnMut(StreamEvent),
{
    let client = reqwest::Client::new();
    let body = build_request_body(&input)?;
    let url = format!("{}/api/chat", DEFAULT_URL);
    let response = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        emit(StreamEvent::Error {
            message: format!("HTTP {}: {}", status.as_u16(), text),
        });
        return Err(OllamaError::Api {
            status: status.as_u16(),
            message: text,
        });
    }

    stream_body(response, &mut emit).await?;
    Ok(())
}

async fn stream_body<F>(response: reqwest::Response, emit: &mut F) -> Result<(), OllamaError>
where
    F: FnMut(StreamEvent),
{
    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut done_emitted = false;
    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buffer.find('\n') {
            let line: String = buffer.drain(..idx + 1).collect();
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match consume_line(trimmed, emit) {
                LineOutcome::Continue => {}
                LineOutcome::Done => done_emitted = true,
            }
        }
    }
    if !buffer.trim().is_empty() {
        match consume_line(buffer.trim(), emit) {
            LineOutcome::Continue => {}
            LineOutcome::Done => done_emitted = true,
        }
    }
    if !done_emitted {
        // Body ended without a `done` line — treat as
        // end_turn so the caller gets a terminating event.
        emit(StreamEvent::Done {
            stop_reason: "end_turn".into(),
        });
    }
    Ok(())
}

enum LineOutcome {
    Continue,
    Done,
}

fn consume_line<F>(line: &str, emit: &mut F) -> LineOutcome
where
    F: FnMut(StreamEvent),
{
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            emit(StreamEvent::Warning {
                message: format!("ollama: malformed line: {e}"),
            });
            return LineOutcome::Continue;
        }
    };
    // Ollama's error responses come as `{"error": "..."}`.
    if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        emit(StreamEvent::Error {
            message: err.to_string(),
        });
        return LineOutcome::Continue;
    }
    if let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
    {
        if !content.is_empty() {
            emit(StreamEvent::Text {
                delta: content.to_string(),
            });
        }
    }
    let done = value.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
    if done {
        let stop_reason = value
            .get("done_reason")
            .and_then(|s| s.as_str())
            .map(|s| match s {
                "stop" => "end_turn".to_string(),
                "length" => "max_tokens".to_string(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "end_turn".to_string());
        emit(StreamEvent::Done { stop_reason });
        return LineOutcome::Done;
    }
    LineOutcome::Continue
}

// --- Request-body construction ----------------------------

fn build_request_body(input: &StreamInput) -> Result<serde_json::Value, OllamaError> {
    let messages: Vec<serde_json::Value> = input
        .messages
        .iter()
        .filter_map(translate_message)
        .collect();
    let system_text = collect_system_text(input);
    // Ollama accepts a `system` field via `options` or as a
    // top-level message with `role: "system"`. Native
    // `system` at the top level is cleanest.
    let mut body = serde_json::json!({
        "model": input.model,
        "messages": messages,
        "stream": true,
    });
    if !system_text.is_empty() {
        body["system"] = serde_json::Value::String(system_text);
    }
    // Ollama takes num_predict for max_tokens.
    body["options"] = serde_json::json!({ "num_predict": input.max_tokens });
    Ok(body)
}

fn translate_message(m: &Message) -> Option<serde_json::Value> {
    let content = match &m.content {
        MessageContent::Text(t) => t.clone(),
        MessageContent::Blocks(blocks) => {
            // Ollama's `/api/chat` doesn't understand
            // Anthropic content blocks. Concat text parts;
            // tool_use / tool_result blocks get inlined as
            // pseudo-JSON for the model to interpret. Tools
            // aren't actually supported by this provider in
            // the MVP.
            let mut out = String::new();
            for b in blocks {
                match b {
                    super::anthropic::ContentBlock::Text { text } => out.push_str(text),
                    super::anthropic::ContentBlock::ToolUse { name, input, .. } => {
                        out.push_str(&format!(
                            "\n[tool_use {}({})]",
                            name,
                            serde_json::to_string(input).unwrap_or_default()
                        ));
                    }
                    super::anthropic::ContentBlock::ToolResult { content, .. } => {
                        out.push_str(&format!("\n[tool_result: {content}]"));
                    }
                }
            }
            out
        }
    };
    let role = match m.role {
        MessageRole::System => return None,
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        // Ollama doesn't have a native "tool" role in its
        // chat API; fold as user content prefixed for
        // transparency. Won't hit the MVP path since we
        // don't advertise `tools` support.
        MessageRole::Tool => "user",
    };
    Some(serde_json::json!({
        "role": role,
        "content": content,
    }))
}

fn collect_system_text(input: &StreamInput) -> String {
    let mut out = String::new();
    if let Some(sys) = &input.system {
        out.push_str(sys);
    }
    for m in &input.messages {
        if m.role == MessageRole::System {
            if let MessageContent::Text(t) = &m.content {
                if !out.is_empty() {
                    out.push_str("\n\n");
                }
                out.push_str(t);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(lines: &[&str]) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        for line in lines {
            let _ = consume_line(line, &mut |e| out.push(e));
        }
        out
    }

    #[test]
    fn text_content_becomes_a_text_event() {
        let out = events(&[
            r#"{"model":"llama3","message":{"role":"assistant","content":"Hello"},"done":false}"#,
            r#"{"model":"llama3","message":{"role":"assistant","content":" world"},"done":false}"#,
        ]);
        assert_eq!(out.len(), 2);
        if let StreamEvent::Text { delta } = &out[0] {
            assert_eq!(delta, "Hello");
        } else {
            panic!("expected text");
        }
        if let StreamEvent::Text { delta } = &out[1] {
            assert_eq!(delta, " world");
        }
    }

    #[test]
    fn done_line_with_stop_becomes_end_turn() {
        let out = events(&[
            r#"{"model":"llama3","done":true,"done_reason":"stop","total_duration":123}"#,
        ]);
        assert_eq!(out.len(), 1);
        let StreamEvent::Done { stop_reason } = &out[0] else {
            panic!("expected done");
        };
        assert_eq!(stop_reason, "end_turn");
    }

    #[test]
    fn done_line_with_length_becomes_max_tokens() {
        let out = events(&[r#"{"model":"llama3","done":true,"done_reason":"length"}"#]);
        let StreamEvent::Done { stop_reason } = &out[0] else {
            panic!("expected done");
        };
        assert_eq!(stop_reason, "max_tokens");
    }

    #[test]
    fn error_line_becomes_an_error_event() {
        let out = events(&[r#"{"error":"model llama3 not found, try pulling it"}"#]);
        assert_eq!(out.len(), 1);
        let StreamEvent::Error { message } = &out[0] else {
            panic!("expected error");
        };
        assert_eq!(message, "model llama3 not found, try pulling it");
    }

    #[test]
    fn empty_content_deltas_are_skipped() {
        let out = events(&[
            r#"{"model":"llama3","message":{"role":"assistant","content":""},"done":false}"#,
        ]);
        assert_eq!(out.len(), 0);
    }

    #[test]
    fn malformed_line_emits_a_warning_not_an_error() {
        let out = events(&["not json at all"]);
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], StreamEvent::Warning { .. }));
    }

    #[test]
    fn build_request_body_folds_system_role_into_top_level_system() {
        use crate::agent::anthropic::{Message, MessageContent, MessageRole, StreamInput};
        let input = StreamInput {
            model: "llama3".into(),
            messages: vec![
                Message {
                    role: MessageRole::System,
                    content: MessageContent::Text("be terse".into()),
                    tool_call_id: None,
                },
                Message {
                    role: MessageRole::User,
                    content: MessageContent::Text("hello".into()),
                    tool_call_id: None,
                },
            ],
            tools: vec![],
            system: None,
            max_tokens: 512,
        };
        let body = build_request_body(&input).unwrap();
        assert_eq!(body["model"], "llama3");
        assert_eq!(body["system"], "be terse");
        assert_eq!(body["stream"], true);
        assert_eq!(body["options"]["num_predict"], 512);
        let messages = body["messages"].as_array().unwrap();
        // System-role message is filtered out — it's on the
        // top-level `system` field instead.
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "hello");
    }

    #[test]
    fn build_request_body_concatenates_explicit_and_role_system() {
        use crate::agent::anthropic::{Message, MessageContent, MessageRole, StreamInput};
        let input = StreamInput {
            model: "llama3".into(),
            messages: vec![Message {
                role: MessageRole::System,
                content: MessageContent::Text("second".into()),
                tool_call_id: None,
            }],
            tools: vec![],
            system: Some("first".into()),
            max_tokens: 512,
        };
        let body = build_request_body(&input).unwrap();
        assert_eq!(body["system"], "first\n\nsecond");
    }
}
