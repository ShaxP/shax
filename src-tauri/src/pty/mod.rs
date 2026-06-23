//! PTY manager: one PTY per pane, reader tasks, resize, and process-group reaping.
//!
//! Slice 2 additions:
//! - New `PtyEvent` variants: `AltScreenChanged`, `BlockStarted`, `BlockCompleted`.
//! - Reader thread runs the VT parser and block state machine inline.
//! - zsh shell integration is injected invisibly via ZDOTDIR shim on spawn.
//! - `PtyManager` exposes `list_blocks` for the `pty_list_blocks` IPC command.

use std::{
    collections::HashMap,
    io::Write as _,
    sync::{Arc, OnceLock},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    blocks::{BlockId, BlockMachine, BlockSummary},
    pty::error::PtyError,
    store::{PersistedBlock, Store},
    vt::{OscParser, VtMessage},
};

pub mod error;

// ── Public types ───────────────────────────────────────────────────────────────

/// Opaque identifier for a single PTY / pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct PtyId(pub Uuid);

impl PtyId {
    /// Create a new random PTY identifier.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for PtyId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for PtyId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Options for spawning a new PTY / child shell.
#[derive(Debug, serde::Deserialize)]
pub struct SpawnOpts {
    pub rows: u16,
    pub cols: u16,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

/// Events streamed from the backend to the frontend over a `Channel<PtyEvent>`.
///
/// The `Output` and `Exit` variants are unchanged from slice 1 (frozen IPC
/// contract).  The three new variants are additive.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PtyEvent {
    /// Raw PTY output bytes, base64-encoded for efficient IPC transfer.
    Output { data: String },
    /// The child process has exited. `code` is `None` when the exit status is
    /// unavailable (e.g. killed by a signal without a numeric code).
    Exit { code: Option<i32> },
    /// The alternate screen buffer was entered (`?1049h`) or left (`?1049l`).
    AltScreenChanged { active: bool },
    /// A new command block has started (OSC 133 C received).
    ///
    /// `command` is the typed command line when the shell integration reported
    /// it (Shax's zsh script does), and `None` otherwise. `cwd` and
    /// `git_branch` carry the values reported on the most recent OSC 133 A
    /// (precmd) — the directory and branch the command was invoked from.
    BlockStarted {
        block_id: BlockId,
        command: Option<String>,
        cwd: Option<String>,
        git_branch: Option<String>,
        started_at_ms: u64,
    },
    /// A command block has completed (OSC 133 D received, or the block was
    /// aborted because the PTY exited or a second OSC 133 C arrived first).
    ///
    /// `aborted` is true for both abort paths. The frontend uses it directly
    /// for the status pill — `exit_code` is `-1` in the abort cases as a
    /// sentinel and is not meant to be displayed when `aborted` is true.
    ///
    /// `cwd` and `git_branch` are the values the shell reported on the D
    /// marker — the directory the command *ended* in, which is what the user
    /// associates with the block in cases like `cd X && ls`. `None` when the
    /// shell integration didn't include them (older or third-party).
    BlockCompleted {
        block_id: BlockId,
        exit_code: i32,
        ended_at_ms: u64,
        duration_ms: u64,
        aborted: bool,
        cwd: Option<String>,
        git_branch: Option<String>,
        /// True when the alt-screen was active at any point during this
        /// block (vim, htop, less, ssh, REPLs). The frontend uses this to
        /// hide the output preview — captured bytes are cursor / grid
        /// manipulation, not flow text.
        interactive: bool,
    },
    /// A chunk of raw output bytes scoped to the currently-running block.
    ///
    /// Emitted alongside `Output` whenever VT-parsed bytes arrive while a
    /// block is in the Running state. `Output` keeps flowing to xterm.js as
    /// before (so alt-screen passthrough remains exact); `BlockChunk` lets
    /// the frontend render the same bytes inline in the block stack without
    /// waiting for `BlockCompleted` and an IPC fetch round-trip.
    ///
    /// `data` is base64-encoded so the bytes survive the JSON channel
    /// unchanged. Cumulative size per block is capped at `OUTPUT_CAP_BYTES`
    /// by the BlockMachine; anything beyond is dropped on the backend, the
    /// same as the captured-output buffer.
    BlockChunk { block_id: BlockId, data: String },
    /// A chunk of raw bytes that arrived while the shell is at a prompt —
    /// between OSC 133 D (or session start) and the next OSC 133 C.
    ///
    /// These are the bytes the shell prints to render PS1, plus the local
    /// echo of whatever the user is typing before they press Enter. The
    /// M1.9 PromptStrip feeds them through a tiny single-line VT renderer
    /// to mirror what the shell is rendering on its current prompt line.
    /// The raw `Output` event continues to flow to xterm.js unchanged so
    /// non-shell-integrated programs and alt-screen passthrough still work.
    PromptChunk { data: String },
}

// ── Internal handle ────────────────────────────────────────────────────────────

/// Per-PTY state kept inside `PtyManager`.
struct PtyHandle {
    /// PTY master, kept alive so the child stays attached and so we can resize.
    master: Box<dyn MasterPty + Send>,
    /// Writer for sending keystrokes to the child.
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    /// Stored so the child's exit code is available without an extra syscall.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Temp dir for the ZDOTDIR shim; kept alive until the PTY is dropped.
    _zdotdir_tmpdir: Option<tempfile::TempDir>,
}

// ── PtyManager ─────────────────────────────────────────────────────────────────

/// Per-pane shared block state written by the reader thread and read by IPC.
///
/// Holds both the chronological summary list and a map of captured output
/// bytes keyed by `BlockId`. The reader thread refreshes `summaries` and
/// drains completed-block bytes into `outputs` on each VT round.
#[derive(Default)]
struct BlockShared {
    summaries: Vec<BlockSummary>,
    outputs: HashMap<BlockId, Vec<u8>>,
}

/// Owns all active PTYs. Lives as a `tauri::State` singleton.
pub struct PtyManager {
    inner: Mutex<HashMap<PtyId, PtyHandle>>,
    /// Per-pane shared block state. Keyed by `PtyId`.
    blocks: Mutex<HashMap<PtyId, Arc<Mutex<BlockShared>>>>,
    /// Persistent store for completed blocks. When `None` (rare — bare
    /// `cargo test`), persistence and boot-time seeding are skipped.
    store: Option<Arc<Store>>,
}

/// How many historical blocks to load on each pane spawn so the user sees
/// their previous session's commands in the BlockList. Older blocks are
/// still in the store and will be reachable via search at M3.
///
/// Bounded deliberately: the frontend's non-virtualized BlockList commits
/// every row synchronously on mount, and a large seed starves xterm's
/// render scheduler. 50 fits comfortably in one frame; virtualization
/// lifts this in M3 when the search surface lands.
const HISTORY_SEED_LIMIT: usize = 50;

impl PtyManager {
    /// Create an empty manager without persistence. For tests that don't
    /// want a DB file; production code uses `with_store`.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            blocks: Mutex::new(HashMap::new()),
            store: None,
        }
    }

    /// Create a manager that writes completed blocks to `store` and seeds
    /// each new pane with the most recent `HISTORY_SEED_LIMIT` blocks.
    pub fn with_store(store: Arc<Store>) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            blocks: Mutex::new(HashMap::new()),
            store: Some(store),
        }
    }

    /// Expose the underlying store to IPC commands that need it for non-PTY
    /// state (currently the app-state save/load path used to persist the
    /// tab + layout tree across restart).
    pub fn store(&self) -> Option<Arc<Store>> {
        self.store.clone()
    }

    /// Spawn a new PTY with a child shell and begin streaming its output to
    /// `on_event`. Returns the new `PtyId`.
    ///
    /// The shell binary is chosen from `$SHELL`, falling back to platform
    /// defaults when the variable is absent or the path is invalid. For zsh
    /// shells, an invisible ZDOTDIR shim injects the Shax OSC 133 integration
    /// without touching the user's dotfiles.
    pub async fn spawn(
        &self,
        opts: SpawnOpts,
        on_event: Channel<PtyEvent>,
    ) -> Result<PtyId, PtyError> {
        let id = PtyId::new();
        let pty_system = native_pty_system();

        let size = PtySize {
            rows: opts.rows,
            cols: opts.cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        // Build the shell command and, for zsh, inject the ZDOTDIR shim.
        let (cmd, zdotdir_tmpdir) = build_shell_command(&opts)?;

        let child: Box<dyn Child + Send + Sync> = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        // The slave end is no longer needed in this process once the child has it.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        let child = Arc::new(Mutex::new(child));

        // Create a per-pane block shared state for the reader thread, seeded
        // with the most recent historical blocks so the BlockList shows the
        // user's previous session immediately on boot. Their ids are also
        // pre-loaded into the reader's `persisted` set further down so the
        // first VT round doesn't try to re-UPSERT them (and clobber their
        // stored output bytes with the empty live cache).
        let mut shared = BlockShared::default();
        let mut seeded_ids: std::collections::HashSet<BlockId> = std::collections::HashSet::new();
        if let Some(store) = &self.store {
            match store.load_recent(HISTORY_SEED_LIMIT) {
                Ok(history) => {
                    seeded_ids = history.iter().map(|s| s.id).collect();
                    shared.summaries = history;
                }
                Err(e) => tracing::warn!("failed to load block history: {e}"),
            }
        }
        let block_shared: Arc<Mutex<BlockShared>> = Arc::new(Mutex::new(shared));
        self.blocks
            .lock()
            .await
            .insert(id, Arc::clone(&block_shared));

        let handle = PtyHandle {
            master: pair.master,
            writer: Mutex::new(writer),
            child: child.clone(),
            _zdotdir_tmpdir: zdotdir_tmpdir,
        };

        self.inner.lock().await.insert(id, handle);

        spawn_reader_task(
            id,
            reader,
            child,
            on_event,
            block_shared,
            self.store.clone(),
            seeded_ids,
        );

        tracing::info!(%id, rows = opts.rows, cols = opts.cols, "PTY spawned");
        Ok(id)
    }

    /// Write `data` (base64-encoded bytes) to the PTY master for the given pane.
    pub async fn write(&self, id: PtyId, data: &str) -> Result<(), PtyError> {
        let decoded = B64
            .decode(data)
            .map_err(|e| PtyError::InvalidInput(format!("base64 decode failed: {e}")))?;

        let guard = self.inner.lock().await;
        let handle = guard.get(&id).ok_or(PtyError::UnknownId(id))?;

        let mut writer = handle.writer.lock().await;
        writer
            .write_all(&decoded)
            .map_err(|e| PtyError::Write(e.to_string()))?;
        writer.flush().map_err(|e| PtyError::Write(e.to_string()))?;

        Ok(())
    }

    /// Resize the PTY for the given pane to the new dimensions.
    pub async fn resize(&self, id: PtyId, rows: u16, cols: u16) -> Result<(), PtyError> {
        let guard = self.inner.lock().await;
        let handle = guard.get(&id).ok_or(PtyError::UnknownId(id))?;

        let new_size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        handle
            .master
            .resize(new_size)
            .map_err(|e| PtyError::Resize(e.to_string()))?;

        tracing::debug!(%id, rows, cols, "PTY resized");
        Ok(())
    }

    /// Kill the child process for the given pane and remove it from the registry.
    ///
    /// Best-effort: if the child is already dead this is a no-op.
    pub async fn kill(&self, id: PtyId) -> Result<(), PtyError> {
        let handle = {
            let mut guard = self.inner.lock().await;
            guard.remove(&id).ok_or(PtyError::UnknownId(id))?
        };

        // Killing the child causes the reader to see EOF and exit on its own.
        let kill_result = handle.child.lock().await.kill();
        if let Err(e) = kill_result {
            tracing::debug!(%id, "kill returned error (child may already be dead): {e}");
        }

        tracing::info!(%id, "PTY killed and removed");
        Ok(())
    }

    /// Remove an entry that has already exited on its own (called from the reader
    /// task after observing EOF / child exit).
    pub(crate) async fn remove_exited(&self, id: PtyId) {
        self.inner.lock().await.remove(&id);
        tracing::debug!(%id, "PTY entry removed after natural exit");
    }

    /// Kill every spawned PTY. Called from the Tauri exit hook so child
    /// shells don't outlive the parent window — without this they keep
    /// running detached until the OS reaps them on session logout (which
    /// can be hours later on a desktop session).
    pub async fn shutdown_all(&self) {
        let ids: Vec<PtyId> = {
            let guard = self.inner.lock().await;
            guard.keys().copied().collect()
        };
        for id in ids {
            if let Err(e) = self.kill(id).await {
                tracing::debug!(%id, "shutdown_all: kill returned {e} (child may already be dead)");
            }
        }
    }

    /// Return a snapshot of the block summary list for the given pane, oldest
    /// first.  Returns an empty vec if the pane id is unknown.
    pub async fn list_blocks(&self, id: PtyId) -> Vec<BlockSummary> {
        let blocks_guard = self.blocks.lock().await;
        match blocks_guard.get(&id) {
            Some(shared) => shared.lock().await.summaries.clone(),
            None => Vec::new(),
        }
    }

    /// Return the captured output bytes for a single completed block.
    ///
    /// Lookup order: the live pane's in-memory cache first, then the
    /// persistent store. Returns an empty vec if neither knows the block
    /// (still running, unknown id, or output never captured).
    pub async fn get_block_output(&self, id: PtyId, block_id: BlockId) -> Vec<u8> {
        // Clone the per-pane Arc out, then drop the outer guard before acquiring
        // the inner mutex so we never hold both locks at once.
        if let Some(shared) = {
            let blocks_guard = self.blocks.lock().await;
            blocks_guard.get(&id).map(Arc::clone)
        } {
            let guard = shared.lock().await;
            if let Some(bytes) = guard.outputs.get(&block_id) {
                return bytes.clone();
            }
        }
        // Fall back to the store for historical blocks (and for live blocks
        // whose cache was evicted, when M4 lands eviction).
        if let Some(store) = &self.store {
            match store.load_output(block_id) {
                Ok(Some(bytes)) => return bytes,
                Ok(None) => {}
                Err(e) => tracing::warn!("store.load_output failed: {e}"),
            }
        }
        Vec::new()
    }

    /// Return the number of active PTYs. Useful in tests.
    #[cfg(all(test, unix))]
    pub async fn active_count(&self) -> usize {
        self.inner.lock().await.len()
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

// ── Reader task ────────────────────────────────────────────────────────────────

/// Spawn a blocking task that reads PTY output, runs it through the VT and
/// block state machines, and forwards events to the frontend.
///
/// Order per chunk:
/// 1. Feed bytes to the VT parser. The parser emits an interleaved stream of
///    `VtMessage::Output(bytes)` (plain print/execute bytes between escape
///    sequences) and `VtMessage::Event(...)` (recognised state transitions).
/// 2. Walk that stream in order. Plain bytes go to `push_output`, so they
///    land in whichever block is `Running` at that exact moment; events go
///    through `handle_vt_event`, which may open or close a block before the
///    next chunk of bytes is pushed. This is what lets us correctly attribute
///    output when an `OSC 133 C` and command output arrive in the same chunk.
/// 3. Forward the raw chunk to xterm.js unchanged (fidelity contract).
fn spawn_reader_task(
    id: PtyId,
    mut reader: Box<dyn std::io::Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    on_event: Channel<PtyEvent>,
    block_shared: Arc<Mutex<BlockShared>>,
    store: Option<Arc<Store>>,
    seeded_persisted: std::collections::HashSet<BlockId>,
) {
    let rt = tokio::runtime::Handle::current();

    std::thread::spawn(move || {
        use std::io::Read as _;

        let mut buf = [0u8; 4096];

        // Ids that have already been written to the store. Pre-seeded with
        // the historical block ids loaded into the BlockList on spawn so the
        // first VT round doesn't re-UPSERT those rows — which would also
        // clobber their stored output bytes with the empty live cache and
        // overwrite their original `pane_id` with this session's. From there
        // on, new completions are added as they're persisted.
        let mut persisted: std::collections::HashSet<BlockId> = seeded_persisted;

        // The VT parser and block machine live entirely inside this thread;
        // they are never moved or accessed from outside.
        let mut machine = BlockMachine::new();
        let mut vt_parser = OscParser::new(move |msg| {
            // Synchronous callback inside `vt_parser.advance()`; push the
            // message onto a thread-local queue so the loop below can drive
            // the block machine without re-entering the parser.
            VT_MSG_QUEUE.with(|q| q.borrow_mut().push(msg));
        });

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    vt_parser.advance(&buf[..n]);

                    let messages: Vec<_> =
                        VT_MSG_QUEUE.with(|q| std::mem::take(&mut *q.borrow_mut()));

                    let mut send_failed = false;
                    for msg in messages {
                        match msg {
                            VtMessage::Output(bytes) => {
                                // Capture for the block record (in-memory + DB
                                // on completion). Also forward to the frontend
                                // scoped to the active block so the running
                                // row can render output as it streams.
                                machine.push_output(&bytes);
                                let encoded = B64.encode(&bytes);
                                let scoped = if let Some(block_id) = machine.current_block_id() {
                                    Some(PtyEvent::BlockChunk {
                                        block_id,
                                        data: encoded,
                                    })
                                } else if machine.at_input_prompt() {
                                    // Only bytes between OSC 133 B and the
                                    // next C are the user's typing echo. PS1
                                    // rendering (between A and B) is dropped
                                    // from the strip's stream so the user's
                                    // customized prompt — clocks, hostnames,
                                    // glyphs — doesn't leak into the strip.
                                    // The raw `Output` event still carries
                                    // those bytes to xterm for the alt-screen
                                    // passthrough path.
                                    Some(PtyEvent::PromptChunk { data: encoded })
                                } else {
                                    None
                                };
                                if let Some(ev) = scoped {
                                    if on_event.send(ev).is_err() {
                                        send_failed = true;
                                        break;
                                    }
                                }
                            }
                            VtMessage::Event(ev) => {
                                for pty_ev in machine.handle_vt_event(ev) {
                                    if on_event.send(pty_ev).is_err() {
                                        send_failed = true;
                                        break;
                                    }
                                }
                                if send_failed {
                                    break;
                                }
                            }
                        }
                    }
                    if send_failed {
                        return;
                    }

                    // Sync block summaries and drain completed-block output bytes
                    // into the shared state so IPC can serve them. Then write any
                    // newly-completed blocks through to the store.
                    rt.block_on(async {
                        let mut shared = block_shared.lock().await;
                        machine.collect_completed_output(&mut shared.outputs);
                        let live_summaries = machine.block_summaries();
                        persist_new_blocks(
                            id,
                            &live_summaries,
                            &shared.outputs,
                            &mut persisted,
                            store.as_deref(),
                        );
                        merge_live_summaries_into_shared(&mut shared.summaries, live_summaries);
                    });

                    // Forward raw bytes to xterm.js (fidelity contract).
                    let encoded = B64.encode(&buf[..n]);
                    if on_event.send(PtyEvent::Output { data: encoded }).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!(%id, "PTY read error: {e}");
                    break;
                }
            }
        }

        // PTY exited; finalize any running block as aborted and forward the
        // resulting BlockCompleted event so the frontend's row flips before
        // the exit event arrives.
        for ev in machine.finalize_on_exit() {
            if on_event.send(ev).is_err() {
                break;
            }
        }
        rt.block_on(async {
            let mut shared = block_shared.lock().await;
            machine.collect_completed_output(&mut shared.outputs);
            let live_summaries = machine.block_summaries();
            persist_new_blocks(
                id,
                &live_summaries,
                &shared.outputs,
                &mut persisted,
                store.as_deref(),
            );
            merge_live_summaries_into_shared(&mut shared.summaries, live_summaries);
        });

        let exit_code: Option<i32> = rt.block_on(async {
            let mut child_guard = child.lock().await;
            match child_guard.wait() {
                Ok(status) => i32::try_from(status.exit_code()).ok(),
                Err(e) => {
                    tracing::warn!(%id, "wait() error: {e}");
                    None
                }
            }
        });

        let _ = on_event.send(PtyEvent::Exit { code: exit_code });
        tracing::info!(%id, ?exit_code, "PTY reader task finished");

        rt.spawn(async move {
            remove_exited_global(id).await;
        });
    });
}

