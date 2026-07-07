//! Anthropic Messages API client.
//!
//! Minimal HTTP + SSE client for the Anthropic `/v1/messages`
//! endpoint. Handles streaming responses and translates the
//! wire events into our internal `StreamEvent` shape so the
//! renderer sees the same shape regardless of provider.
//!
//! Kept in Rust (per M6 slice 2a's "SDK in Rust proxy"
//! decision) so the API key never crosses the IPC boundary.
//! The renderer sends messages + tools; Rust holds the key,
//! calls Anthropic, and streams events back over a Tauri
//! `Channel`.
//!
//! No retries yet — a network hiccup ends the stream with an
//! `error` event. Retries + rate-limit backoff are follow-ups
//! (spec §09 says "understated by default" — mid-stream
//! error surfaces are honest information for the user).

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::sse::parse_sse_lines;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

// --- Public request / response shapes ---------------------

/// Input to `stream_messages`. Mirrors the internal
/// `StreamInput` shape defined on the TS side (see
/// `src/assistant/provider.ts`). Kept simple — no tool_choice
/// or top_p / top_k plumbing yet; they'd be pass-throughs
/// when needed.
#[derive(Debug, Deserialize)]
pub struct StreamInput {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Vec<Tool>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

fn default_max_tokens() -> u32 {
    4096
}

/// One turn in the conversation. `role` = `system` | `user`
/// | `assistant` | `tool`. Anthropic's actual API only
/// accepts `user` and `assistant` at the top level — `system`
/// is folded into a separate field and `tool` is embedded as
/// a tool-result content block. We do the translation in
/// `build_request_body`.
#[derive(Debug, Deserialize)]
pub struct Message {
    pub role: MessageRole,
    pub content: MessageContent,
    /// Set when `role = "tool"`: the `id` of the tool_use
    /// this message is answering. Anthropic wants this on the
    /// content block, not the top-level message.
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

/// Simple content — either plain text or a pre-structured
/// list of content blocks. Assistant turns that carried tool
/// calls will come back through here as content blocks so
/// we can round-trip them into the next request.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
    },
}

/// A tool the model may call. Follows Anthropic's shape
/// directly (spec §09 "tools defined once in Anthropic's
/// schema").
#[derive(Debug, Deserialize, Serialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// Events streamed back to the caller. Callers (Tauri
/// commands) forward these over a `Channel<StreamEvent>` to
/// the renderer.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEvent {
    /// A text fragment arrived. The renderer appends.
    Text { delta: String },
    /// The model wants to call a tool. Renderer routes this
    /// through the safety gate before the tool implementation
    /// is invoked (spec §10 chokepoint).
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// A non-fatal warning (e.g. content-block parsing hiccup).
    Warning { message: String },
    /// A fatal error. Stream is over.
    Error { message: String },
    /// Stream finished normally. `stop_reason` matches
    /// Anthropic's — `end_turn` / `tool_use` / `max_tokens` /
    /// `error`.
    Done { stop_reason: String },
}

#[derive(Debug, Error)]
pub enum AnthropicError {
    #[error("http error: {0}")]
    Http(String),
    #[error("api error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("json error: {0}")]
    Json(String),
}

impl From<reqwest::Error> for AnthropicError {
    fn from(e: reqwest::Error) -> Self {
        AnthropicError::Http(e.to_string())
    }
}

impl From<serde_json::Error> for AnthropicError {
    fn from(e: serde_json::Error) -> Self {
        AnthropicError::Json(e.to_string())
    }
}

// --- Public streaming entry point --------------------------

/// Send a Messages request with `stream: true` and pipe SSE
/// events to `emit`. Returns when the stream completes (or
/// the caller returned an error from `emit`).
///
/// `emit` is any closure that consumes `StreamEvent`. Kept
/// generic so tests can accumulate to a Vec without touching
/// Tauri, and the real caller in `commands.rs` forwards to a
/// `Channel<StreamEvent>`.
pub async fn stream_messages<F>(
    api_key: &str,
    input: StreamInput,
    mut emit: F,
) -> Result<(), AnthropicError>
where
    F: FnMut(StreamEvent),
{
    let client = reqwest::Client::new();
    let body = build_request_body(&input)?;
    let response = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let message = extract_error_message(&text).unwrap_or(text);
        emit(StreamEvent::Error {
            message: format!("HTTP {}: {}", status.as_u16(), message),
        });
        return Err(AnthropicError::Api {
            status: status.as_u16(),
            message,
        });
    }

    stream_body(response, &mut emit).await
}

async fn stream_body<F>(response: reqwest::Response, emit: &mut F) -> Result<(), AnthropicError>
where
    F: FnMut(StreamEvent),
{
    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut assembler = EventAssembler::default();

    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        // SSE frames are separated by `\n\n`. Split on that
        // boundary and process each complete frame; keep the
        // trailing partial (if any) in the buffer for the
        // next iteration.
        while let Some(idx) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..idx + 2).collect();
            for line in parse_sse_lines(&frame) {
                assembler.consume_line(&line, emit);
            }
        }
    }
    if !buffer.is_empty() {
        for line in parse_sse_lines(&buffer) {
            assembler.consume_line(&line, emit);
        }
    }
    Ok(())
}

