//! VT escape and OSC 133 parsing, alternate-screen detection.
//!
//! `OscParser` wraps `vte::Parser` and implements `vte::Perform` to observe
//! the byte stream without transforming it. It is observe-only: every byte
//! still reaches xterm.js unchanged via `PtyEvent::Output`.
//!
//! Detected transitions are reported through the `VtEvent` enum so the block
//! state machine in `blocks/` can react without coupling to the VT layer.

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
    /// `OSC 133 ; C ST` – command output begins (preexec).
    CommandStart,
    /// `OSC 133 ; D ; <exit> ST` – command finished with exit code.
    CommandFinished { exit_code: i32 },
}

/// Opaque VT parser that calls `on_event` for each semantic event.
///
/// Lives entirely inside the reader thread; it is not `Send` or `Sync` by
/// default because `vte::Parser` is not, but that is fine because we never
/// move it across threads.
pub struct OscParser {
    parser: vte::Parser,
    performer: Performer,
}

impl OscParser {
    /// Create a new parser.  `on_event` is called synchronously during
    /// `advance()` whenever a semantic event is recognised.
    pub fn new(on_event: impl Fn(VtEvent) + 'static) -> Self {
        Self {
            parser: vte::Parser::new(),
            performer: Performer {
                on_event: Box::new(on_event),
            },
        }
    }

    /// Feed a chunk of raw PTY bytes through the parser.  The caller still
    /// owns and forwards those bytes to the frontend unchanged.
    pub fn advance(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.performer, bytes);
    }
}

// ── Performer ──────────────────────────────────────────────────────────────────

struct Performer {
    on_event: Box<dyn Fn(VtEvent)>,
}

impl vte::Perform for Performer {
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
            'h' => (self.on_event)(VtEvent::AltScreenEntered),
            'l' => (self.on_event)(VtEvent::AltScreenLeft),
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
            b"A" => (self.on_event)(VtEvent::PromptStart),
            b"B" => (self.on_event)(VtEvent::PromptEnd),
            b"C" => (self.on_event)(VtEvent::CommandStart),
            b"D" => {
                let raw = params.get(2).copied().unwrap_or(b"0");
                let code = std::str::from_utf8(raw)
                    .ok()
                    .and_then(|s| s.parse::<i32>().ok())
                    .unwrap_or(0);
                (self.on_event)(VtEvent::CommandFinished { exit_code: code });
            }
            _ => {}
        }
    }

    // Required by the trait; no-ops for everything else.
    fn print(&mut self, _c: char) {}
    fn execute(&mut self, _byte: u8) {}
    fn hook(&mut self, _params: &vte::Params, _intermediates: &[u8], _ignore: bool, _c: char) {}
    fn put(&mut self, _byte: u8) {}
    fn unhook(&mut self) {}
    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {}
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Feed `bytes` through a fresh parser and return all events it emitted.
    fn collect_events(bytes: &[u8]) -> Vec<VtEvent> {
        let events: Arc<Mutex<Vec<VtEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = Arc::clone(&events);
        let mut parser = OscParser::new(move |ev| {
            events_clone.lock().unwrap().push(ev);
        });
        parser.advance(bytes);
        // Drop the parser to release its Arc clone, then unwrap.
        drop(parser);
        Arc::try_unwrap(events).unwrap().into_inner().unwrap()
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
        // A, B, C then D with exit 0
        let bytes = b"\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";
        let events = collect_events(bytes);
        assert_eq!(
            events,
            vec![
                VtEvent::PromptStart,
                VtEvent::PromptEnd,
                VtEvent::CommandStart,
                VtEvent::CommandFinished { exit_code: 0 },
            ]
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
        let events: Arc<Mutex<Vec<VtEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = Arc::clone(&events);
        let mut parser = OscParser::new(move |ev| {
            events_clone.lock().unwrap().push(ev);
        });

        parser.advance(b"\x1b]13");
        parser.advance(b"3;C\x07");
        drop(parser);

        let got = Arc::try_unwrap(events).unwrap().into_inner().unwrap();
        assert_eq!(got, vec![VtEvent::CommandStart]);
    }

    #[test]
    fn unrelated_osc_and_csi_are_ignored() {
        // OSC 8 (hyperlinks) and a non-1049 CSI must not emit any event.
        let bytes = b"\x1b]8;;http://example.com\x07text\x1b[?2004h";
        let events = collect_events(bytes);
        assert!(events.is_empty(), "unexpected events: {events:?}");
    }
}