// Thread-local queue so the VT parser closure can hand the interleaved
// message stream back to the reader loop without needing `Send`.
std::thread_local! {
    static VT_MSG_QUEUE: std::cell::RefCell<Vec<crate::vt::VtMessage>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Merge the live machine's summaries into the per-pane shared list, which
/// may already contain historical blocks loaded from the store on spawn.
///
/// Historical blocks (those not present in `live`) are kept where they sit,
/// in their original chronological position. Live blocks are appended after
/// the historical ones, in machine order.
fn merge_live_summaries_into_shared(shared: &mut Vec<BlockSummary>, live: Vec<BlockSummary>) {
    use std::collections::HashSet;
    let live_ids: HashSet<BlockId> = live.iter().map(|s| s.id).collect();
    // Drop any prior live snapshot from `shared`; historical (un-touched) rows
    // are preserved.
    shared.retain(|s| !live_ids.contains(&s.id));
    shared.extend(live);
}

/// Write any completed-and-not-yet-persisted summaries through to the store,
/// pulling their output bytes from the per-pane cache. Already-persisted ids
/// are skipped via `persisted`. Running blocks (no `ended_at_ms`) are also
/// skipped — only completed/aborted rows make it to disk.
fn persist_new_blocks(
    pane_id: PtyId,
    live: &[BlockSummary],
    outputs: &HashMap<BlockId, Vec<u8>>,
    persisted: &mut std::collections::HashSet<BlockId>,
    store: Option<&Store>,
) {
    let Some(store) = store else { return };
    for summary in live {
        if summary.ended_at_ms.is_none() {
            continue;
        }
        if persisted.contains(&summary.id) {
            continue;
        }
        let block = PersistedBlock {
            id: summary.id,
            pane_id,
            command: summary.command.clone(),
            cwd: summary.cwd.clone(),
            git_branch: summary.git_branch.clone(),
            started_at_ms: summary.started_at_ms,
            ended_at_ms: summary.ended_at_ms,
            exit_code: summary.exit_code,
            duration_ms: summary.duration_ms,
            aborted: summary.aborted,
            interactive: summary.interactive,
            output: outputs.get(&summary.id).cloned().unwrap_or_default(),
        };
        if let Err(e) = store.insert_block(&block) {
            tracing::warn!("store.insert_block failed: {e}");
            continue;
        }
        persisted.insert(summary.id);
    }
}

// ── Shell builder ──────────────────────────────────────────────────────────────

/// Embedded shell integration scripts (bundled at compile time).
const SHAX_ZSH: &str = include_str!("../../shell-integration/shax.zsh");
const SHAX_BASH: &str = include_str!("../../shell-integration/shax.bash");
const SHAX_FISH: &str = include_str!("../../shell-integration/shax.fish");

/// Build the shell `CommandBuilder` from spawn options.
///
/// Returns the command and, when the resolved shell is one we ship
/// integration for, a `TempDir` holding the per-shell shim. The `TempDir`
/// must be kept alive for the PTY's lifetime so the shell can keep
/// reading from it.
fn build_shell_command(
    opts: &SpawnOpts,
) -> Result<(CommandBuilder, Option<tempfile::TempDir>), PtyError> {
    let shell = resolve_shell(opts);
    let mut cmd = CommandBuilder::new(&shell);

    // Inherit the parent environment so the shell starts with a sane PATH,
    // HOME, TERM, etc.
    for (key, val) in std::env::vars_os() {
        cmd.env(&key, &val);
    }
    cmd.env("TERM", "xterm-256color");

    let cwd = opts.cwd.clone().or_else(|| std::env::var("HOME").ok());
    if let Some(ref cwd) = cwd {
        cmd.cwd(cwd);
    }

    if let Some(ref env) = opts.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    // Dispatch on the resolved shell kind. Each integration uses a
    // per-PTY tempdir + a shell-specific shim so the user's dotfiles are
    // never touched. The tempdir handle is returned to the caller so it
    // lives as long as the PTY does.
    let integration_tmpdir = match classify_shell(&shell) {
        ShellKind::Zsh => match create_zdotdir_shim(&mut cmd) {
            Ok(tmpdir) => Some(tmpdir),
            Err(e) => {
                tracing::warn!("zsh ZDOTDIR shim failed, OSC 133 will not fire: {e}");
                None
            }
        },
        ShellKind::Bash => match create_bash_rcfile_shim(&mut cmd) {
            Ok(tmpdir) => Some(tmpdir),
            Err(e) => {
                tracing::warn!("bash rcfile shim failed, OSC 133 will not fire: {e}");
                None
            }
        },
        ShellKind::Fish => match create_fish_xdg_shim(&mut cmd) {
            Ok(tmpdir) => Some(tmpdir),
            Err(e) => {
                tracing::warn!("fish XDG_CONFIG_HOME shim failed, OSC 133 will not fire: {e}");
                None
            }
        },
        ShellKind::Other => None,
    };

    Ok((cmd, integration_tmpdir))
}

/// Which shell family the resolved binary belongs to. Detected by basename
/// to match common install paths (`/bin/zsh`, `/usr/local/bin/bash`,
/// `/opt/homebrew/bin/fish`, plain `zsh`, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellKind {
    Zsh,
    Bash,
    Fish,
    Other,
}

