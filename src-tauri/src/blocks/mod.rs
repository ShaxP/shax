//! Block assembly and lifecycle: command boundaries, exit codes, timing.
//!
//! This module owns the per-pane block state machine.  It is driven by
//! `VtEvent`s produced by the VT parser and emits `PtyEvent`s to the frontend
//! over the Tauri channel.
//!
//! # State machine
//!
//! ```text
//! Idle ──(CommandStart)──► Running { id, started_at_ms }
//!                               │
//!                 (CommandStart again, no D received)
//!                               │  close current with exit_code=-1, then open new
//!                               ▼
//!                           Running { new_id, now }
//!                               │
//!               (CommandFinished { exit_code })
//!                               │
//!                               ▼
//!                            Idle
//! ```
//!
//! Output bytes received while Running are accumulated into `current_output`
//! for the BlockRecord AND still forwarded to xterm.js by the caller (fidelity
//! contract).

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::pty::PtyEvent;
use crate::vt::VtEvent;

/// Cap captured output at 1 MiB per block while everything lives in RAM.
/// M4 will replace this with a head+tail + spill-to-disk strategy per
/// `specs/05-search-and-data-model.md`.
pub const OUTPUT_CAP_BYTES: usize = 1024 * 1024;

// ── BlockId ────────────────────────────────────────────────────────────────────

/// Opaque identifier for a single captured command block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct BlockId(pub Uuid);

impl BlockId {
    fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Parse a `BlockId` from its `Display` form (a UUID string).
    /// Used by the SQLite store when loading rows.
    pub fn parse(s: &str) -> Result<Self, uuid::Error> {
        Uuid::parse_str(s).map(Self)
    }
}

impl std::fmt::Display for BlockId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

// ── Public summary (cheap snapshot for IPC) ────────────────────────────────────

/// A lightweight snapshot of a block, used by `pty_list_blocks`.
///
/// `command` is `None` when the shell did not emit it (older or third-party
/// integration). `cwd` and `git_branch` are also `None` when the shell did
/// not report them via the OSC 133;A params; for Shax's zsh integration they
/// are populated on every prompt. `duration_ms` is `Some` iff `ended_at_ms`
/// is `Some`. `aborted` is `true` when the block was closed without a clean
/// OSC 133 D — either by the PTY exiting mid-block or by a second
/// OSC 133 C arriving first.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BlockSummary {
    pub id: BlockId,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub aborted: bool,
}

// ── Full record (in-memory) ────────────────────────────────────────────────────

/// Full in-memory record for a block, including captured output bytes.
///
/// In M4/slice 4 this will be written through to SQLite with head+tail + spill;
/// for now it lives only in RAM, capped at `OUTPUT_CAP_BYTES`.
struct BlockRecord {
    id: BlockId,
    command: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    started_at_ms: u64,
    ended_at_ms: Option<u64>,
    exit_code: Option<i32>,
    aborted: bool,
    /// Raw bytes captured between OSC 133 C and OSC 133 D.
    output: Vec<u8>,
}

impl BlockRecord {
    fn to_summary(&self) -> BlockSummary {
        let duration_ms = self
            .ended_at_ms
            .map(|end| end.saturating_sub(self.started_at_ms));
        BlockSummary {
            id: self.id,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            git_branch: self.git_branch.clone(),
            started_at_ms: self.started_at_ms,
            ended_at_ms: self.ended_at_ms,
            exit_code: self.exit_code,
            duration_ms,
            aborted: self.aborted,
        }
    }
}

// ── Block state machine ────────────────────────────────────────────────────────

enum BlockState {
    /// No command is running: waiting for the next OSC 133 C.
    Idle,
    /// A command started with OSC 133 C but the D has not arrived yet.
    Running {
        id: BlockId,
        command: Option<String>,
        cwd: Option<String>,
        git_branch: Option<String>,
        started_at_ms: u64,
    },
}

/// Per-pane block state machine.  Lives inside the reader thread.
pub struct BlockMachine {
    state: BlockState,
    /// True when a program has taken the alternate screen (`?1049h`).
    pub alt_screen: bool,
    /// Completed (and any prematurely-closed) blocks in arrival order.
    records: Vec<BlockRecord>,
    /// Raw bytes accumulated since the last OSC 133 C.
    current_output: Vec<u8>,
    /// Most recent cwd reported on OSC 133;A (precmd). Attached to the next
    /// block opened by OSC 133;C (preexec). `None` until the integration
    /// reports one — older or third-party integrations may not.
    latest_cwd: Option<String>,
    /// Most recent git branch reported on OSC 133;A. Same semantics as
    /// `latest_cwd`.
    latest_git_branch: Option<String>,
}

