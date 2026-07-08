//! Claude Code CLI transport — subscription lane (M6 slice 2b).
//!
//! Drives the user's locally installed `claude` binary as a
//! child process. Per the hard licensing rule in spec §09
//! third-party apps must not proxy Claude subscriptions —
//! the only permitted path is to invoke the user's own local
//! install, which handles its own auth. That's exactly what
//! this module does: no token handling in Shax, no OAuth
//! flow, we just `Command::new("claude")` and stream events.
//!
//! MVP scope (slice 2b):
//!   - Non-interactive one-shot: `claude -p --output-format
//!     stream-json` per turn, prompt on stdin.
//!   - Text-only turns. Tools + subagents left `false` on
//!     the provider's declared capabilities until we sort
//!     out how tool proposals from the CLI thread through
//!     the safety gate.
//!   - Multi-turn conversations are folded into a single
//!     formatted prompt (Human: / Assistant: style). Proper
//!     stream-json input format is a follow-up.

use serde::Deserialize;
use std::process::Stdio;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::anthropic::{MessageContent, MessageRole, StreamEvent, StreamInput};

const CLI_BINARY: &str = "claude";

#[derive(Debug, Error)]
pub enum CliError {
    #[error("claude CLI not installed on PATH")]
    NotInstalled,
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("cli exited with error: {0}")]
    Exit(String),
}

impl From<std::io::Error> for CliError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            CliError::NotInstalled
        } else {
            CliError::Io(e.to_string())
        }
    }
}

// --- Probe -------------------------------------------------

/// Check whether the `claude` CLI is on PATH. Returns the
/// reported version string on success — used by the settings
/// UI to show "Claude Code v1.2.3 detected" vs a "not
/// installed, install Claude Code to use this lane" hint.
pub async fn probe() -> Result<Option<String>, CliError> {
    let output = Command::new(CLI_BINARY).arg("--version").output().await;
    match output {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(Some(version))
        }
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// --- Streaming ---------------------------------------------

/// Spawn the CLI, send the folded prompt on stdin, stream
/// JSON events off stdout and translate them into our
/// `StreamEvent` shape.
pub async fn stream_via_cli<F>(input: StreamInput, mut emit: F) -> Result<(), CliError>
where
    F: FnMut(StreamEvent),
{
    let prompt = fold_prompt(&input);

    let mut child = Command::new(CLI_BINARY)
        .args([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            // Emits per-token stream_event frames wrapping the
            // raw Anthropic SSE. Without this flag Claude Code
            // only emits one `assistant` event at the END of
            // the message, so the chat bubble stays empty
            // during generation. Supported on recent Claude
            // Code — older versions fail with an unknown-flag
            // error which we translate below into an upgrade
            // hint.
            "--include-partial-messages",
            "--model",
            &input.model,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CliError::NotInstalled
            } else {
                CliError::Spawn(e.to_string())
            }
        })?;

    // Feed the prompt on stdin.
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await.ok();
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CliError::Io("no stdout".into()))?;
    let mut lines = BufReader::new(stdout).lines();

    let mut assembler = CliAssembler::default();
    while let Ok(Some(line)) = lines.next_line().await {
        assembler.consume(&line, &mut emit);
    }

    // Drain stderr for diagnostics if the process failed. We
    // don't stream stderr live — Claude Code writes progress
    // hints there that would clutter the assistant surface.
    let mut stderr_buf = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let mut reader = BufReader::new(&mut stderr);
        // Best-effort read; ignore errors.
        let _ = reader.read_to_string(&mut stderr_buf).await;
    }

    let status = child.wait().await?;
    if !status.success() {
        let raw = if stderr_buf.trim().is_empty() {
            format!("claude CLI exited with status {}", status)
        } else {
            stderr_buf.trim().to_string()
        };
        let message = translate_cli_error(&raw);
        emit(StreamEvent::Error {
            message: message.clone(),
        });
        emit(StreamEvent::Done {
            stop_reason: "error".into(),
        });
        return Err(CliError::Exit(message));
    }

    // Emit a terminating Done if the CLI didn't itself
    // (e.g. older versions or missing result event).
    if !assembler.emitted_done {
        emit(StreamEvent::Done {
            stop_reason: assembler.stop_reason.unwrap_or_else(|| "end_turn".into()),
        });
    }

    Ok(())
}