fn classify_shell(shell: &str) -> ShellKind {
    // Strip a trailing path separator and take the final segment as basename.
    let basename = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    match basename {
        "zsh" => ShellKind::Zsh,
        "bash" => ShellKind::Bash,
        "fish" => ShellKind::Fish,
        _ => ShellKind::Other,
    }
}

#[cfg(test)]
fn shell_is_zsh(shell: &str) -> bool {
    matches!(classify_shell(shell), ShellKind::Zsh)
}

/// Create a per-PTY temp directory containing the ZDOTDIR shim files and
/// configure `cmd` to use it.  The caller holds the `TempDir` alive.
fn create_zdotdir_shim(cmd: &mut CommandBuilder) -> Result<tempfile::TempDir, PtyError> {
    use std::fs;

    let tmpdir = tempfile::TempDir::new()
        .map_err(|e| PtyError::Spawn(format!("tempdir for ZDOTDIR shim: {e}")))?;
    let dir = tmpdir.path();

    // The user's real ZDOTDIR (if they set one); we'll source it from our shim.
    let real_zdotdir = std::env::var("ZDOTDIR").ok();

    // Write shax.zsh into the temp dir.
    fs::write(dir.join("shax.zsh"), SHAX_ZSH)
        .map_err(|e| PtyError::Spawn(format!("write shax.zsh: {e}")))?;

    // Each shim file temporarily switches ZDOTDIR to the user's real value
    // while sourcing the corresponding user dotfile, then restores ZDOTDIR
    // to the temp dir so zsh's *next* file lookup (.zprofile, .zshrc, .zlogin)
    // still finds *our* shim. After the last hop (.zshrc) we leave ZDOTDIR
    // pointing at the user's value so interactive use sees what they expect.
    let chain = |user_file: &str, post: &str| -> String {
        format!(
            "_shax_user_zdotdir=\"${{SHAX_REAL_ZDOTDIR:-$HOME}}\"\n\
             if [[ -f \"$_shax_user_zdotdir/{user_file}\" ]]; then\n\
               _shax_shim_zdotdir=\"$ZDOTDIR\"\n\
               ZDOTDIR=\"$_shax_user_zdotdir\"\n\
               source \"$_shax_user_zdotdir/{user_file}\"\n\
               ZDOTDIR=\"$_shax_shim_zdotdir\"\n\
             fi\n\
             {post}",
        )
    };

    fs::write(dir.join(".zshenv"), chain(".zshenv", ""))
        .map_err(|e| PtyError::Spawn(format!("write .zshenv: {e}")))?;

    fs::write(dir.join(".zprofile"), chain(".zprofile", ""))
        .map_err(|e| PtyError::Spawn(format!("write .zprofile: {e}")))?;

    fs::write(
        dir.join(".zshrc"),
        chain(
            ".zshrc",
            "source \"$SHAX_INTEGRATION_DIR/shax.zsh\"\n\
             ZDOTDIR=\"$_shax_user_zdotdir\"\n\
             unset _shax_user_zdotdir _shax_shim_zdotdir\n",
        ),
    )
    .map_err(|e| PtyError::Spawn(format!("write .zshrc: {e}")))?;

    fs::write(dir.join(".zlogin"), chain(".zlogin", ""))
        .map_err(|e| PtyError::Spawn(format!("write .zlogin: {e}")))?;

    // Set env vars on the child.
    let dir_str = dir
        .to_str()
        .ok_or_else(|| PtyError::Spawn("ZDOTDIR temp path is not valid UTF-8".into()))?;

    if let Some(ref real) = real_zdotdir {
        cmd.env("SHAX_REAL_ZDOTDIR", real);
    }
    cmd.env("SHAX_INTEGRATION_DIR", dir_str);
    cmd.env("ZDOTDIR", dir_str);

    Ok(tmpdir)
}