// --- Request-body construction -----------------------------

fn build_request_body(input: &StreamInput) -> Result<serde_json::Value, AnthropicError> {
    // Anthropic wants `system` as a top-level field, not a
    // message. Fold any `system` role message plus an explicit
    // `system` field into one string.
    let mut system_text = String::new();
    if let Some(sys) = &input.system {
        system_text.push_str(sys);
    }
    let mut messages_out: Vec<serde_json::Value> = Vec::new();
    for m in &input.messages {
        match m.role {
            MessageRole::System => {
                if let MessageContent::Text(t) = &m.content {
                    if !system_text.is_empty() {
                        system_text.push_str("\n\n");
                    }
                    system_text.push_str(t);
                }
            }
            MessageRole::User => {
                messages_out.push(serde_json::json!({
                    "role": "user",
                    "content": message_content_to_json(&m.content, None)?,
                }));
            }
            MessageRole::Assistant => {
                messages_out.push(serde_json::json!({
                    "role": "assistant",
                    "content": message_content_to_json(&m.content, None)?,
                }));
            }
            MessageRole::Tool => {
                let tool_use_id = m.tool_call_id.clone().ok_or_else(|| {
                    AnthropicError::Json("tool message missing tool_call_id".into())
                })?;
                let content_text = match &m.content {
                    MessageContent::Text(t) => t.clone(),
                    MessageContent::Blocks(_) => {
                        return Err(AnthropicError::Json(
                            "tool message content must be plain text".into(),
                        ));
                    }
                };
                messages_out.push(serde_json::json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": content_text,
                    }],
                }));
            }
        }
    }
    let mut body = serde_json::json!({
        "model": input.model,
        "max_tokens": input.max_tokens,
        "stream": true,
        "messages": messages_out,
    });
    if !system_text.is_empty() {
        body["system"] = serde_json::Value::String(system_text);
    }
    if !input.tools.is_empty() {
        body["tools"] = serde_json::to_value(&input.tools)?;
    }
    Ok(body)
}

fn message_content_to_json(
    content: &MessageContent,
    _tool_call_id: Option<&str>,
) -> Result<serde_json::Value, AnthropicError> {
    match content {
        MessageContent::Text(t) => Ok(serde_json::Value::String(t.clone())),
        MessageContent::Blocks(blocks) => Ok(serde_json::to_value(blocks)?),
    }
}