// --- Prompt folding ----------------------------------------

/// Collapse a full message history into a single prompt
/// string suitable for `claude -p`. MVP: use "Human:" /
/// "Assistant:" markers. When a system message is present
/// it's placed at the top with a "System:" marker.
///
/// Tool calls / results are not folded — they're written
/// as inline pseudo-JSON so the model at least sees what
/// happened, but the CLI's own tool loop is what will
/// actually invoke tools once we wire that up.
pub fn fold_prompt(input: &StreamInput) -> String {
    let mut out = String::new();
    if let Some(system) = &input.system {
        out.push_str("System: ");
        out.push_str(system);
        out.push_str("\n\n");
    }
    for m in &input.messages {
        let (label, text) = match m.role {
            MessageRole::System => ("System", content_as_text(&m.content)),
            MessageRole::User => ("Human", content_as_text(&m.content)),
            MessageRole::Assistant => ("Assistant", content_as_text(&m.content)),
            MessageRole::Tool => {
                let id = m.tool_call_id.as_deref().unwrap_or("");
                (
                    "Tool result",
                    format!("(for {}): {}", id, content_as_text(&m.content)),
                )
            }
        };
        out.push_str(label);
        out.push_str(": ");
        out.push_str(&text);
        out.push_str("\n\n");
    }
    out.push_str("Assistant: ");
    out
}

fn content_as_text(c: &MessageContent) -> String {
    match c {
        MessageContent::Text(t) => t.clone(),
        MessageContent::Blocks(blocks) => {
            let mut out = String::new();
            for b in blocks {
                match b {
                    super::anthropic::ContentBlock::Text { text } => out.push_str(text),
                    super::anthropic::ContentBlock::ToolUse { name, input, .. } => {
                        out.push_str(&format!(
                            "\n[tool_use {}({})]\n",
                            name,
                            serde_json::to_string(input).unwrap_or_default()
                        ));
                    }
                    super::anthropic::ContentBlock::ToolResult { content, .. } => {
                        out.push_str(&format!("\n[tool_result: {}]\n", content));
                    }
                }
            }
            out
        }
    }
}

// --- CLI JSON assembler ------------------------------------

/// Claude Code's `stream-json` output is newline-delimited
/// JSON events. We handle:
///
///   - `system` events with subtype `init` — session info,
///     ignored.
///   - `stream_event` events wrap the raw Anthropic SSE
///     (`content_block_start`, `content_block_delta`,
///     `content_block_stop`, `message_delta`, `message_stop`).
///     This is the per-token stream — only present when the
///     CLI was launched with `--include-partial-messages`.
///     Text arrives via `text_delta`; tool-use arguments
///     accumulate across `input_json_delta` fragments and
///     emit as a single `ToolCall` on
///     `content_block_stop`.
///   - `assistant` events carry a fully-assembled message.
///     We use it as a fallback: if `stream_event` frames
///     already delivered the content we skip re-emission,
///     otherwise (old CLI, no partial-messages support) we
///     emit the whole message as one big chunk.
///   - `result` events carry the final `stop_reason`.
///
/// Unknown types are ignored so the assembler is tolerant
/// of Claude Code version drift.
#[derive(Default)]
struct CliAssembler {
    stop_reason: Option<String>,
    emitted_done: bool,
    /// True as soon as any `stream_event` frame has delivered
    /// content. When set, we skip content extraction from the
    /// final `assistant` event to avoid duplicating text.
    saw_stream_event: bool,
    /// Tool-use blocks under construction, keyed by index.
    /// Populated by `content_block_start`, appended via
    /// `content_block_delta.input_json_delta`, and flushed as
    /// a `ToolCall` on `content_block_stop`.
    tool_use_by_index: std::collections::HashMap<u32, ToolUseAccumulator>,
}

