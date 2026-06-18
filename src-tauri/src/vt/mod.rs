//! VT escape and OSC 133 parsing, alternate-screen detection.
//!
//! `OscParser` wraps `vte::Parser` and implements `vte::Perform` to observe
//! the byte stream without transforming it. It is observe-only: every byte
//! still reaches xterm.js unchanged via `PtyEvent::Output`.
//!
//! Detected transitions and the plain output bytes between them are reported
//! through the `VtMessage` enum so the block state machine can apply state
//! changes and capture output in the same interleaved order they occurred —
//! which is essential when an OSC 133 C and command output land in the same
//! `read()` chunk.

/// Events the VT layer emits to the block state machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VtEvent {
    /// `ESC [ ? 1049 h` – a program has entered the alternate screen buffer.
    AltScreenEntered,
    /// `ESC [ ? 1049 l` – the program has left the alternate screen buffer.
    AltScreenLeft,
    /// `OSC 133 ; A ST` – prompt start.
    PromptStart,
    /// `OSC 133 ; B ST` – prompt end (command input begins).
    PromptEnd,
    /// `OSC 133 ; C [ ; <cmd> ] ST` – command output begins (preexec).
    /// Shax's zsh integration carries the typed command in the optional third
    /// parameter; older or third-party integrations may emit a bare `C` and
    /// `command` is then `None`. The command may itself contain `;`, so we
    /// re-join all trailing OSC params with `;` when reconstructing it.
    CommandStart { command: Option<String> },
    /// `OSC 133 ; D ; <exit> ST` – command finished with exit code.
    CommandFinished { exit_code: i32 },
}

/// One item in the VT layer's interleaved message stream.
///
/// `Output` carries the plain `print`/`execute` bytes that flowed between
/// escape sequences — the visible part of the stream. `Event` carries a
/// recognised state transition. Consumers walk this stream in order so that
/// a `CommandStart` event flips the block machine to `Running` *before* the
/// command's output bytes are pushed, and a `CommandFinished` event flips it
/// back *after* the trailing bytes are pushed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VtMessage {
    Event(VtEvent),
    Output(Vec<u8>),
}

/// Opaque VT parser that calls `on_message` for each plain-output run and
/// each recognised semantic event, in arrival order.
///
/// Lives entirely inside the reader thread; it is not `Send` or `Sync` by
/// default because `vte::Parser` is not, but that is fine because we never
/// move it across threads.
pub struct OscParser {
    parser: vte::Parser,
    performer: Performer,
}

impl OscParser {
    /// Create a new parser. `on_message` is called synchronously during
    /// `advance()` whenever plain output bytes accumulate or an event is
    /// recognised.
    pub fn new(on_message: impl FnMut(VtMessage) + 'static) -> Self {
        Self {
            parser: vte::Parser::new(),
            performer: Performer {
                on_message: Box::new(on_message),
                pending: Vec::new(),
            },
        }
    }

    /// Feed a chunk of raw PTY bytes through the parser. The caller still
    /// owns and forwards those bytes to the frontend unchanged.
    ///
    /// Any trailing plain bytes accumulated after the last event are flushed
    /// as a final `VtMessage::Output` before this call returns.
    pub fn advance(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.performer, bytes);
        self.performer.flush();
    }
}

// ── Performer ──────────────────────────────────────────────────────────────────

struct Performer {
    on_message: Box<dyn FnMut(VtMessage)>,
    /// Plain `print`/`execute` bytes accumulated since the last flush. Emitted
    /// as a single `VtMessage::Output` whenever an escape sequence dispatches
    /// or `advance()` returns, so the consumer sees output bytes batched and
    /// in the right order relative to events.
    pending: Vec<u8>,
}

impl Performer {
    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let bytes = std::mem::take(&mut self.pending);
        (self.on_message)(VtMessage::Output(bytes));
    }

    fn emit_event(&mut self, event: VtEvent) {
        // Flush any pending plain bytes first so the event lands at the
        // correct position in the interleaved stream.
        self.flush();
        (self.on_message)(VtMessage::Event(event));
    }
}

impl vte::Perform for Performer {
    fn print(&mut self, c: char) {
        let mut buf = [0u8; 4];
        let s = c.encode_utf8(&mut buf);
        self.pending.extend_from_slice(s.as_bytes());
    }

    fn execute(&mut self, byte: u8) {
        // Control bytes (CR, LF, BEL, TAB, …) are part of the visible output.
        self.pending.push(byte);
    }

