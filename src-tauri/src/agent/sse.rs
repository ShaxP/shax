//! SSE (Server-Sent Events) line parser.
//!
//! Anthropic's streaming API uses SSE. Each event is a set
//! of lines terminated by a blank line:
//!
//!   event: content_block_delta
//!   data: {"type":"content_block_delta", ...}
//!
//! We only care about `data:` values (the JSON is
//! self-describing via a `type` field). The `event:` line
//! is informative but redundant; we still expose it so
//! callers or tests can assert on it if they want.

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SseLine {
    pub event: Option<String>,
    pub data: Option<String>,
}

/// Parse an SSE frame — a chunk delimited by `\n\n` — into
/// its constituent (event, data) pairs. Multi-line `data:`
/// fields are joined with `\n` per the SSE spec.
///
/// One frame may hold multiple *lines* but by convention
/// only one `event` and one `data` per frame. We're relaxed:
/// consecutive `data:` lines accumulate, and each blank line
/// within the frame flushes.
pub fn parse_sse_lines(frame: &str) -> Vec<SseLine> {
    let mut out = Vec::new();
    let mut current = SseLine::default();
    let mut data_buffer: Vec<String> = Vec::new();
    let mut has_field = false;
    for raw_line in frame.split('\n') {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            if has_field {
                if !data_buffer.is_empty() {
                    current.data = Some(data_buffer.join("\n"));
                }
                out.push(std::mem::take(&mut current));
                data_buffer.clear();
                has_field = false;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix(":") {
            // SSE comment lines start with `:` — ignore.
            let _ = rest;
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => {
                current.event = Some(value.to_string());
                has_field = true;
            }
            "data" => {
                data_buffer.push(value.to_string());
                has_field = true;
            }
            _ => {
                // id / retry / unknown fields — ignore.
            }
        }
    }
    // Flush the final line if the frame didn't end with a
    // blank line (shouldn't happen mid-stream, but be safe).
    if has_field {
        if !data_buffer.is_empty() {
            current.data = Some(data_buffer.join("\n"));
        }
        out.push(current);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_event_and_data_pair() {
        let frame = "event: message_start\ndata: {\"foo\":1}\n\n";
        let lines = parse_sse_lines(frame);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].event.as_deref(), Some("message_start"));
        assert_eq!(lines[0].data.as_deref(), Some("{\"foo\":1}"));
    }

    #[test]
    fn joins_multi_line_data_with_newlines() {
        let frame = "event: e\ndata: line one\ndata: line two\n\n";
        let lines = parse_sse_lines(frame);
        assert_eq!(lines[0].data.as_deref(), Some("line one\nline two"));
    }

    #[test]
    fn ignores_comment_and_unknown_fields() {
        let frame = ": ping\nid: 5\ndata: hi\n\n";
        let lines = parse_sse_lines(frame);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].data.as_deref(), Some("hi"));
    }

    #[test]
    fn handles_multiple_events_in_one_frame() {
        let frame = "event: a\ndata: 1\n\nevent: b\ndata: 2\n\n";
        let lines = parse_sse_lines(frame);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].event.as_deref(), Some("a"));
        assert_eq!(lines[1].event.as_deref(), Some("b"));
    }

    #[test]
    fn tolerates_missing_space_after_colon() {
        let frame = "data:{\"x\":1}\n\n";
        let lines = parse_sse_lines(frame);
        assert_eq!(lines[0].data.as_deref(), Some("{\"x\":1}"));
    }

    #[test]
    fn strips_carriage_returns() {
        let frame = "event: x\r\ndata: y\r\n\r\n";
        let lines = parse_sse_lines(frame);
        assert_eq!(lines[0].event.as_deref(), Some("x"));
        assert_eq!(lines[0].data.as_deref(), Some("y"));
    }
}