#[derive(Default, Clone)]
struct ToolUseAccumulator {
    id: String,
    name: String,
    input_json: String,
}

impl CliAssembler {
    fn consume<F>(&mut self, line: &str, emit: &mut F)
    where
        F: FnMut(StreamEvent),
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        let payload: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                // Not JSON — likely a progress line from the
                // CLI in --verbose mode. Ignore silently.
                return;
            }
        };
        let event_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match event_type {
            "stream_event" => {
                if let Some(inner) = payload.get("event") {
                    self.consume_inner_stream_event(inner, emit);
                }
            }
            "assistant" => {
                if self.saw_stream_event {
                    // stream_event frames already delivered
                    // everything — the final message is a
                    // recap we don't need to re-emit. Just
                    // capture the stop_reason if present.
                    if let Some(stop) = payload
                        .get("message")
                        .and_then(|m| m.get("stop_reason"))
                        .and_then(|s| s.as_str())
                    {
                        self.stop_reason = Some(stop.to_string());
                    }
                    return;
                }
                let Some(message) = payload.get("message") else {
                    return;
                };
                let Some(content) = message.get("content").and_then(|c| c.as_array()) else {
                    return;
                };
                for block in content {
                    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    match block_type {
                        "text" => {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                emit(StreamEvent::Text {
                                    delta: text.to_string(),
                                });
                            }
                        }
                        "tool_use" => {
                            let id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let input =
                                block.get("input").cloned().unwrap_or(serde_json::json!({}));
                            emit(StreamEvent::ToolCall { id, name, input });
                        }
                        _ => {}
                    }
                }
                if let Some(stop) = message.get("stop_reason").and_then(|s| s.as_str()) {
                    self.stop_reason = Some(stop.to_string());
                }
            }
            "result" => {
                // Claude Code's result event carries the final
                // stop_reason + usage. We forward stop_reason,
                // ignore usage.
                let stop = payload
                    .get("subtype")
                    .and_then(|s| s.as_str())
                    .map(|s| match s {
                        "success" => "end_turn".to_string(),
                        other => other.to_string(),
                    })
                    .or_else(|| self.stop_reason.take())
                    .unwrap_or_else(|| "end_turn".into());
                emit(StreamEvent::Done { stop_reason: stop });
                self.emitted_done = true;
            }
            "error" => {
                let msg = payload
                    .get("message")
                    .and_then(|m| m.as_str())
                    .or_else(|| {
                        payload
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                    })
                    .unwrap_or("unknown CLI error");
                emit(StreamEvent::Error {
                    message: msg.to_string(),
                });
            }
            _ => {
                // system/init, user echo, unknown — ignore.
            }
        }
    }

    /// Handle the raw Anthropic-shaped event nested inside a
    /// `stream_event` frame. Mirrors what the API-key lane
    /// does in `anthropic::EventAssembler` — text deltas
    /// flow, tool_use accumulates across
    /// `input_json_delta` and emits on `content_block_stop`,
    /// stop_reason lands on `message_delta`.
    fn consume_inner_stream_event<F>(&mut self, inner: &serde_json::Value, emit: &mut F)
    where
        F: FnMut(StreamEvent),
    {
        let inner_type = inner.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match inner_type {
            "content_block_start" => {
                let index = inner.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if let Some(block) = inner.get("content_block") {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        let id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        self.tool_use_by_index.insert(
                            index,
                            ToolUseAccumulator {
                                id,
                                name,
                                input_json: String::new(),
                            },
                        );
                    }
                }
            }
            "content_block_delta" => {
                let index = inner.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let Some(delta) = inner.get("delta") else {
                    return;
                };
                let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match delta_type {
                    "text_delta" => {
                        if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                self.saw_stream_event = true;
                                emit(StreamEvent::Text {
                                    delta: text.to_string(),
                                });
                            }
                        }
                    }
                    "input_json_delta" => {
                        if let Some(partial) = delta.get("partial_json").and_then(|v| v.as_str()) {
                            let entry = self.tool_use_by_index.entry(index).or_default();
                            entry.input_json.push_str(partial);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = inner.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if let Some(acc) = self.tool_use_by_index.remove(&index) {
                    let input: serde_json::Value = if acc.input_json.is_empty() {
                        serde_json::json!({})
                    } else {
                        match serde_json::from_str(&acc.input_json) {
                            Ok(v) => v,
                            Err(_) => serde_json::json!({}),
                        }
                    };
                    self.saw_stream_event = true;
                    emit(StreamEvent::ToolCall {
                        id: acc.id,
                        name: acc.name,
                        input,
                    });
                }
            }
            "message_delta" => {
                if let Some(stop) = inner
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(|s| s.as_str())
                {
                    self.stop_reason = Some(stop.to_string());
                }
            }
            _ => {
                // message_start / message_stop / ping — ignore.
            }
        }
    }
}

