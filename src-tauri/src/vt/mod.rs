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
    /// `OSC 133 ; A [ ; key=value … ] ST` – prompt start.
    ///
    /// Shax's zsh integration carries `cwd=<base64>` and `branch=<base64>`
    /// as trailing key/value params on the A marker; the values are
    /// base64-encoded so they may safely contain `;` and `=`. Older or
    /// third-party integrations emit a bare `A` and both fields are `None`.
    PromptStart {
        cwd: Option<String>,
        git_branch: Option<String>,
    },
    /// `OSC 133 ; B ST` – prompt end (command input begins).
    PromptEnd,
    /// `OSC 133 ; C [ ; <cmd> ] ST` – command output begins (preexec).
    /// Shax's zsh integration carries the typed command in the optional third
    /// parameter; older or third-party integrations may emit a bare `C` and
    /// `command` is then `None`. The command may itself contain `;`, so we
    /// re-join all trailing OSC params with `;` when reconstructing it.
    CommandStart { command: Option<String> },
    /// `OSC 133 ; D ; <exit> [ ; key=value … ] ST` – command finished with
    /// exit code, optionally carrying the cwd/branch the command ended in.
    ///
    /// Shax's zsh integration emits `cwd=<base64>` and `branch=<base64>` on
    /// every D so the just-closed block can be tagged with the directory the
    /// command *ended* in (rather than the directory it started in, captured
    /// at OSC C). The two values match for non-`cd` commands; they differ
    /// when the command itself changes directory.
    CommandFinished {
        exit_code: i32,
        cwd: Option<String>,
        git_branch: Option<String>,
    },
    /// `CSI 3 J` – the shell asked to erase saved lines (scrollback).
    /// Emitted whenever the user hits `clear`, `Ctrl+L`, or any alias
    /// that lands the same ED-3 sequence on the wire.
    ///
    /// This is a *soft-clear* signal: the frontend wipes the pane's
    /// visible block list in response; the persistent store is
    /// untouched, so search still surfaces the cleared blocks.
    /// The raw bytes still flow through to xterm.js so the terminal
    /// display clears too — same as before.
    ScrollbackCleared,
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
    //
    // We *consume* the alt-screen toggle (its bytes become an event, not raw
    // output), but every other CSI sequence is rebuilt and appended to the
    // pending byte stream so downstream consumers — the M1.9 PromptStrip
    // renderer in particular — can interpret cursor moves, line erases, and
    // similar redraw sequences emitted by the shell.
    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        if intermediates == [b'?'] {
            let param_1049 = params.iter().any(|sub| sub.first().copied() == Some(1049));
            if param_1049 {
                match action {
                    'h' => {
                        self.emit_event(VtEvent::AltScreenEntered);
                        return;
                    }
                    'l' => {
                        self.emit_event(VtEvent::AltScreenLeft);
                        return;
                    }
                    _ => {}
                }
            }
        }
        // `ED 3` – "erase saved lines" (scrollback). The shell emits
        // this whenever the user runs `clear`, hits `Ctrl+L`, or uses
        // any alias with the same effect. We *observe* it (emit an
        // event so the block layer can soft-clear the visible list)
        // but still pass the bytes through so xterm.js clears its own
        // grid — the fidelity contract stays intact.
        if action == 'J' && intermediates.is_empty() {
            let has_ed3 = params.iter().any(|sub| sub.first().copied() == Some(3));
            if has_ed3 {
                self.emit_event(VtEvent::ScrollbackCleared);
                // Fall through: still write the sequence into `pending`
                // below so downstream terminals see it too.
            }
        }
        // Pass through: ESC + [ + intermediates + params + action.
        // `vte::Params` reports `is_empty()` even when iterating yields a
        // single defaulted [0] subparam (which is what no-param input like
        // `\x1b[C` parses to). Detect that case and emit the canonical
        // no-param form so the downstream byte stream matches what the
        // shell actually sent.
        self.pending.push(0x1b);
        self.pending.push(b'[');
        self.pending.extend_from_slice(intermediates);
        let subs: Vec<&[u16]> = params.iter().collect();
        let only_default = subs.len() == 1 && subs[0] == [0];
        if !only_default {
            let mut first = true;
            for sub in &subs {
                if !first {
                    self.pending.push(b';');
                }
                let mut sub_first = true;
                for v in *sub {
                    if !sub_first {
                        self.pending.push(b':');
                    }
                    self.pending.extend_from_slice(v.to_string().as_bytes());
                    sub_first = false;
                }
                first = false;
            }
        }
        // CSI finals are always single ASCII bytes in 0x40..=0x7e.
        self.pending.push(action as u8);
    }

    // `osc_dispatch` handles OSC sequences like `OSC 133 ; C ST`.
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.first().copied() != Some(b"133") {
            return;
        }
        let marker = params.get(1).copied().unwrap_or_default();
        match marker {
            b"A" => {
                let (cwd, git_branch) = parse_kv_params(&params[2..]);
                self.emit_event(VtEvent::PromptStart { cwd, git_branch });
            }
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
                let (cwd, git_branch) = parse_kv_params(&params[3..]);
                self.emit_event(VtEvent::CommandFinished {
                    exit_code: code,
                    cwd,
                    git_branch,
                });
            }
            _ => {}
        }
    }

    // DCS sequences (Device Control Strings) are not used by anything we
    // currently render in the prompt strip; drop them.
    fn hook(&mut self, _params: &vte::Params, _intermediates: &[u8], _ignore: bool, _c: char) {}
    fn put(&mut self, _byte: u8) {}
    fn unhook(&mut self) {}

    // Two-byte ESC sequences (ESC 7 save cursor, ESC 8 restore, ESC c reset,
    // ESC ( B charset, etc.). The shell emits these during prompt redraws,
    // so we pass them through to the downstream renderer rather than
    // silently dropping them.
    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        self.pending.push(0x1b);
        self.pending.extend_from_slice(intermediates);
        self.pending.push(byte);
    }
}

