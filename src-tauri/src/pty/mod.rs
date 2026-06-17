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
    vt::OscParser,
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
    BlockStarted {
        block_id: BlockId,
        started_at_ms: u64,
    },
    /// A command block has completed (OSC 133 D received).
    BlockCompleted {
        block_id: BlockId,
        exit_code: i32,
        ended_at_ms: u64,
        duration_ms: u64,
    },
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

/// Owns all active PTYs. Lives as a `tauri::State` singleton.
pub struct PtyManager {
    inner: Mutex<HashMap<PtyId, PtyHandle>>,
    /// Per-pane block summary lists; written by reader threads, read by IPC.
    ///
    /// Keyed by `PtyId`; the `Vec<BlockSummary>` is in arrival order.
    blocks: Mutex<HashMap<PtyId, Arc<Mutex<Vec<BlockSummary>>>>>,
}

impl PtyManager {
    /// Create an empty manager.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            blocks: Mutex::new(HashMap::new()),
        }
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

        // Create a per-pane block summary list shared with the reader thread.
        let block_list: Arc<Mutex<Vec<BlockSummary>>> = Arc::new(Mutex::new(Vec::new()));
        self.blocks.lock().await.insert(id, Arc::clone(&block_list));

        let handle = PtyHandle {
            master: pair.master,
            writer: Mutex::new(writer),
            child: child.clone(),
            _zdotdir_tmpdir: zdotdir_tmpdir,
        };

        self.inner.lock().await.insert(id, handle);

        spawn_reader_task(id, reader, child, on_event, block_list);

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

    /// Return a snapshot of the block summary list for the given pane, oldest
    /// first.  Returns an empty vec if the pane id is unknown.
    pub async fn list_blocks(&self, id: PtyId) -> Vec<BlockSummary> {
        let blocks_guard = self.blocks.lock().await;
        match blocks_guard.get(&id) {
            Some(list) => list.lock().await.clone(),
            None => Vec::new(),
        }
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
/// 1. Feed bytes to the VT parser (may emit state-change events synchronously).
/// 2. Emit those state-change events on the channel.
/// 3. Emit `PtyEvent::Output` with the raw bytes.
///
/// This order ensures state transitions (e.g. `BlockStarted`) arrive at the
/// frontend just before the bytes that triggered them, which keeps the UI's
/// mental model consistent.
fn spawn_reader_task(
    id: PtyId,
    mut reader: Box<dyn std::io::Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    on_event: Channel<PtyEvent>,
    block_list: Arc<Mutex<Vec<BlockSummary>>>,
) {
    let rt = tokio::runtime::Handle::current();

    std::thread::spawn(move || {
        use std::io::Read as _;

        let mut buf = [0u8; 4096];

        // The VT parser and block machine live entirely inside this thread;
        // they are never moved or accessed from outside.
        let block_list_clone = Arc::clone(&block_list);
        let mut machine = BlockMachine::new();
        let mut vt_parser = OscParser::new(move |vt_event| {
            // This closure is called synchronously inside `vt_parser.advance()`.
            // We push the VT event onto a thread-local queue so the reader loop
            // can emit the channel events in the right order.
            VT_EVENT_QUEUE.with(|q| q.borrow_mut().push(vt_event));
            let _ = block_list_clone; // keep the Arc alive in the closure
        });

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // 1. Run through VT parser; events land in the thread-local queue.
                    vt_parser.advance(&buf[..n]);

                    // 2. Drain queued VT events through the block machine and emit.
                    let vt_events: Vec<_> =
                        VT_EVENT_QUEUE.with(|q| std::mem::take(&mut *q.borrow_mut()));

                    machine.push_output(&buf[..n]);

                    for vt_ev in vt_events {
                        let pty_events = machine.handle_vt_event(vt_ev);
                        for ev in pty_events {
                            if on_event.send(ev).is_err() {
                                return;
                            }
                        }
                    }

                    // Sync completed block summaries to the shared list.
                    rt.block_on(async {
                        let mut list = block_list.lock().await;
                        *list = machine.block_summaries();
                    });

                    // 3. Forward raw bytes to xterm.js (fidelity contract).
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

        // PTY exited; finalize any running block as aborted.
        machine.finalize_on_exit();
        rt.block_on(async {
            let mut list = block_list.lock().await;
            *list = machine.block_summaries();
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

// Thread-local queue so the VT parser closure can hand events back to the
// reader loop without needing `Send`.
std::thread_local! {
    static VT_EVENT_QUEUE: std::cell::RefCell<Vec<crate::vt::VtEvent>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

// ── Shell builder ──────────────────────────────────────────────────────────────

/// Embedded zsh integration script (bundled at compile time).
const SHAX_ZSH: &str = include_str!("../../shell-integration/shax.zsh");

/// Build the shell `CommandBuilder` from spawn options.
///
/// Returns the command and, for zsh shells, a `TempDir` holding the ZDOTDIR
/// shim.  The `TempDir` must be kept alive for the PTY's lifetime.
fn build_shell_command(
    opts: &SpawnOpts,
) -> Result<(CommandBuilder, Option<tempfile::TempDir>), PtyError> {
    let shell = resolve_shell();
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

    // Inject the zsh integration via an invisible ZDOTDIR shim.
    let zdotdir_tmpdir = if shell_is_zsh(&shell) {
        match create_zdotdir_shim(&mut cmd) {
            Ok(tmpdir) => Some(tmpdir),
            Err(e) => {
                // Non-fatal: log and continue without integration.
                tracing::warn!("zsh ZDOTDIR shim failed, OSC 133 will not fire: {e}");
                None
            }
        }
    } else {
        None
    };

    Ok((cmd, zdotdir_tmpdir))
}

/// Returns `true` when the resolved shell path ends in `zsh` or equals `zsh`.
fn shell_is_zsh(shell: &str) -> bool {
    shell == "zsh" || shell.ends_with("/zsh") || shell.ends_with("\\zsh") // Windows
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

/// Resolve the shell binary: `$SHELL` first, then OS-specific fallback.
fn resolve_shell() -> String {
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

    #[tokio::test]
    async fn list_blocks_returns_empty_for_unknown_pane() {
        let manager = PtyManager::new();
        let unknown = PtyId::new();
        let result = manager.list_blocks(unknown).await;
        assert!(result.is_empty());
    }
}