/// Translate raw CLI stderr text into a message that guides
/// the user. Right now we recognise one important case: an
/// unknown-flag error for `--include-partial-messages` means
/// the user is on an older Claude Code version that doesn't
/// support per-token streaming. Every other stderr passes
/// through unchanged.
fn translate_cli_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("include-partial-messages")
        && (lower.contains("unknown")
            || lower.contains("unrecognized")
            || lower.contains("unrecognised")
            || lower.contains("invalid"))
    {
        return format!(
            "Your Claude Code version doesn't support --include-partial-messages, which Shax uses \
             for per-token streaming. Please update Claude Code to the latest version (run \
             `claude update`, or reinstall from https://claude.com/download) and try again.\n\n\
             Original error:\n{raw}"
        );
    }
    raw.to_string()
}

// --- Version reporting from the CLI probe ------------------

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ClaudeCodeSystemInit {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    tools: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::anthropic::{Message, MessageContent, MessageRole};

    fn events(lines: &[&str]) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        let mut asm = CliAssembler::default();
        for line in lines {
            asm.consume(line, &mut |e| out.push(e));
        }
        out
    }

    #[test]
    fn text_content_block_becomes_a_text_event() {
        let out = events(&[
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}"#,
        ]);
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], StreamEvent::Text { .. }));
        if let StreamEvent::Text { delta } = &out[0] {
            assert_eq!(delta, "Hello world");
        }
    }

    #[test]
    fn tool_use_content_block_becomes_a_tool_call_event() {
        let out = events(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"run","input":{"cmd":"ls"}}]}}"#,
        ]);
        assert_eq!(out.len(), 1);
        let StreamEvent::ToolCall { id, name, input } = &out[0] else {
            panic!("expected tool_call");
        };
        assert_eq!(id, "tu_1");
        assert_eq!(name, "run");
        assert_eq!(input, &serde_json::json!({"cmd": "ls"}));
    }

    #[test]
    fn result_event_becomes_a_done_event_with_end_turn_on_success() {
        let out = events(&[r#"{"type":"result","subtype":"success","result":"ok"}"#]);
        assert_eq!(out.len(), 1);
        let StreamEvent::Done { stop_reason } = &out[0] else {
            panic!("expected done");
        };
        assert_eq!(stop_reason, "end_turn");
    }

    #[test]
    fn error_event_becomes_an_error_event() {
        let out = events(&[r#"{"type":"error","message":"rate limited"}"#]);
        assert_eq!(out.len(), 1);
        let StreamEvent::Error { message } = &out[0] else {
            panic!("expected error");
        };
        assert_eq!(message, "rate limited");
    }

    #[test]
    fn ignores_system_init_and_unknown_events() {
        let out = events(&[
            r#"{"type":"system","subtype":"init","session_id":"abc"}"#,
            r#"{"type":"future_unknown_event","foo":"bar"}"#,
        ]);
        assert_eq!(out.len(), 0);
    }

    #[test]
    fn stream_event_text_deltas_emit_text_events() {
        let out = events(&[
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
        ]);
        assert_eq!(out.len(), 2);
        let StreamEvent::Text { delta: d1 } = &out[0] else {
            panic!("expected text");
        };
        let StreamEvent::Text { delta: d2 } = &out[1] else {
            panic!("expected text");
        };
        assert_eq!(d1, "Hello ");
        assert_eq!(d2, "world");
    }

    #[test]
    fn stream_event_dedupes_final_assistant_recap() {
        // When stream_event frames have already delivered
        // text deltas, the final `assistant` recap event
        // must NOT re-emit the same text.
        let out = events(&[
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}],"stop_reason":"end_turn"}}"#,
            r#"{"type":"result","subtype":"success"}"#,
        ]);
        let text_events: Vec<&StreamEvent> = out
            .iter()
            .filter(|e| matches!(e, StreamEvent::Text { .. }))
            .collect();
        assert_eq!(text_events.len(), 1);
        if let StreamEvent::Text { delta } = text_events[0] {
            assert_eq!(delta, "Hi");
        }
    }

    #[test]
    fn stream_event_tool_use_accumulates_across_deltas_and_emits_on_stop() {
        let out = events(&[
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_2","name":"run_bash"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"cmd\":\""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ls\"}"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
        ]);
        assert_eq!(out.len(), 1);
        let StreamEvent::ToolCall { id, name, input } = &out[0] else {
            panic!("expected tool_call");
        };
        assert_eq!(id, "tu_2");
        assert_eq!(name, "run_bash");
        assert_eq!(input, &serde_json::json!({"cmd": "ls"}));
    }

    #[test]
    fn old_cli_without_stream_event_falls_back_to_assistant_message() {
        // Older Claude Code (no --include-partial-messages
        // support) sends only assistant + result. We MUST still
        // emit text so the user sees something — better than
        // silence.
        let out = events(&[
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Batched"}],"stop_reason":"end_turn"}}"#,
            r#"{"type":"result","subtype":"success"}"#,
        ]);
        let StreamEvent::Text { delta } = &out[0] else {
            panic!("expected text");
        };
        assert_eq!(delta, "Batched");
    }

    #[test]
    fn translate_cli_error_hints_upgrade_when_unknown_partial_messages_flag() {
        let raw = "error: unknown option '--include-partial-messages'";
        let out = translate_cli_error(raw);
        assert!(out.contains("update Claude Code"));
        assert!(out.contains(raw));
    }

    #[test]
    fn translate_cli_error_passes_through_unrelated_stderr() {
        let raw = "error: model not found: sonnet-4-6";
        let out = translate_cli_error(raw);
        assert_eq!(out, raw);
    }

    #[test]
    fn ignores_progress_lines_that_arent_json() {
        let out = events(&[
            "loading model claude-sonnet-4-6…",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}"#,
        ]);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn fold_prompt_labels_roles_correctly() {
        let input = StreamInput {
            model: "claude-sonnet-4-6".into(),
            messages: vec![
                Message {
                    role: MessageRole::User,
                    content: MessageContent::Text("hello".into()),
                    tool_call_id: None,
                },
                Message {
                    role: MessageRole::Assistant,
                    content: MessageContent::Text("hi".into()),
                    tool_call_id: None,
                },
                Message {
                    role: MessageRole::User,
                    content: MessageContent::Text("how are you?".into()),
                    tool_call_id: None,
                },
            ],
            tools: vec![],
            system: Some("be terse".into()),
            max_tokens: 1024,
        };
        let prompt = fold_prompt(&input);
        assert!(prompt.starts_with("System: be terse"));
        assert!(prompt.contains("Human: hello"));
        assert!(prompt.contains("Assistant: hi"));
        assert!(prompt.contains("Human: how are you?"));
        // Trailing "Assistant: " primes the model.
        assert!(prompt.ends_with("Assistant: "));
    }

    #[test]
    fn fold_prompt_labels_tool_results() {
        let input = StreamInput {
            model: "claude-sonnet-4-6".into(),
            messages: vec![Message {
                role: MessageRole::Tool,
                content: MessageContent::Text("42".into()),
                tool_call_id: Some("tu_1".into()),
            }],
            tools: vec![],
            system: None,
            max_tokens: 1024,
        };
        let prompt = fold_prompt(&input);
        assert!(prompt.contains("Tool result: (for tu_1): 42"));
    }
}