impl BlockMachine {
    /// Create a new machine in the `Idle` state.
    pub fn new() -> Self {
        Self {
            state: BlockState::Idle,
            alt_screen: false,
            records: Vec::new(),
            current_output: Vec::new(),
            latest_cwd: None,
            latest_git_branch: None,
        }
    }

    /// Append `bytes` to the active block's output buffer.
    ///
    /// The caller must also forward the same bytes to xterm.js; this method
    /// only accumulates, it does not forward. Once the per-block cap is hit,
    /// further bytes are dropped from the captured buffer (xterm still gets
    /// them) — see `OUTPUT_CAP_BYTES` for the M4 follow-up.
    pub fn push_output(&mut self, bytes: &[u8]) {
        if !matches!(self.state, BlockState::Running { .. }) {
            return;
        }
        let remaining = OUTPUT_CAP_BYTES.saturating_sub(self.current_output.len());
        if remaining == 0 {
            return;
        }
        let take = bytes.len().min(remaining);
        self.current_output.extend_from_slice(&bytes[..take]);
    }

    /// Process a `VtEvent` and return zero or more `PtyEvent`s to emit to the
    /// frontend.  The caller sends them on the Tauri channel in the order
    /// returned.
    pub fn handle_vt_event(&mut self, event: VtEvent) -> Vec<PtyEvent> {
        match event {
            VtEvent::AltScreenEntered => {
                self.alt_screen = true;
                vec![PtyEvent::AltScreenChanged { active: true }]
            }
            VtEvent::AltScreenLeft => {
                self.alt_screen = false;
                vec![PtyEvent::AltScreenChanged { active: false }]
            }
            VtEvent::PromptStart { cwd, git_branch } => {
                // Stash the latest values so the next OSC 133 C can attach them
                // to its block. A bare `A` clears any stale prior values so we
                // never carry one shell's cwd into another shell's block.
                self.latest_cwd = cwd;
                self.latest_git_branch = git_branch;
                vec![]
            }
            VtEvent::PromptEnd => vec![],
            VtEvent::CommandStart { command } => self.on_command_start(command),
            VtEvent::CommandFinished { exit_code } => self.on_command_finished(exit_code),
        }
    }

    /// Take a snapshot of all recorded blocks for `pty_list_blocks`.
    pub fn block_summaries(&self) -> Vec<BlockSummary> {
        self.records.iter().map(|r| r.to_summary()).collect()
    }

    /// Drain finished blocks' captured output into the supplied map, leaving
    /// only the running block's bytes (if any) in the machine. Called by the
    /// reader thread after each round of VT events so the IPC side can fetch
    /// completed-block bytes without holding the machine's lock.
    pub fn collect_completed_output(&mut self, sink: &mut HashMap<BlockId, Vec<u8>>) {
        for record in &mut self.records {
            if record.output.is_empty() {
                continue;
            }
            let bytes = std::mem::take(&mut record.output);
            sink.entry(record.id).or_default().extend(bytes);
        }
    }

    // ── Transitions ───────────────────────────────────────────────────────────

    fn on_command_start(&mut self, command: Option<String>) -> Vec<PtyEvent> {
        let mut events = Vec::new();

        // Safety net: if a C arrives before a D, close the previous block as
        // aborted with exit_code=-1.
        if let BlockState::Running {
            id,
            command: prev_cmd,
            cwd: prev_cwd,
            git_branch: prev_branch,
            started_at_ms,
        } = std::mem::replace(&mut self.state, BlockState::Idle)
        {
            let now = now_ms();
            let output = std::mem::take(&mut self.current_output);
            let duration_ms = now.saturating_sub(started_at_ms);
            tracing::warn!(%id, "OSC 133 C received while already Running; closing with exit_code=-1");
            self.records.push(BlockRecord {
                id,
                command: prev_cmd,
                cwd: prev_cwd,
                git_branch: prev_branch,
                started_at_ms,
                ended_at_ms: Some(now),
                exit_code: Some(-1),
                aborted: true,
                output,
            });
            events.push(PtyEvent::BlockCompleted {
                block_id: id,
                exit_code: -1,
                ended_at_ms: now,
                duration_ms,
                aborted: true,
            });
        }

        let id = BlockId::new();
        let started_at_ms = now_ms();
        let cwd = self.latest_cwd.clone();
        let git_branch = self.latest_git_branch.clone();
        self.state = BlockState::Running {
            id,
            command: command.clone(),
            cwd: cwd.clone(),
            git_branch: git_branch.clone(),
            started_at_ms,
        };
        self.current_output.clear();
        events.push(PtyEvent::BlockStarted {
            block_id: id,
            command,
            cwd,
            git_branch,
            started_at_ms,
        });
        events
    }