/// Create a per-PTY tempdir with `shax.bash` plus an `rcfile` that bash
/// will source instead of `~/.bashrc`. The rcfile sources the user's
/// real bashrc first, then our integration, so user customisations win
/// for everything except the OSC 133 hooks we install at the end.
///
/// Bash is invoked as `bash --rcfile <tmpdir>/rcfile -i`; the `-i`
/// guarantees interactive mode so the rcfile is actually read.
fn create_bash_rcfile_shim(cmd: &mut CommandBuilder) -> Result<tempfile::TempDir, PtyError> {
    use std::fs;

    let tmpdir = tempfile::TempDir::new()
        .map_err(|e| PtyError::Spawn(format!("tempdir for bash rcfile shim: {e}")))?;
    let dir = tmpdir.path();

    fs::write(dir.join("shax.bash"), SHAX_BASH)
        .map_err(|e| PtyError::Spawn(format!("write shax.bash: {e}")))?;

    // The rcfile bash sources on startup. We source `~/.bashrc` (if it
    // exists) before our integration so the user's PROMPT_COMMAND, aliases,
    // and DEBUG traps (if any) are in place when our integration chains
    // onto them. `${BASH_SOURCE[0]}` and friends are intentionally not used
    // — the path is fixed at spawn time.
    let rcfile = "_shax_user_bashrc=\"${HOME}/.bashrc\"\n\
                  if [ -f \"$_shax_user_bashrc\" ]; then\n  \
                    . \"$_shax_user_bashrc\"\n\
                  fi\n\
                  unset _shax_user_bashrc\n\
                  . \"$SHAX_INTEGRATION_DIR/shax.bash\"\n";
    fs::write(dir.join("rcfile"), rcfile)
        .map_err(|e| PtyError::Spawn(format!("write bash rcfile: {e}")))?;

    let dir_str = dir
        .to_str()
        .ok_or_else(|| PtyError::Spawn("bash shim temp path is not valid UTF-8".into()))?;
    cmd.env("SHAX_INTEGRATION_DIR", dir_str);
    cmd.arg("--rcfile");
    cmd.arg(dir.join("rcfile"));
    cmd.arg("-i");

    Ok(tmpdir)
}