fn extract_error_message(body: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    parsed
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

// --- SSE event assembly ------------------------------------

/// Anthropic's stream sends `content_block_start` /
/// `content_block_delta` / `content_block_stop` events. Text
/// blocks come in as `text_delta`, tool-use blocks arrive as
/// `input_json_delta` fragments that we accumulate and parse
/// only on stop. This assembler manages that state.
#[derive(Default)]
struct EventAssembler {
    /// Per content-block index: accumulated tool-use input as
    /// raw JSON string.
    tool_use_by_index: std::collections::HashMap<u32, ToolUseAccumulator>,
    /// Delivered stop_reason (only known on `message_delta`).
    stop_reason: Option<String>,
}

#[derive(Default, Clone)]
struct ToolUseAccumulator {
    id: String,
    name: String,
    input_json: String,
}

impl EventAssembler {
    fn consume_line<F>(&mut self, line: &super::sse::SseLine, emit: &mut F)
    where
        F: FnMut(StreamEvent),
    {
        // Only `data:` lines carry payload — event: lines are
        // routed by the JSON's own `type` field.
        let Some(data) = &line.data else { return };
        let payload: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(e) => {
                emit(StreamEvent::Warning {
                    message: format!("malformed SSE payload: {e}"),
                });
                return;
            }
        };
        let event_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match event_type {
            "content_block_start" => {
                let index = payload.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if let Some(block) = payload.get("content_block") {
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
                let index = payload.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let Some(delta) = payload.get("delta") else {
                    return;
                };
                let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match delta_type {
                    "text_delta" => {
                        if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                            emit(StreamEvent::Text {
                                delta: text.to_string(),
                            });
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
                let index = payload.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if let Some(acc) = self.tool_use_by_index.remove(&index) {
                    let input: serde_json::Value = if acc.input_json.is_empty() {
                        serde_json::json!({})
                    } else {
                        match serde_json::from_str(&acc.input_json) {
                            Ok(v) => v,
                            Err(e) => {
                                emit(StreamEvent::Warning {
                                    message: format!("tool_use input parse: {e}"),
                                });
                                serde_json::json!({})
                            }
                        }
                    };
                    emit(StreamEvent::ToolCall {
                        id: acc.id,
                        name: acc.name,
                        input,
                    });
                }
            }
            "message_delta" => {
                if let Some(stop) = payload
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(|s| s.as_str())
                {
                    self.stop_reason = Some(stop.to_string());
                }
            }
            "message_stop" => {
                let stop_reason = self.stop_reason.take().unwrap_or_else(|| "end_turn".into());
                emit(StreamEvent::Done { stop_reason });
            }
            "error" => {
                let msg = payload
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown stream error");
                emit(StreamEvent::Error {
                    message: msg.to_string(),
                });
            }
            _ => {
                // ping, content_block_start on text, etc. — ignore.
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn drain_events<F>(frames: &[&str], mut _f: F) -> Vec<StreamEvent>
    where
        F: FnMut(&mut EventAssembler),
    {
        let mut events = Vec::new();
        let mut asm = EventAssembler::default();
        for frame in frames {
            for line in super::super::sse::parse_sse_lines(frame) {
                asm.consume_line(&line, &mut |e| events.push(e));
            }
        }
        events
    }

    #[test]
    fn text_deltas_flow_through_as_text_events() {
        let events = drain_events(
            &[
                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello \"}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"world\"}}\n\n",
                "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
                "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
            ],
            |_| {},
        );
        assert!(matches!(events[0], StreamEvent::Text { .. }));
        assert!(matches!(events[1], StreamEvent::Text { .. }));
        assert!(matches!(events[2], StreamEvent::Done { .. }));
        if let StreamEvent::Text { delta } = &events[0] {
            assert_eq!(delta, "Hello ");
        }
        if let StreamEvent::Done { stop_reason } = &events[2] {
            assert_eq!(stop_reason, "end_turn");
        }
    }

    #[test]
    fn tool_use_input_accumulates_across_deltas_and_emits_on_stop() {
        let events = drain_events(
            &[
                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"run_bash\"}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"cmd\\\":\\\"\"}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"git status\\\"}\"}}\n\n",
                "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n",
                "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
            ],
            |_| {},
        );
        // 1 tool_call + 1 done.
        assert_eq!(events.len(), 2);
        let StreamEvent::ToolCall { id, name, input } = &events[0] else {
            panic!("expected tool_call, got {:?}", events[0]);
        };
        assert_eq!(id, "toolu_1");
        assert_eq!(name, "run_bash");
        assert_eq!(input, &json!({"cmd": "git status"}));
    }

    #[test]
    fn stream_error_becomes_an_error_event() {
        let events = drain_events(
            &["event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded\",\"message\":\"try again\"}}\n\n"],
            |_| {},
        );
        assert_eq!(events.len(), 1);
        let StreamEvent::Error { message } = &events[0] else {
            panic!("expected error");
        };
        assert_eq!(message, "try again");
    }

    #[test]
    fn build_request_folds_system_role_into_system_field() {
        let input = StreamInput {
            model: "claude-sonnet-4-6".into(),
            messages: vec![
                Message {
                    role: MessageRole::System,
                    content: MessageContent::Text("you are helpful".into()),
                    tool_call_id: None,
                },
                Message {
                    role: MessageRole::User,
                    content: MessageContent::Text("hi".into()),
                    tool_call_id: None,
                },
            ],
            tools: vec![],
            system: None,
            max_tokens: 1024,
        };
        let body = build_request_body(&input).unwrap();
        assert_eq!(body["system"], "you are helpful");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "hi");
        // No stray system message in the messages array.
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn build_request_translates_tool_role_into_tool_result_content_block() {
        let input = StreamInput {
            model: "claude-sonnet-4-6".into(),
            messages: vec![Message {
                role: MessageRole::Tool,
                content: MessageContent::Text("42".into()),
                tool_call_id: Some("toolu_1".into()),
            }],
            tools: vec![],
            system: None,
            max_tokens: 1024,
        };
        let body = build_request_body(&input).unwrap();
        let msg = &body["messages"][0];
        assert_eq!(msg["role"], "user");
        assert_eq!(msg["content"][0]["type"], "tool_result");
        assert_eq!(msg["content"][0]["tool_use_id"], "toolu_1");
        assert_eq!(msg["content"][0]["content"], "42");
    }

    #[test]
    fn build_request_rejects_tool_message_without_tool_call_id() {
        let input = StreamInput {
            model: "claude-sonnet-4-6".into(),
            messages: vec![Message {
                role: MessageRole::Tool,
                content: MessageContent::Text("42".into()),
                tool_call_id: None,
            }],
            tools: vec![],
            system: None,
            max_tokens: 1024,
        };
        assert!(matches!(
            build_request_body(&input),
            Err(AnthropicError::Json(_))
        ));
    }

    #[test]
    fn build_request_includes_tools_when_provided() {
        let input = StreamInput {
            model: "claude-sonnet-4-6".into(),
            messages: vec![],
            tools: vec![Tool {
                name: "run_bash".into(),
                description: "run a bash command".into(),
                input_schema: json!({"type":"object"}),
            }],
            system: None,
            max_tokens: 1024,
        };
        let body = build_request_body(&input).unwrap();
        assert_eq!(body["tools"][0]["name"], "run_bash");
        assert_eq!(body["tools"][0]["description"], "run a bash command");
    }
}
