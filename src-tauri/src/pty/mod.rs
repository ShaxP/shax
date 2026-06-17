//! PTY manager: one PTY per pane, reader tasks, resize, and process-group reaping.

use std::{collections::HashMap, sync::Arc};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::Write as _;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::pty::error::PtyError;

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
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PtyEvent {
    /// Raw PTY output bytes, base64-encoded for efficient IPC transfer.
    Output { data: String },
    /// The child process has exited. `code` is `None` when the exit status is
    /// unavailable (e.g. killed by a signal without a numeric code).
    Exit { code: Option<i32> },
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
}

// ── PtyManager ─────────────────────────────────────────────────────────────────

/// Owns all active PTYs. Lives as a `tauri::State` singleton.
pub struct PtyManager {
    inner: Mutex<HashMap<PtyId, PtyHandle>>,
}

impl PtyManager {
    /// Create an empty manager.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Spawn a new PTY with a child shell and begin streaming its output to
    /// `on_event`. Returns the new `PtyId`.
    ///
    /// The shell binary is chosen from `$SHELL`, falling back to platform
    /// defaults when the variable is absent or the path is invalid.
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

        let cmd = build_shell_command(&opts);

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

        let handle = PtyHandle {
            master: pair.master,
            writer: Mutex::new(writer),
            child: child.clone(),
        };

        self.inner.lock().await.insert(id, handle);

        spawn_reader_task(id, reader, child, on_event);

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

/// Spawn a blocking task that reads PTY output and forwards it as `PtyEvent`s.
///
/// We use `spawn_blocking` because `portable-pty` reader reads are synchronous.
/// The task exits when it sees EOF (child exited) or when `cancel` is notified.
fn spawn_reader_task(
    id: PtyId,
    mut reader: Box<dyn std::io::Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    on_event: Channel<PtyEvent>,
) {
    let rt = tokio::runtime::Handle::current();

    std::thread::spawn(move || {
        use std::io::Read as _;

        let mut buf = [0u8; 4096];

        loop {
            // PTY reads block until data arrives. EOF (0 bytes) signals the
            // child has exited or the master was closed.
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = B64.encode(&buf[..n]);
                    if on_event.send(PtyEvent::Output { data: encoded }).is_err() {
                        // The channel receiver (frontend) is gone.
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!(%id, "PTY read error: {e}");
                    break;
                }
            }
        }

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

        // Clean up the manager entry if a `kill` hasn't already removed it.
        rt.spawn(async move {
            remove_exited_global(id).await;
        });
    });
}

// ── Shell builder ──────────────────────────────────────────────────────────────

/// Build the shell `CommandBuilder` from spawn options, applying cwd and env.
///
/// `portable_pty::CommandBuilder` starts with an empty environment. A shell
/// (zsh, bash) launched with no `HOME`/`PATH`/`TERM` initializes its terminal
/// subsystem badly and reports "open terminal failed: not a terminal", which
/// also disables line editing. So we inherit the parent process's env, layer
/// a sane `TERM` default, and then apply any caller overrides on top.
fn build_shell_command(opts: &SpawnOpts) -> CommandBuilder {
    let shell = resolve_shell();
    let mut cmd = CommandBuilder::new(&shell);

    for (key, val) in std::env::vars_os() {
        cmd.env(&key, &val);
    }

    cmd.env("TERM", "xterm-256color");

    let cwd = opts.cwd.clone().or_else(|| std::env::var("HOME").ok());
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }

    if let Some(ref env) = opts.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    cmd
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

use std::sync::OnceLock;

static GLOBAL_MANAGER: OnceLock<Arc<PtyManager>> = OnceLock::new();

/// Called by `lib.rs` after constructing the manager so reader tasks can reach
/// it without going through Tauri State.
pub fn set_global_manager(manager: Arc<PtyManager>) {
    // Ignore the error if already set (should not happen in production).
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
    use std::sync::Arc;
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

        // A few rapid resizes must not panic or error.
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
}