    // `csi_dispatch` handles CSI sequences like `ESC [ ? 1049 h`.
    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        // We only care about the DEC private mode `?` sequences `h` and `l`.
        if intermediates != [b'?'] {
            return;
        }
        let param_1049 = params.iter().any(|sub| sub.first().copied() == Some(1049));
        if !param_1049 {
            return;
        }
        match action {
            'h' => self.emit_event(VtEvent::AltScreenEntered),
            'l' => self.emit_event(VtEvent::AltScreenLeft),
            _ => {}
        }
    }

    // `osc_dispatch` handles OSC sequences like `OSC 133 ; C ST`.
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.first().copied() != Some(b"133") {
            return;
        }
        let marker = params.get(1).copied().unwrap_or_default();
        match marker {
            b"A" => self.emit_event(VtEvent::PromptStart),
            b"B" => self.emit_event(VtEvent::PromptEnd),
            b"C" => {
                let command = parse_command_param(&params[2..]);
                self.emit_event(VtEvent::CommandStart { command });
            }
            b"D" => {
                let raw = params.get(2).copied().unwrap_or(b"0");
                let code = std::str::from_utf8(raw)
                    .ok()
                    .and_then(|s| s.parse::<i32>().ok())
                    .unwrap_or(0);
                self.emit_event(VtEvent::CommandFinished { exit_code: code });
            }
            _ => {}
        }
    }

    // Required by the trait; no-ops for everything else. These are escape
    // sequences that are not part of the visible output, so we intentionally
    // do not add their bytes to `pending`.
    fn hook(&mut self, _params: &vte::Params, _intermediates: &[u8], _ignore: bool, _c: char) {}
    fn put(&mut self, _byte: u8) {}
    fn unhook(&mut self) {}
    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {}
}