/// Create a per-PTY tempdir laid out as a fish `XDG_CONFIG_HOME` (i.e. with
/// a `fish/config.fish` inside). The config.fish sources the user's real
/// fish config first and then our integration. The `SHAX_REAL_XDG_CONFIG_HOME`
/// env var preserves the user's original value, falling back to `~/.config`.
fn create_fish_xdg_shim(cmd: &mut CommandBuilder) -> Result<tempfile::TempDir, PtyError> {
    use std::fs;

    let tmpdir = tempfile::TempDir::new()
        .map_err(|e| PtyError::Spawn(format!("tempdir for fish XDG shim: {e}")))?;
    let dir = tmpdir.path();
    let fish_dir = dir.join("fish");
    fs::create_dir_all(&fish_dir)
        .map_err(|e| PtyError::Spawn(format!("create fish shim dir: {e}")))?;

    fs::write(fish_dir.join("shax.fish"), SHAX_FISH)
        .map_err(|e| PtyError::Spawn(format!("write shax.fish: {e}")))?;

    // The shim config: source the user's real fish config (if any) from
    // their original XDG_CONFIG_HOME (or `~/.config`), then our integration.
    let config = "set -l _shax_user_xdg \"$SHAX_REAL_XDG_CONFIG_HOME\"\n\
                  if test -z \"$_shax_user_xdg\"\n  \
                    set _shax_user_xdg \"$HOME/.config\"\n\
                  end\n\
                  set -l _shax_user_config \"$_shax_user_xdg/fish/config.fish\"\n\
                  if test -f \"$_shax_user_config\"\n  \
                    source \"$_shax_user_config\"\n\
                  end\n\
                  source \"$SHAX_INTEGRATION_DIR/fish/shax.fish\"\n";
    fs::write(fish_dir.join("config.fish"), config)
        .map_err(|e| PtyError::Spawn(format!("write fish config.fish: {e}")))?;

    let dir_str = dir
        .to_str()
        .ok_or_else(|| PtyError::Spawn("fish shim temp path is not valid UTF-8".into()))?;
    let real_xdg = std::env::var_os("XDG_CONFIG_HOME");
    if let Some(ref real) = real_xdg {
        cmd.env("SHAX_REAL_XDG_CONFIG_HOME", real);
    }
    // SHAX_INTEGRATION_DIR points at the tempdir root; the config.fish
    // sources `$SHAX_INTEGRATION_DIR/fish/shax.fish`. Keep them on the
    // same key as zsh/bash for symmetry.
    cmd.env("SHAX_INTEGRATION_DIR", dir_str);
    cmd.env("XDG_CONFIG_HOME", dir_str);

    Ok(tmpdir)
}

/// Resolve the shell binary. Precedence:
/// 1. `SHELL` in the caller-supplied `opts.env` (lets tests pick a shell
///    without mutating process-global env).
/// 2. The process's own `$SHELL` env var.
/// 3. An OS-specific fallback.
fn resolve_shell(opts: &SpawnOpts) -> String {
    if let Some(env) = &opts.env {
        if let Some(shell) = env.get("SHELL") {
            if !shell.is_empty() {
                return shell.clone();
            }
        }
    }
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return shell;
        }
    }

    #[cfg(target_os = "macos")]
    return "/bin/zsh".to_owned();

    #[cfg(target_os = "linux")]
    return "/bin/bash".to_owned();

    #[cfg(target_os = "windows")]
    return "cmd.exe".to_owned();

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return "/bin/sh".to_owned();
}

// ── Global manager bridge ──────────────────────────────────────────────────────
//
// The reader task needs to remove its own entry from the PtyManager after the
// child exits. Tauri `State` is not accessible from arbitrary threads, so we
// use a module-level `OnceLock` to hold a weak reference to the shared manager.
// `lib.rs` sets this during `run()`.

static GLOBAL_MANAGER: OnceLock<Arc<PtyManager>> = OnceLock::new();

/// Called by `lib.rs` after constructing the manager so reader tasks can reach
/// it without going through Tauri State.
pub fn set_global_manager(manager: Arc<PtyManager>) {
    let _ = GLOBAL_MANAGER.set(manager);
}