/// Parse `cwd=<base64>` and `branch=<base64>` from the trailing params of
/// `OSC 133 ; A ; … ST` or `OSC 133 ; D ; <exit> ; … ST`. Unrecognised keys
/// are ignored so future additions (e.g. `host=`) don't break parsing.
///
/// The values are base64 (standard alphabet, no line breaks) so they can
/// safely carry `;`, `=`, and unicode without colliding with the OSC param
/// delimiter. A decode error yields `None` for that field rather than
/// failing the whole event — the marker itself is still useful.
fn parse_kv_params(tail: &[&[u8]]) -> (Option<String>, Option<String>) {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    let mut cwd: Option<String> = None;
    let mut branch: Option<String> = None;
    for raw in tail {
        let Ok(s) = std::str::from_utf8(raw) else {
            continue;
        };
        let Some((key, value)) = s.split_once('=') else {
            continue;
        };
        let decoded = match B64.decode(value.as_bytes()) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(decoded) => decoded,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        if decoded.is_empty() {
            continue;
        }
        match key {
            "cwd" => cwd = Some(decoded),
            "branch" => branch = Some(decoded),
            _ => {}
        }
    }
    (cwd, branch)
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
                VtEvent::PromptStart {
                    cwd: None,
                    git_branch: None,
                },
                VtEvent::PromptEnd,
                VtEvent::CommandStart { command: None },
                VtEvent::CommandFinished {
                    exit_code: 0,
                    cwd: None,
                    git_branch: None,
                },
            ]
        );
    }

    #[test]
    fn osc133_a_carries_cwd_and_branch_base64() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let cwd_b64 = B64.encode("/Users/me/project");
        let branch_b64 = B64.encode("feat/x");
        let bytes = format!("\x1b]133;A;cwd={cwd_b64};branch={branch_b64}\x07");
        let events = collect_events(bytes.as_bytes());
        assert_eq!(
            events,
            vec![VtEvent::PromptStart {
                cwd: Some("/Users/me/project".into()),
                git_branch: Some("feat/x".into()),
            }]
        );
    }

    #[test]
    fn osc133_a_tolerates_only_cwd() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let cwd_b64 = B64.encode("/tmp");
        let bytes = format!("\x1b]133;A;cwd={cwd_b64}\x07");
        let events = collect_events(bytes.as_bytes());
        assert_eq!(
            events,
            vec![VtEvent::PromptStart {
                cwd: Some("/tmp".into()),
                git_branch: None,
            }]
        );
    }

    #[test]
    fn osc133_a_ignores_unknown_keys_and_bad_base64() {
        // Unknown `host=` is ignored; an empty branch value yields None.
        let bytes = b"\x1b]133;A;host=not-encoded;branch=\x07";
        let events = collect_events(bytes);
        assert_eq!(
            events,
            vec![VtEvent::PromptStart {
                cwd: None,
                git_branch: None,
            }]
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
        assert_eq!(
            events,
            vec![VtEvent::CommandFinished {
                exit_code: 127,
                cwd: None,
                git_branch: None,
            }]
        );
    }

    #[test]
    fn osc133_d_carries_cwd_and_branch() {
        // OSC 133;D;<exit>;cwd=<b64>;branch=<b64> — Shax's zsh integration
        // emits these so the just-closed block can be tagged with the
        // directory the command ENDED in, not just the directory it started
        // in. This is what makes `cd X && ls` show X.
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let cwd_b64 = B64.encode("/Users/me/source/repos/shax");
        let branch_b64 = B64.encode("main");
        let bytes = format!("\x1b]133;D;0;cwd={cwd_b64};branch={branch_b64}\x07");
        let events = collect_events(bytes.as_bytes());
        assert_eq!(
            events,
            vec![VtEvent::CommandFinished {
                exit_code: 0,
                cwd: Some("/Users/me/source/repos/shax".into()),
                git_branch: Some("main".into()),
            }]
        );
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
    fn unrelated_osc_emits_no_event_and_drops_its_bytes() {
        // OSC 8 (hyperlinks) and other non-133 OSC sequences are still
        // consumed silently — the prompt strip's renderer doesn't need
        // them and the alt-screen / xterm passthrough path gets the raw
        // bytes separately.
        let bytes = b"\x1b]8;;http://example.com\x07text";
        let messages = collect_messages(bytes);
        let events: Vec<_> = messages
            .iter()
            .filter_map(|m| match m {
                VtMessage::Event(e) => Some(e.clone()),
                VtMessage::Output(_) => None,
            })
            .collect();
        assert!(events.is_empty(), "unexpected events: {events:?}");
        let concat: Vec<u8> = messages
            .iter()
            .filter_map(|m| match m {
                VtMessage::Output(b) => Some(b.clone()),
                VtMessage::Event(_) => None,
            })
            .flatten()
            .collect();
        assert_eq!(concat, b"text");
    }

    #[test]
    fn unhandled_csi_passes_through_as_output_bytes() {
        // CSI sequences other than the `?1049h/l` alt-screen toggle are
        // forwarded to the downstream consumer — the M1.9 PromptStrip
        // renderer relies on getting cursor-move / erase / SGR sequences
        // intact so it can mirror the shell's prompt redraws.
        let bytes = b"hi\x1b[Cthere\x1b[?2004h";
        let messages = collect_messages(bytes);
        let events: Vec<_> = messages
            .iter()
            .filter_map(|m| match m {
                VtMessage::Event(e) => Some(e.clone()),
                VtMessage::Output(_) => None,
            })
            .collect();
        assert!(events.is_empty(), "unexpected events: {events:?}");
        let concat: Vec<u8> = messages
            .iter()
            .filter_map(|m| match m {
                VtMessage::Output(b) => Some(b.clone()),
                VtMessage::Event(_) => None,
            })
            .flatten()
            .collect();
        // Both the `\x1b[C` (cursor-forward) and the bracketed-paste-mode
        // toggle `\x1b[?2004h` must pass through verbatim alongside the
        // plain text.
        assert_eq!(concat, b"hi\x1b[Cthere\x1b[?2004h");
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
                VtMessage::Event(VtEvent::CommandFinished {
                    exit_code: 0,
                    cwd: None,
                    git_branch: None,
                }),
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

    #[test]
    fn ed3_emits_scrollback_cleared_event_and_passes_bytes_through() {
        // `\x1b[3J` — the shell's "erase saved lines" (scrollback)
        // sequence. Emitted by `clear`, `Ctrl+L` (in most shell
        // bindings), `tput reset`, and `printf '\ec'` (RIS). The VT
        // layer must:
        //   1. Emit `VtEvent::ScrollbackCleared` so the block layer
        //      can soft-clear the pane's visible block list.
        //   2. Still pass the bytes through to xterm.js so the
        //      terminal display clears too (fidelity contract).
        let bytes = b"before\x1b[3Jafter";
        let messages = collect_messages(bytes);
        let events: Vec<_> = messages
            .iter()
            .filter_map(|m| match m {
                VtMessage::Event(e) => Some(e.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(events, vec![VtEvent::ScrollbackCleared]);
        let concat: Vec<u8> = messages
            .into_iter()
            .filter_map(|m| match m {
                VtMessage::Output(b) => Some(b),
                VtMessage::Event(_) => None,
            })
            .flatten()
            .collect();
        // Both the raw ED-3 escape and the surrounding text must
        // still reach downstream — xterm consumes the ED-3 itself.
        assert_eq!(concat, b"before\x1b[3Jafter");
    }

    #[test]
    fn ed_without_param_3_does_not_emit_scrollback_cleared() {
        // `\x1b[J` (no param, defaults to ED 0 — erase from cursor to
        // end of screen) and `\x1b[2J` (erase entire visible screen)
        // must NOT trigger the soft-clear signal. Only `\x1b[3J`
        // targets the scrollback.
        for bytes in [&b"\x1b[J"[..], &b"\x1b[0J"[..], &b"\x1b[2J"[..]] {
            let messages = collect_messages(bytes);
            let events: Vec<_> = messages
                .into_iter()
                .filter_map(|m| match m {
                    VtMessage::Event(e) => Some(e),
                    _ => None,
                })
                .collect();
            assert!(
                events.is_empty(),
                "ED without param 3 must not emit ScrollbackCleared, got: {events:?} for {bytes:?}"
            );
        }
    }
}