    fn on_command_finished(&mut self, exit_code: i32) -> Vec<PtyEvent> {
        match std::mem::replace(&mut self.state, BlockState::Idle) {
            BlockState::Running {
                id,
                command,
                cwd,
                git_branch,
                started_at_ms,
            } => {
                let ended_at_ms = now_ms();
                let duration_ms = ended_at_ms.saturating_sub(started_at_ms);
                let output = std::mem::take(&mut self.current_output);
                self.records.push(BlockRecord {
                    id,
                    command,
                    cwd,
                    git_branch,
                    started_at_ms,
                    ended_at_ms: Some(ended_at_ms),
                    exit_code: Some(exit_code),
                    aborted: false,
                    output,
                });
                vec![PtyEvent::BlockCompleted {
                    block_id: id,
                    exit_code,
                    ended_at_ms,
                    duration_ms,
                    aborted: false,
                }]
            }
            BlockState::Idle => {
                // D without a preceding C — defensive ignore.
                tracing::debug!("OSC 133 D received while Idle; ignoring");
                vec![]
            }
        }
    }

    /// Called when the PTY exits without a final D.  Any running block is
    /// finalized as aborted with `ended_at_ms = now` and `exit_code = -1`
    /// (sentinel — the UI keys off `aborted`, not the code). Returns a
    /// `BlockCompleted` event the caller forwards to the frontend so the row's
    /// status pill flips from "running" to "aborted" before teardown.
    ///
    /// Matches the spec edge case: "Commands that never emit D (killed shell,
    /// crash): mark the block aborted after the shell dies; do not leave it
    /// Running forever."
    pub fn finalize_on_exit(&mut self) -> Vec<PtyEvent> {
        if let BlockState::Running {
            id,
            command,
            cwd,
            git_branch,
            started_at_ms,
        } = std::mem::replace(&mut self.state, BlockState::Idle)
        {
            let ended_at_ms = now_ms();
            let duration_ms = ended_at_ms.saturating_sub(started_at_ms);
            let output = std::mem::take(&mut self.current_output);
            tracing::info!(%id, "PTY exited while block was Running; marking aborted");
            self.records.push(BlockRecord {
                id,
                command,
                cwd,
                git_branch,
                started_at_ms,
                ended_at_ms: Some(ended_at_ms),
                exit_code: Some(-1),
                aborted: true,
                output,
            });
            return vec![PtyEvent::BlockCompleted {
                block_id: id,
                exit_code: -1,
                ended_at_ms,
                duration_ms,
                aborted: true,
            }];
        }
        Vec::new()
    }
}