/// Reassemble the command string that lives in OSC 133;C;<cmd...> params.
///
/// vte splits OSC parameters on `;`, so a command like `echo a;echo b` arrives
/// as multiple params. We join them back with `;` and trim a single trailing
/// CR or LF the shell may have included. An empty (or all-empty) tail returns
/// `None`, matching the "bare C" case for shells without command capture.
fn parse_command_param(tail: &[&[u8]]) -> Option<String> {
    if tail.is_empty() {
        return None;
    }
    let mut parts: Vec<&str> = Vec::with_capacity(tail.len());
    for raw in tail {
        // Drop non-UTF-8 fragments rather than mangle them; in practice the
        // shell emits the command verbatim and zsh sources are UTF-8.
        let s = std::str::from_utf8(raw).ok()?;
        parts.push(s);
    }
    let joined = parts.join(";");
    let trimmed = joined.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Feed `bytes` through a fresh parser and return the full interleaved
    /// message stream it emitted.
    fn collect_messages(bytes: &[u8]) -> Vec<VtMessage> {
        let messages: Arc<Mutex<Vec<VtMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let messages_clone = Arc::clone(&messages);
        let mut parser = OscParser::new(move |msg| {
            messages_clone.lock().unwrap().push(msg);
        });
        parser.advance(bytes);
        drop(parser);
        Arc::try_unwrap(messages).unwrap().into_inner().unwrap()
    }

    /// Convenience: keep only `Event` payloads, for tests that don't care
    /// about output interleaving.
    fn collect_events(bytes: &[u8]) -> Vec<VtEvent> {
        collect_messages(bytes)
            .into_iter()
            .filter_map(|m| match m {
                VtMessage::Event(e) => Some(e),
                VtMessage::Output(_) => None,
            })
            .collect()
    }

    #[test]
    fn alt_screen_toggle() {
        let enter = b"\x1b[?1049h";
        let leave = b"\x1b[?1049l";

        let events = collect_events(enter);
        assert_eq!(events, vec![VtEvent::AltScreenEntered]);

        let events = collect_events(leave);
        assert_eq!(events, vec![VtEvent::AltScreenLeft]);
    }

    #[test]
    fn osc133_markers_abc_d_zero() {
        // A, B, C (bare) then D with exit 0
        let bytes = b"\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";
        let events = collect_events(bytes);
        assert_eq!(
            events,
            vec![
                VtEvent::PromptStart,
                VtEvent::PromptEnd,
                VtEvent::CommandStart { command: None },
                VtEvent::CommandFinished { exit_code: 0 },
            ]
        );
    }

    #[test]
    fn osc133_c_carries_command() {
        // OSC 133;C;<cmd> – Shax's zsh integration emits the typed command.
        let bytes = b"\x1b]133;C;ls -la\x07";
        let events = collect_events(bytes);
        assert_eq!(
            events,
            vec![VtEvent::CommandStart {
                command: Some("ls -la".into()),
            }]
        );
    }

    #[test]
    fn osc133_c_command_with_semicolons() {
        // vte splits OSC params on `;`; we must rejoin the tail.
        let bytes = b"\x1b]133;C;echo a;echo b\x07";
        let events = collect_events(bytes);
        assert_eq!(
            events,
            vec![VtEvent::CommandStart {
                command: Some("echo a;echo b".into()),
            }]
        );
    }

    #[test]
    fn osc133_c_command_trims_trailing_newline() {
        let bytes = b"\x1b]133;C;true\n\x07";
        let events = collect_events(bytes);
        assert_eq!(
            events,
            vec![VtEvent::CommandStart {
                command: Some("true".into()),
            }]
        );
    }

    #[test]
    fn osc133_nonzero_exit() {
        let bytes = b"\x1b]133;D;127\x07";
        let events = collect_events(bytes);
        assert_eq!(events, vec![VtEvent::CommandFinished { exit_code: 127 }]);
    }

    #[test]
    fn osc133_chunk_boundary_split() {
        // Feed the OSC 133 C marker split across two advance() calls.
        // vte buffers internally so the event must still fire.
        let messages: Arc<Mutex<Vec<VtMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let messages_clone = Arc::clone(&messages);
        let mut parser = OscParser::new(move |msg| {
            messages_clone.lock().unwrap().push(msg);
        });

        parser.advance(b"\x1b]13");
        parser.advance(b"3;C\x07");
        drop(parser);

        let got = Arc::try_unwrap(messages).unwrap().into_inner().unwrap();
        assert_eq!(
            got,
            vec![VtMessage::Event(VtEvent::CommandStart { command: None })]
        );
    }

    #[test]
    fn unrelated_osc_and_csi_are_ignored_but_text_between_is_output() {
        // OSC 8 (hyperlinks) and a non-1049 CSI must not emit any event, but
        // the plain text between them is real output and must be reported.
        let bytes = b"\x1b]8;;http://example.com\x07text\x1b[?2004h";
        let messages = collect_messages(bytes);
        // No events.
        let events: Vec<_> = messages
            .iter()
            .filter_map(|m| match m {
                VtMessage::Event(e) => Some(e.clone()),
                VtMessage::Output(_) => None,
            })
            .collect();
        assert!(events.is_empty(), "unexpected events: {events:?}");
        // But "text" must appear as Output.
        let outputs: Vec<_> = messages
            .iter()
            .filter_map(|m| match m {
                VtMessage::Output(b) => Some(b.clone()),
                VtMessage::Event(_) => None,
            })
            .collect();
        let concat: Vec<u8> = outputs.into_iter().flatten().collect();
        assert_eq!(concat, b"text");
    }

    #[test]
    fn output_and_events_interleave_in_arrival_order() {
        // The whole point of VtMessage: an OSC 133 C in the middle of a chunk
        // must be reported AFTER bytes that came before it and BEFORE bytes
        // that came after it. The reader thread relies on this ordering to
        // attribute output bytes to the correct block.
        let bytes = b"pre\x1b]133;C;cmd\x07post\x1b]133;D;0\x07tail";
        let messages = collect_messages(bytes);
        assert_eq!(
            messages,
            vec![
                VtMessage::Output(b"pre".to_vec()),
                VtMessage::Event(VtEvent::CommandStart {
                    command: Some("cmd".into()),
                }),
                VtMessage::Output(b"post".to_vec()),
                VtMessage::Event(VtEvent::CommandFinished { exit_code: 0 }),
                VtMessage::Output(b"tail".to_vec()),
            ]
        );
    }

    #[test]
    fn execute_bytes_like_crlf_are_part_of_output() {
        // \r and \n are control bytes routed through `execute`, but they are
        // visible output and must be captured.
        let bytes = b"hello\r\nworld";
        let messages = collect_messages(bytes);
        let concat: Vec<u8> = messages
            .into_iter()
            .filter_map(|m| match m {
                VtMessage::Output(b) => Some(b),
                VtMessage::Event(_) => None,
            })
            .flatten()
            .collect();
        assert_eq!(concat, b"hello\r\nworld");
    }
}