async fn remove_exited_global(id: PtyId) {
    if let Some(mgr) = GLOBAL_MANAGER.get() {
        mgr.remove_exited(id).await;
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use tokio::sync::mpsc;

    /// Build a `Channel<PtyEvent>` backed by an in-process mpsc queue so tests
    /// can receive events without a real Tauri runtime.
    #[cfg(unix)]
    fn make_test_channel() -> (Channel<PtyEvent>, mpsc::UnboundedReceiver<PtyEvent>) {
        let (tx, rx) = mpsc::unbounded_channel::<PtyEvent>();
        let channel = Channel::new(move |event| {
            if let Ok(ev) = event.deserialize::<PtyEvent>() {
                let _ = tx.send(ev);
            }
            Ok(())
        });
        (channel, rx)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lifecycle_spawn_write_read_kill() {
        let manager = Arc::new(PtyManager::new());
        set_global_manager(Arc::clone(&manager));

        let (channel, mut rx) = make_test_channel();

        let opts = SpawnOpts {
            rows: 24,
            cols: 80,
            cwd: None,
            env: None,
        };

        let id = manager
            .spawn(opts, channel)
            .await
            .expect("spawn should succeed");

        // Give the shell a moment to start and emit its prompt.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // Drain any prompt output already queued.
        while rx.try_recv().is_ok() {}

        // Write a simple command.
        let input = B64.encode(b"echo shax_test_marker\n");
        manager
            .write(id, &input)
            .await
            .expect("write should succeed");

        // Wait for output containing our marker.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut found = false;
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Some(PtyEvent::Output { data })) => {
                    let decoded = B64.decode(&data).unwrap_or_default();
                    if String::from_utf8_lossy(&decoded).contains("shax_test_marker") {
                        found = true;
                        break;
                    }
                }
                Ok(Some(PtyEvent::Exit { .. })) => break,
                Ok(Some(_)) => {} // AltScreenChanged, BlockStarted, BlockCompleted
                Ok(None) => break,
                Err(_) => {}
            }
        }

        assert!(found, "expected 'shax_test_marker' in PTY output");

        // Kill the pane.
        manager.kill(id).await.expect("kill should succeed");

        // After kill the manager should have removed the entry.
        assert_eq!(
            manager.active_count().await,
            0,
            "manager table should be empty after kill"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_all_kills_every_spawned_pty() {
        // Spawn several PTYs, then verify shutdown_all reaps them all.
        // Without this, an app quit leaves orphan shells alive.
        let manager = Arc::new(PtyManager::new());
        set_global_manager(Arc::clone(&manager));

        for _ in 0..3 {
            let (channel, _rx) = make_test_channel();
            let opts = SpawnOpts {
                rows: 24,
                cols: 80,
                cwd: None,
                env: None,
            };
            manager.spawn(opts, channel).await.expect("spawn");
        }
        assert_eq!(manager.active_count().await, 3);

        manager.shutdown_all().await;

        assert_eq!(
            manager.active_count().await,
            0,
            "shutdown_all should empty the manager",
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resize_does_not_crash() {
        let manager = Arc::new(PtyManager::new());
        set_global_manager(Arc::clone(&manager));

        let (channel, _rx) = make_test_channel();

        let opts = SpawnOpts {
            rows: 24,
            cols: 80,
            cwd: None,
            env: None,
        };

        let id = manager.spawn(opts, channel).await.expect("spawn");

        for (rows, cols) in [(30u16, 100u16), (20, 60), (48, 200)] {
            manager
                .resize(id, rows, cols)
                .await
                .expect("resize should not error");
        }

        manager.kill(id).await.expect("kill");
    }

    #[tokio::test]
    async fn write_unknown_id_returns_error() {
        let manager = PtyManager::new();
        let unknown = PtyId::new();
        let data = B64.encode(b"hello");
        let result = manager.write(unknown, &data).await;
        assert!(
            matches!(result, Err(PtyError::UnknownId(_))),
            "expected UnknownId error, got: {result:?}"
        );
    }

    #[test]
    fn classify_shell_recognises_zsh_bash_fish() {
        assert_eq!(classify_shell("zsh"), ShellKind::Zsh);
        assert_eq!(classify_shell("/bin/zsh"), ShellKind::Zsh);
        assert_eq!(classify_shell("/usr/local/bin/zsh"), ShellKind::Zsh);
        assert_eq!(classify_shell("bash"), ShellKind::Bash);
        assert_eq!(classify_shell("/bin/bash"), ShellKind::Bash);
        assert_eq!(classify_shell("/opt/homebrew/bin/bash"), ShellKind::Bash);
        assert_eq!(classify_shell("fish"), ShellKind::Fish);
        assert_eq!(classify_shell("/usr/local/bin/fish"), ShellKind::Fish);
        assert_eq!(classify_shell("/opt/homebrew/bin/fish"), ShellKind::Fish);
        assert_eq!(classify_shell("/bin/sh"), ShellKind::Other);
        assert_eq!(classify_shell("/usr/bin/dash"), ShellKind::Other);
    }

    /// Back-compat alias for the helper used by the public test below;
    /// kept narrow so the rest of the codebase has one entry point.
    #[test]
    fn shell_is_zsh_detection() {
        assert!(shell_is_zsh("zsh"));
        assert!(shell_is_zsh("/bin/zsh"));
        assert!(shell_is_zsh("/usr/local/bin/zsh"));
        assert!(!shell_is_zsh("/bin/bash"));
        assert!(!shell_is_zsh("fish"));
    }

    #[test]
    fn zdotdir_shim_creates_expected_files() {
        let mut dummy_cmd = CommandBuilder::new("zsh");
        let tmpdir = create_zdotdir_shim(&mut dummy_cmd).expect("shim creation should succeed");
        let dir = tmpdir.path();
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin", "shax.zsh"] {
            assert!(
                dir.join(name).exists(),
                "expected shim file not found: {name}"
            );
        }
    }

    #[test]
    fn bash_rcfile_shim_creates_expected_files() {
        let mut dummy_cmd = CommandBuilder::new("bash");
        let tmpdir = create_bash_rcfile_shim(&mut dummy_cmd).expect("shim creation should succeed");
        let dir = tmpdir.path();
        for name in ["rcfile", "shax.bash"] {
            assert!(
                dir.join(name).exists(),
                "expected shim file not found: {name}"
            );
        }
        // The rcfile must source the user's bashrc AND our integration so a
        // user with no .bashrc still gets OSC 133, and one with an existing
        // .bashrc keeps their customisations.
        let rcfile = std::fs::read_to_string(dir.join("rcfile")).expect("read rcfile");
        assert!(
            rcfile.contains(".bashrc"),
            "rcfile must reference ~/.bashrc, got: {rcfile}",
        );
        assert!(
            rcfile.contains("shax.bash"),
            "rcfile must source shax.bash, got: {rcfile}",
        );
    }

    /// Best-effort lookup of a shell binary on `PATH`. Returns `None` when
    /// the binary isn't installed, so live-shell integration tests can skip
    /// cleanly on CI runners that don't have fish (etc.).
    #[cfg(unix)]
    fn shell_on_path(name: &str) -> Option<String> {
        let output = std::process::Command::new("/usr/bin/which")
            .arg(name)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8(output.stdout).ok()?.trim().to_owned();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    }

    /// Spawn a real `bash -i` through the rcfile shim, run a command in a
    /// disposable cwd, and assert that a clean BlockCompleted with cwd
    /// from `shax.bash` arrives. This is the smallest end-to-end proof that
    /// the integration is wired into the right place and fires for a real
    /// user command.
    #[cfg(unix)]
    #[tokio::test]
    async fn bash_integration_emits_block_with_cwd() {
        let Some(bash) = shell_on_path("bash") else {
            eprintln!("skipping bash integration test: bash not on PATH");
            return;
        };
        let manager = Arc::new(PtyManager::new());
        set_global_manager(Arc::clone(&manager));

        let (channel, mut rx) = make_test_channel();

        // Spawn bash inside an isolated empty HOME so the user's real
        // ~/.bashrc doesn't perturb the test, and pin SHELL to bash so our
        // resolver picks it.
        let home = tempfile::tempdir().expect("tempdir");
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("SHELL".into(), bash.clone());
        env.insert("HOME".into(), home.path().display().to_string());

        let id = manager
            .spawn(
                SpawnOpts {
                    rows: 24,
                    cols: 80,
                    cwd: Some(home.path().display().to_string()),
                    env: Some(env),
                },
                channel,
            )
            .await
            .expect("spawn");

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        while rx.try_recv().is_ok() {}

        manager
            .write(id, &B64.encode(b"true\n"))
            .await
            .expect("write");

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut got_cwd: Option<String> = None;
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Some(PtyEvent::BlockCompleted {
                    aborted: false,
                    cwd,
                    ..
                })) => {
                    got_cwd = cwd;
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }

        assert!(
            got_cwd.is_some(),
            "bash integration must emit a BlockCompleted with the cwd it ran in"
        );
        // The cwd resolves through symlinks (e.g. /var → /private/var on
        // macOS), so compare on the basename to keep the assertion portable.
        let cwd = got_cwd.unwrap();
        let basename = std::path::Path::new(&cwd)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let expected_basename = home
            .path()
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        assert_eq!(
            basename, expected_basename,
            "bash should report the tempdir HOME as its cwd, got {cwd}",
        );

        manager.kill(id).await.expect("kill");
    }

    /// `PS1` command substitutions (`$(git branch)`, `$(date)`, etc.) run
    /// in subshells and fire the bash `DEBUG` trap. Without filtering them
    /// out we'd emit a phantom `OSC 133 C` for each one, steal output
    /// attribution from the real user command, and starve the UI with
    /// re-renders. This regression test pins the PS1 expansion fix.
    #[cfg(unix)]
    #[tokio::test]
    async fn bash_integration_ignores_ps1_command_substitutions() {
        let Some(bash) = shell_on_path("bash") else {
            eprintln!("skipping bash PS1 substitution test: bash not on PATH");
            return;
        };
        let manager = Arc::new(PtyManager::new());
        set_global_manager(Arc::clone(&manager));

        let (channel, mut rx) = make_test_channel();

        // Set a PS1 that runs an external command (`true` is universal and
        // produces no output). Without the BASH_SUBSHELL filter, this would
        // emit a phantom OSC 133 C on every prompt redraw.
        let home = tempfile::tempdir().expect("tempdir");
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("SHELL".into(), bash.clone());
        env.insert("HOME".into(), home.path().display().to_string());
        env.insert("PS1".into(), "$(true)$(true)\\$ ".into());

        let id = manager
            .spawn(
                SpawnOpts {
                    rows: 24,
                    cols: 80,
                    cwd: Some(home.path().display().to_string()),
                    env: Some(env),
                },
                channel,
            )
            .await
            .expect("spawn");

        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        while rx.try_recv().is_ok() {}

        manager
            .write(id, &B64.encode(b"true\n"))
            .await
            .expect("write");

        // Collect every BlockStarted that arrives in the next second. With
        // the filter in place there should be exactly one — for the user's
        // `true`. Without it, each `$(...)` in PS1 would add another.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut starts = 0usize;
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Some(PtyEvent::BlockStarted { .. })) => starts += 1,
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }
        assert_eq!(
            starts, 1,
            "expected exactly one BlockStarted for the user's `true`; saw {starts} (PS1 \
             $() expansions are leaking through the DEBUG-trap filter)"
        );

        manager.kill(id).await.expect("kill");
    }

    /// Same end-to-end proof as the bash test but for fish.
    ///
    /// fish 4.x sends a Primary Device Attribute query (`\e[c`) on startup
    /// and waits up to 10 seconds for the terminal to respond. Our test PTY
    /// has no UI on the other end, so the response never arrives and fish
    /// stalls for the full timeout before it starts reading the user's
    /// commands. We work around this by writing the test command upfront —
    /// fish buffers it and processes it after init — and giving the test
    /// a deadline long enough to absorb the DA timeout.
    #[cfg(unix)]
    #[tokio::test]
    async fn fish_integration_emits_block_with_cwd() {
        let Some(fish) = shell_on_path("fish") else {
            eprintln!("skipping fish integration test: fish not on PATH");
            return;
        };
        let manager = Arc::new(PtyManager::new());
        set_global_manager(Arc::clone(&manager));

        let (channel, mut rx) = make_test_channel();

        let home = tempfile::tempdir().expect("tempdir");
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("SHELL".into(), fish.clone());
        env.insert("HOME".into(), home.path().display().to_string());

        let id = manager
            .spawn(
                SpawnOpts {
                    rows: 24,
                    cols: 80,
                    cwd: Some(home.path().display().to_string()),
                    env: Some(env),
                },
                channel,
            )
            .await
            .expect("spawn");

        // Pre-write the command so fish has it queued by the time it
        // finishes its 10s DA-query timeout and starts reading stdin.
        manager
            .write(id, &B64.encode(b"true\n"))
            .await
            .expect("write");

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut got_cwd: Option<String> = None;
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Some(PtyEvent::BlockCompleted {
                    aborted: false,
                    cwd,
                    ..
                })) => {
                    got_cwd = cwd;
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }

        assert!(
            got_cwd.is_some(),
            "fish integration must emit a BlockCompleted with the cwd it ran in"
        );
        let cwd = got_cwd.unwrap();
        let basename = std::path::Path::new(&cwd)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let expected_basename = home
            .path()
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        assert_eq!(
            basename, expected_basename,
            "fish should report the tempdir HOME as its cwd, got {cwd}",
        );

        manager.kill(id).await.expect("kill");
    }

    #[test]
    fn fish_xdg_shim_creates_expected_files() {
        let mut dummy_cmd = CommandBuilder::new("fish");
        let tmpdir = create_fish_xdg_shim(&mut dummy_cmd).expect("shim creation should succeed");
        let dir = tmpdir.path();
        let fish_dir = dir.join("fish");
        for name in ["config.fish", "shax.fish"] {
            assert!(
                fish_dir.join(name).exists(),
                "expected shim file not found: fish/{name}",
            );
        }
        // The config.fish must source the user's real fish config and our
        // integration. Source path for our integration uses the SHAX_*
        // env var so the script doesn't bake the tempdir path.
        let config = std::fs::read_to_string(fish_dir.join("config.fish")).expect("read config");
        assert!(
            config.contains("config.fish"),
            "fish shim must reference the user's config.fish, got: {config}",
        );
        assert!(
            config.contains("shax.fish"),
            "fish shim must source shax.fish, got: {config}",
        );
    }

    #[tokio::test]
    async fn list_blocks_returns_empty_for_unknown_pane() {
        let manager = PtyManager::new();
        let unknown = PtyId::new();
        let result = manager.list_blocks(unknown).await;
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn get_block_output_returns_empty_for_unknown_ids() {
        let manager = PtyManager::new();
        let unknown_pty = PtyId::new();
        let unknown_block = BlockId(Uuid::new_v4());
        let bytes = manager.get_block_output(unknown_pty, unknown_block).await;
        assert!(bytes.is_empty());
    }

    /// The first VT round of a freshly spawned pane must not re-UPSERT the
    /// historical blocks that were just loaded into the BlockList — doing
    /// so would clobber their stored output bytes (the live cache is empty
    /// at that point) and overwrite their original `pane_id` with the new
    /// session's id. The seeded `persisted` set is what prevents that.
    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_preserves_historical_block_output_on_first_round() {
        use crate::store::PersistedBlock;

        let store = Arc::new(Store::open_in_memory().expect("open store"));
        // Pre-populate a historical block with real output bytes and a
        // specific pane_id from an "earlier session".
        let earlier_pane = PtyId::new();
        let historical = PersistedBlock {
            id: BlockId(Uuid::new_v4()),
            pane_id: earlier_pane,
            command: Some("ls".into()),
            cwd: Some("/Users/me".into()),
            git_branch: Some("main".into()),
            started_at_ms: 1000,
            ended_at_ms: Some(1050),
            exit_code: Some(0),
            duration_ms: Some(50),
            aborted: false,
            interactive: false,
            output: b"a.txt b.txt".to_vec(),
        };
        store.insert_block(&historical).expect("seed historical");

        let manager = Arc::new(PtyManager::with_store(Arc::clone(&store)));
        set_global_manager(Arc::clone(&manager));

        let (channel, _rx) = make_test_channel();
        let id = manager
            .spawn(
                SpawnOpts {
                    rows: 24,
                    cols: 80,
                    cwd: None,
                    env: None,
                },
                channel,
            )
            .await
            .expect("spawn");

        // Drive a short delay so the reader thread has time to process the
        // shell's first prompt chunk (which is what would have triggered the
        // bad re-UPSERT prior to this fix).
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // The stored output must still be the historical bytes — not empty.
        let bytes = store.load_output(historical.id).expect("load_output");
        assert_eq!(
            bytes.as_deref(),
            Some(&b"a.txt b.txt"[..]),
            "historical output must not be clobbered by an empty re-UPSERT on first VT round",
        );

        manager.kill(id).await.expect("kill");
    }

    /// New pane spawns seed `BlockShared.summaries` with the most recent
    /// blocks from the store so the BlockList shows previous-session history
    /// the moment the user opens the app.
    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_seeds_block_list_from_store() {
        use crate::store::PersistedBlock;

        let store = Arc::new(Store::open_in_memory().expect("open store"));
        // Pre-populate with one historical block from an earlier session.
        let historical_pane = PtyId::new();
        let historical = PersistedBlock {
            id: BlockId(Uuid::new_v4()),
            pane_id: historical_pane,
            command: Some("git status".into()),
            cwd: Some("/Users/me/repo".into()),
            git_branch: Some("main".into()),
            started_at_ms: 1000,
            ended_at_ms: Some(1010),
            exit_code: Some(0),
            duration_ms: Some(10),
            aborted: false,
            interactive: false,
            output: b"clean".to_vec(),
        };
        store.insert_block(&historical).expect("insert historical");

        let manager = Arc::new(PtyManager::with_store(Arc::clone(&store)));
        set_global_manager(Arc::clone(&manager));

        let (channel, _rx) = make_test_channel();
        let id = manager
            .spawn(
                SpawnOpts {
                    rows: 24,
                    cols: 80,
                    cwd: None,
                    env: None,
                },
                channel,
            )
            .await
            .expect("spawn");

        let summaries = manager.list_blocks(id).await;
        assert!(
            summaries.iter().any(|s| s.id == historical.id),
            "expected historical block to appear in the new pane's BlockList"
        );

        // get_block_output for a historical id should fall through to the store.
        let bytes = manager.get_block_output(id, historical.id).await;
        assert_eq!(bytes, b"clean");

        manager.kill(id).await.expect("kill");
    }

    /// Drive a real PTY-backed shell with raw OSC 133 escapes via `printf`
    /// and assert the captured output of the *cleanly closed* inner block
    /// contains the body bytes.
    ///
    /// Bypasses Shax's zsh shell-integration so the test is portable across
    /// unix runners regardless of `$SHELL`. The key behaviour under test:
    /// even when the OSC 133 C, the body, and the OSC 133 D all arrive in
    /// the same `read()` chunk, the interleaved VtMessage stream attributes
    /// the body bytes to the block opened by that C — which is exactly the
    /// case real shells produce when a command emits short output.
    #[cfg(unix)]
    #[tokio::test]
    async fn osc133_round_trip_through_pty_captures_body_in_clean_block() {
        let manager = Arc::new(PtyManager::new());
        set_global_manager(Arc::clone(&manager));

        let (channel, mut rx) = make_test_channel();

        let opts = SpawnOpts {
            rows: 24,
            cols: 80,
            cwd: None,
            env: None,
        };

        let id = manager.spawn(opts, channel).await.expect("spawn");

        // Let the shell come up and drain its prompt noise.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        while rx.try_recv().is_ok() {}

        // The shell's preexec (under zsh integration) emits its own OSC C
        // for the typed printf command; then printf emits a complete C..D
        // cycle of its own. Double-C closes the preexec block as aborted,
        // and the inner C opens the block that the body bytes belong to,
        // which is closed cleanly by the inner D.
        let line = b"printf '\\033]133;C;inner\\007BODYMARKER\\n\\033]133;D;0\\007'\n";
        manager.write(id, &B64.encode(line)).await.expect("write");

        // Wait for the first non-aborted BlockCompleted — that's the inner
        // block that carries the body bytes.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut clean_block: Option<BlockId> = None;
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Some(PtyEvent::BlockCompleted {
                    block_id,
                    aborted: false,
                    ..
                })) => {
                    clean_block = Some(block_id);
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }

        let block_id = clean_block.expect("expected a clean BlockCompleted event");

        // Give the reader thread a moment to drain output into shared state.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let bytes = manager.get_block_output(id, block_id).await;
        let s = String::from_utf8_lossy(&bytes);
        assert!(
            s.contains("BODYMARKER"),
            "expected captured output of the clean block to contain BODYMARKER, got {s:?}"
        );

        manager.kill(id).await.expect("kill");
    }

    /// While a block is running, each chunk of VT-parsed output must be
    /// re-emitted as a `BlockChunk` event scoped to that block. Concatenated,
    /// the chunks for one block must reconstruct the body bytes between C
    /// and D. This is the contract the frontend's inline-output rendering
    /// relies on.
    #[cfg(unix)]
    #[tokio::test]
    async fn block_chunks_carry_output_bytes_while_running() {
        let manager = Arc::new(PtyManager::new());
        set_global_manager(Arc::clone(&manager));

        let (channel, mut rx) = make_test_channel();

        let opts = SpawnOpts {
            rows: 24,
            cols: 80,
            cwd: None,
            env: None,
        };

        let id = manager.spawn(opts, channel).await.expect("spawn");

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        while rx.try_recv().is_ok() {}

        let line = b"printf '\\033]133;C;inner\\007CHUNKMARKER\\n\\033]133;D;0\\007'\n";
        manager.write(id, &B64.encode(line)).await.expect("write");

        // Collect BlockChunk events keyed by block_id and the BlockCompleted
        // event for the inner block — that's the one whose chunks must
        // reconstruct CHUNKMARKER.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut chunks: HashMap<BlockId, Vec<u8>> = HashMap::new();
        let mut clean_block: Option<BlockId> = None;
        while tokio::time::Instant::now() < deadline && clean_block.is_none() {
            match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Some(PtyEvent::BlockChunk { block_id, data })) => {
                    let decoded = B64.decode(&data).unwrap_or_default();
                    chunks.entry(block_id).or_default().extend(decoded);
                }
                Ok(Some(PtyEvent::BlockCompleted {
                    block_id,
                    aborted: false,
                    ..
                })) => clean_block = Some(block_id),
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }

        let block_id = clean_block.expect("expected a clean BlockCompleted event");
        let body = chunks
            .remove(&block_id)
            .expect("expected at least one BlockChunk scoped to the clean block");
        let s = String::from_utf8_lossy(&body);
        assert!(
            s.contains("CHUNKMARKER"),
            "expected concatenated BlockChunk bytes to contain CHUNKMARKER, got {s:?}"
        );

        manager.kill(id).await.expect("kill");
    }

    /// Bytes that arrive while the BlockMachine is Idle — between OSC 133
    /// D and the next C — must be re-emitted as `PromptChunk` events, not
    /// `BlockChunk`. This is the contract the M1.9 PromptStrip relies on
    /// to mirror the shell's PS1 + the user's typing echo.
    ///
    /// We probe this by typing characters at the prompt *without* pressing
    /// Enter: the shell echoes them locally during the Idle state, and
    /// nothing kicks off a new C/D pair. The echoed bytes must arrive as
    /// PromptChunks.
    #[cfg(unix)]
    #[tokio::test]
    async fn prompt_chunks_carry_typing_echo_at_the_prompt() {
        let manager = Arc::new(PtyManager::new());
        set_global_manager(Arc::clone(&manager));

        let (channel, mut rx) = make_test_channel();

        let opts = SpawnOpts {
            rows: 24,
            cols: 80,
            cwd: None,
            env: None,
        };

        let id = manager.spawn(opts, channel).await.expect("spawn");

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        while rx.try_recv().is_ok() {}

        // No newline — the shell will echo these locally but never run
        // anything, so no OSC 133 C fires and the state stays Idle.
        manager
            .write(id, &B64.encode(b"PROMPTPROBE"))
            .await
            .expect("write");

        // Real shells interleave SGR (color), cursor-style, and other CSI
        // sequences with the echoed text — zsh in particular wraps each
        // typed char in attribute toggles. Compare on a copy with those
        // ANSI escapes stripped so the assertion is about *which letters
        // arrived*, not *how they were styled*.
        fn strip_ansi(b: &[u8]) -> Vec<u8> {
            let mut out = Vec::with_capacity(b.len());
            let mut i = 0;
            while i < b.len() {
                if b[i] == 0x1b && i + 1 < b.len() {
                    if b[i + 1] == b'[' {
                        // CSI: ESC [ <params> <final 0x40..=0x7e>
                        i += 2;
                        while i < b.len() && !(0x40..=0x7e).contains(&b[i]) {
                            i += 1;
                        }
                        if i < b.len() {
                            i += 1;
                        }
                        continue;
                    }
                    if b[i + 1] == b']' {
                        // OSC: ESC ] ... (BEL | ESC \\)
                        i += 2;
                        while i < b.len() && b[i] != 0x07 {
                            if b[i] == 0x1b && i + 1 < b.len() && b[i + 1] == b'\\' {
                                i += 2;
                                continue;
                            }
                            i += 1;
                        }
                        if i < b.len() {
                            i += 1;
                        }
                        continue;
                    }
                    // Other two-byte ESC: drop both.
                    i += 2;
                    continue;
                }
                out.push(b[i]);
                i += 1;
            }
            out
        }

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut prompt_bytes: Vec<u8> = Vec::new();
        let mut block_bytes: Vec<u8> = Vec::new();
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Some(PtyEvent::PromptChunk { data })) => {
                    prompt_bytes.extend(B64.decode(&data).unwrap_or_default());
                    let stripped = strip_ansi(&prompt_bytes);
                    if String::from_utf8_lossy(&stripped).contains("PROMPTPROBE") {
                        break;
                    }
                }
                Ok(Some(PtyEvent::BlockChunk { data, .. })) => {
                    block_bytes.extend(B64.decode(&data).unwrap_or_default());
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }

        let stripped_prompt = strip_ansi(&prompt_bytes);
        let prompt_s = String::from_utf8_lossy(&stripped_prompt);
        assert!(
            prompt_s.contains("PROMPTPROBE"),
            "expected stripped PromptChunk bytes to carry the shell's echo of typed input, got {prompt_s:?}"
        );
        let stripped_block = strip_ansi(&block_bytes);
        let block_s = String::from_utf8_lossy(&stripped_block);
        assert!(
            !block_s.contains("PROMPTPROBE"),
            "typed echo must not leak into BlockChunk while no command is running, got {block_s:?}"
        );

        // Cancel the half-typed line so the shell goes back to a clean state
        // before teardown (avoids the next test inheriting buffered input
        // via the manager's process-global state).
        manager
            .write(id, &B64.encode(b"\x03"))
            .await
            .expect("write");
        manager.kill(id).await.expect("kill");
    }
}