impl Default for BlockMachine {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// Current time as milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn block_started_id(ev: &PtyEvent) -> Option<BlockId> {
        if let PtyEvent::BlockStarted { block_id, .. } = ev {
            Some(*block_id)
        } else {
            None
        }
    }

    fn block_completed_fields(ev: &PtyEvent) -> Option<(BlockId, i32)> {
        if let PtyEvent::BlockCompleted {
            block_id,
            exit_code,
            ..
        } = ev
        {
            Some((*block_id, *exit_code))
        } else {
            None
        }
    }

    fn block_completed_aborted(ev: &PtyEvent) -> Option<bool> {
        if let PtyEvent::BlockCompleted { aborted, .. } = ev {
            Some(*aborted)
        } else {
            None
        }
    }

    #[test]
    fn osc133_lifecycle() {
        let mut machine = BlockMachine::new();

        // Simulate: A, B, C(cmd), output bytes, D;0
        let mut all_events: Vec<PtyEvent> = Vec::new();

        all_events.extend(machine.handle_vt_event(VtEvent::PromptStart {
            cwd: Some("/Users/me/proj".into()),
            git_branch: Some("main".into()),
        }));
        all_events.extend(machine.handle_vt_event(VtEvent::PromptEnd));
        all_events.extend(machine.handle_vt_event(VtEvent::CommandStart {
            command: Some("echo hi".into()),
        }));

        // Output arrives between C and D.
        machine.push_output(b"hi\n");

        all_events.extend(machine.handle_vt_event(VtEvent::CommandFinished { exit_code: 0 }));

        // Exactly two events: BlockStarted then BlockCompleted.
        let started: Vec<_> = all_events.iter().filter_map(block_started_id).collect();
        let completed: Vec<_> = all_events
            .iter()
            .filter_map(block_completed_fields)
            .collect();

        assert_eq!(started.len(), 1, "expected one BlockStarted");
        assert_eq!(completed.len(), 1, "expected one BlockCompleted");
        assert_eq!(completed[0].0, started[0], "ids must match");
        assert_eq!(completed[0].1, 0, "exit code must be 0");

        // Clean completion: event carries aborted=false.
        let completed_aborted: Vec<_> = all_events
            .iter()
            .filter_map(block_completed_aborted)
            .collect();
        assert_eq!(completed_aborted, vec![false]);

        // BlockStarted carries the typed command.
        let started_cmd = all_events.iter().find_map(|e| match e {
            PtyEvent::BlockStarted { command, .. } => Some(command.clone()),
            _ => None,
        });
        assert_eq!(started_cmd, Some(Some("echo hi".into())));

        // Summaries carry the completed block with command, duration, not aborted.
        let summaries = machine.block_summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].command.as_deref(), Some("echo hi"));
        assert_eq!(summaries[0].exit_code, Some(0));
        assert!(summaries[0].ended_at_ms.is_some());
        assert!(summaries[0].duration_ms.is_some());
        assert!(!summaries[0].aborted);

        // cwd/git_branch from the preceding PromptStart flowed into the record.
        assert_eq!(summaries[0].cwd.as_deref(), Some("/Users/me/proj"));
        assert_eq!(summaries[0].git_branch.as_deref(), Some("main"));

        // Output was captured in the record.
        assert_eq!(machine.records[0].output, b"hi\n");
    }

    #[test]
    fn prompt_start_without_params_clears_stale_cwd() {
        // A bare PromptStart must overwrite any previously cached cwd/branch
        // so a fresh shell session never picks up a prior pane's metadata.
        let mut machine = BlockMachine::new();
        machine.handle_vt_event(VtEvent::PromptStart {
            cwd: Some("/old".into()),
            git_branch: Some("old-branch".into()),
        });
        machine.handle_vt_event(VtEvent::PromptStart {
            cwd: None,
            git_branch: None,
        });
        machine.handle_vt_event(VtEvent::CommandStart {
            command: Some("ls".into()),
        });
        machine.handle_vt_event(VtEvent::CommandFinished { exit_code: 0 });
        let summaries = machine.block_summaries();
        assert_eq!(summaries[0].cwd, None);
        assert_eq!(summaries[0].git_branch, None);
    }

    #[test]
    fn osc133_nonzero_exit() {
        let mut machine = BlockMachine::new();

        machine.handle_vt_event(VtEvent::CommandStart { command: None });
        let events = machine.handle_vt_event(VtEvent::CommandFinished { exit_code: 127 });

        let (_, code) = block_completed_fields(&events[0]).unwrap();
        assert_eq!(code, 127);
        // No command captured, but the summary still surfaces the record.
        let summaries = machine.block_summaries();
        assert_eq!(summaries[0].command, None);
        assert!(!summaries[0].aborted);
    }

    #[test]
    fn alt_screen_events_emitted() {
        let mut machine = BlockMachine::new();

        let ev_enter = machine.handle_vt_event(VtEvent::AltScreenEntered);
        assert!(matches!(
            ev_enter[0],
            PtyEvent::AltScreenChanged { active: true }
        ));
        assert!(machine.alt_screen);

        let ev_leave = machine.handle_vt_event(VtEvent::AltScreenLeft);
        assert!(matches!(
            ev_leave[0],
            PtyEvent::AltScreenChanged { active: false }
        ));
        assert!(!machine.alt_screen);
    }

    #[test]
    fn block_unfinished_on_kill_emits_aborted_completed() {
        let mut machine = BlockMachine::new();

        machine.handle_vt_event(VtEvent::CommandStart {
            command: Some("sleep 99".into()),
        });
        machine.push_output(b"partial output");

        // PTY dies without a D.
        let events = machine.finalize_on_exit();

        // The block emits a single BlockCompleted event with aborted=true so
        // the frontend's status pill flips before teardown.
        assert_eq!(events.len(), 1);
        assert_eq!(block_completed_aborted(&events[0]), Some(true));
        let (_, code) = block_completed_fields(&events[0]).unwrap();
        assert_eq!(code, -1, "aborted blocks emit -1 as the sentinel");

        // The summary now carries the sentinel exit code and timestamps; the
        // `aborted` flag is the truth signal for the UI.
        let summaries = machine.block_summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].exit_code, Some(-1));
        assert!(summaries[0].ended_at_ms.is_some());
        assert!(summaries[0].duration_ms.is_some());
        assert!(summaries[0].aborted);
        assert_eq!(summaries[0].command.as_deref(), Some("sleep 99"));
    }

    #[test]
    fn finalize_on_exit_idle_emits_nothing() {
        let mut machine = BlockMachine::new();
        let events = machine.finalize_on_exit();
        assert!(events.is_empty());
        assert!(machine.block_summaries().is_empty());
    }

    #[test]
    fn double_c_closes_first_block_as_aborted() {
        // A second C without D should close the first block with exit_code=-1
        // and aborted=true.
        let mut machine = BlockMachine::new();

        let first_events = machine.handle_vt_event(VtEvent::CommandStart {
            command: Some("first".into()),
        });
        let first_id = block_started_id(&first_events[0]).unwrap();

        let second_events = machine.handle_vt_event(VtEvent::CommandStart {
            command: Some("second".into()),
        });
        // second_events[0] should be BlockCompleted for the first block,
        // second_events[1] should be BlockStarted for the new block.
        let (closed_id, closed_code) = block_completed_fields(&second_events[0]).unwrap();
        assert_eq!(closed_id, first_id);
        assert_eq!(closed_code, -1);
        assert_eq!(
            block_completed_aborted(&second_events[0]),
            Some(true),
            "double-C close must emit aborted=true so the UI flips the pill"
        );

        let new_id = block_started_id(&second_events[1]).unwrap();
        assert_ne!(new_id, first_id);

        let summaries = machine.block_summaries();
        assert_eq!(summaries.len(), 1, "only the closed block is in records");
        assert!(summaries[0].aborted);
        assert_eq!(summaries[0].command.as_deref(), Some("first"));
    }

    #[test]
    fn d_without_c_is_ignored() {
        let mut machine = BlockMachine::new();
        let events = machine.handle_vt_event(VtEvent::CommandFinished { exit_code: 0 });
        assert!(events.is_empty(), "D without C should produce no events");
        assert!(machine.block_summaries().is_empty());
    }

    #[test]
    fn collect_completed_output_drains_finished_blocks() {
        let mut machine = BlockMachine::new();
        machine.handle_vt_event(VtEvent::CommandStart {
            command: Some("echo a".into()),
        });
        machine.push_output(b"alpha");
        machine.handle_vt_event(VtEvent::CommandFinished { exit_code: 0 });

        let first_id = machine.records[0].id;

        let mut sink: HashMap<BlockId, Vec<u8>> = HashMap::new();
        machine.collect_completed_output(&mut sink);

        assert_eq!(
            sink.get(&first_id).map(|v| v.as_slice()),
            Some(&b"alpha"[..])
        );
        // After draining, the record's output is gone but the summary is intact.
        assert!(machine.records[0].output.is_empty());
        assert_eq!(
            machine.block_summaries()[0].command.as_deref(),
            Some("echo a")
        );
    }

    #[test]
    fn output_buffer_is_capped() {
        let mut machine = BlockMachine::new();
        machine.handle_vt_event(VtEvent::CommandStart { command: None });
        // Push more than the cap; only OUTPUT_CAP_BYTES should land.
        let big = vec![b'x'; OUTPUT_CAP_BYTES + 4096];
        machine.push_output(&big);
        assert_eq!(machine.current_output.len(), OUTPUT_CAP_BYTES);
    }

    #[test]
    fn duration_ms_is_present_on_completed() {
        let mut machine = BlockMachine::new();
        machine.handle_vt_event(VtEvent::CommandStart { command: None });
        // tiny sleep so started/ended differ on most clocks
        std::thread::sleep(std::time::Duration::from_millis(2));
        let events = machine.handle_vt_event(VtEvent::CommandFinished { exit_code: 0 });
        let (_, _) = block_completed_fields(&events[0]).unwrap();
        let s = &machine.block_summaries()[0];
        assert!(s.duration_ms.is_some());
        assert!(s.ended_at_ms.is_some());
    }
}
