//! Tauri commands and channels: the IPC contract between the Rust backend and the frontend.
//!
//! All commands return `Result<_, String>` at the IPC boundary. Internally they use
//! typed `PtyError` values that are converted to strings with `.map_err(|e| e.to_string())`.

pub use crate::blocks::{BlockId, BlockSummary};
pub use crate::pty::{PtyEvent, PtyId, SpawnOpts};
pub use crate::store::{SearchHit, SearchOptions};

use crate::pty::PtyManager;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::sync::Arc;
use tauri::State;

/// Spawn a new PTY with a child shell.
///
/// `on_event` receives a stream of `PtyEvent::Output` chunks and a final
/// `PtyEvent::Exit` when the child terminates.  Additive events
/// (`AltScreenChanged`, `BlockStarted`, `BlockCompleted`) are interleaved.
#[tauri::command]
pub async fn pty_spawn(
    opts: SpawnOpts,
    on_event: tauri::ipc::Channel<PtyEvent>,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<PtyId, String> {
    manager
        .spawn(opts, on_event)
        .await
        .map_err(|e| e.to_string())
}

/// Write base64-encoded bytes to the PTY master (keystrokes, paste, etc.).
#[tauri::command]
pub async fn pty_write(
    id: PtyId,
    data: String,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<(), String> {
    manager.write(id, &data).await.map_err(|e| e.to_string())
}

/// Resize the PTY window for the given pane.
///
/// Must be called whenever the frontend's fit addon computes new dimensions so
/// that full-screen TUI programs (vim, htop, less) see the correct terminal size.
#[tauri::command]
pub async fn pty_resize(
    id: PtyId,
    rows: u16,
    cols: u16,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<(), String> {
    manager
        .resize(id, rows, cols)
        .await
        .map_err(|e| e.to_string())
}

/// Terminate the child process and remove the PTY from the registry.
///
/// Best-effort: if the child is already dead this succeeds silently.
#[tauri::command]
pub async fn pty_kill(id: PtyId, manager: State<'_, Arc<PtyManager>>) -> Result<(), String> {
    manager.kill(id).await.map_err(|e| e.to_string())
}

/// Return the current block list for a pane, oldest first.
///
/// Used by the dev status bar to show how many commands have been captured.
/// Returns an empty list for an unknown pane id.
#[tauri::command]
pub async fn pty_list_blocks(
    id: PtyId,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<Vec<BlockSummary>, String> {
    Ok(manager.list_blocks(id).await)
}

/// Return the captured stdout/stderr bytes for one completed block.
///
/// The bytes are base64-encoded for IPC transit using the same engine as
/// `PtyEvent::Output`. An unknown pane or block id, or a block that is still
/// running, returns an empty string rather than an error — the frontend treats
/// "no bytes available" uniformly.
#[tauri::command]
pub async fn pty_get_block_output(
    id: PtyId,
    block_id: BlockId,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<String, String> {
    let bytes = manager.get_block_output(id, block_id).await;
    Ok(B64.encode(&bytes))
}

/// Return the captured bytes for one block by id alone, going straight to
/// the persistent store. Used by the search-results viewer modal: search
/// surfaces blocks from previous sessions whose owning pane no longer
/// exists, so a `(pty_id, block_id)` lookup wouldn't have anywhere to go.
/// Returns an empty base64 string for an unknown id.
#[tauri::command]
pub async fn block_get_output(
    block_id: BlockId,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<String, String> {
    let Some(store) = manager.store() else {
        return Ok(String::new());
    };
    let bytes = store
        .load_output(block_id)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(B64.encode(&bytes))
}

/// Read raw file bytes from disk, base64-encoded for IPC transit.
///
/// Why this exists: when a user runs `cat photo.png` in the terminal,
/// the bytes that reach our OSC 133 capture have already passed
/// through the PTY's line discipline — by default ONLCR converts
/// every `\n` (0x0A) into `\r\n` (0x0D 0x0A), corrupting any
/// binary file. PNG files have lots of 0x0A bytes (the signature
/// itself is `89 50 4E 47 0D 0A 1A 0A`), so the captured output
/// can't be decoded as PNG.
///
/// The viewer modal therefore reads image files straight from
/// disk via this command instead of using the captured stdout.
/// Per spec §07 rule 2 — "probe, don't screen-scrape" — bytes on
/// disk are authoritative; what the shell happened to print is
/// just a noisy lens.
///
/// Refuses paths outside the user's home + system roots? No —
/// the user typed the command into their shell; if they can
/// `cat` it they can view it. Standard fs permissions enforce.
/// We *do* cap the file size to keep a multi-GB read from
/// blowing memory.
const MAX_VIEWER_FILE_BYTES: usize = 128 * 1024 * 1024; // 128 MiB

#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<String, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("{e}"))?;
    if metadata.len() as usize > MAX_VIEWER_FILE_BYTES {
        return Err(format!(
            "file too large: {} bytes (cap {} bytes)",
            metadata.len(),
            MAX_VIEWER_FILE_BYTES
        ));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("{e}"))?;
    Ok(B64.encode(&bytes))
}

/// File statistics for the INFO lens (M4.5 slice 2). Populated
/// from `std::fs::Metadata` — everything is best-effort:
///  - `created_unix_ms` is `None` on filesystems that don't track
///    birth time (older Linux ext4 without statx, some
///    network mounts).
///  - `is_executable` is `Some(bool)` on unix and `None` on
///    Windows (there's no equivalent bit — the frontend can
///    fall back to extension heuristics if it wants to).
#[derive(Debug, serde::Serialize)]
pub struct FileStat {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub is_executable: Option<bool>,
    /// Milliseconds since epoch (UTC). `None` if unknown.
    pub created_unix_ms: Option<i64>,
    /// Milliseconds since epoch (UTC).
    pub modified_unix_ms: i64,
    /// Symlink target as a path string, or `None` when the entry
    /// isn't a symlink or the target can't be read.
    pub symlink_target: Option<String>,
}

fn system_time_to_unix_ms(time: std::time::SystemTime) -> Option<i64> {
    time.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
}

/// Return filesystem metadata for a single path. Used by the
/// INFO lens on cat/bat blocks — a universal `FILE` section on
/// every text or binary file with a path in argv.
///
/// The path is *not* sandboxed against a project root — the
/// user asked to see stats for whatever they cat'd, and cat
/// itself has no such constraint.
#[tauri::command]
pub async fn stat_file(path: String) -> Result<FileStat, String> {
    // `symlink_metadata` returns info about the link itself; we
    // then re-stat via `metadata` if it *isn't* a link so we get
    // the usual file stats. If it *is* a link, we return the
    // link's own stats plus the resolved target string, which is
    // what the user cares about seeing in the UI.
    let symlink_meta = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|e| format!("{e}"))?;
    let is_symlink = symlink_meta.file_type().is_symlink();
    let symlink_target = if is_symlink {
        match tokio::fs::read_link(&path).await {
            Ok(p) => p.to_str().map(|s| s.to_string()),
            Err(_) => None,
        }
    } else {
        None
    };
    // For non-symlinks the symlink_meta is the file's own
    // metadata already; there's no need for a second syscall.
    let meta = symlink_meta;
    let modified_unix_ms = meta
        .modified()
        .ok()
        .and_then(system_time_to_unix_ms)
        .ok_or_else(|| "modified time not available".to_string())?;
    let created_unix_ms = meta.created().ok().and_then(system_time_to_unix_ms);
    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();
    Ok(FileStat {
        name,
        path: path.clone(),
        size_bytes: meta.len(),
        is_directory: meta.is_dir(),
        is_symlink,
        is_executable: executable_perm(&meta),
        created_unix_ms,
        modified_unix_ms,
        symlink_target,
    })
}

#[cfg(unix)]
fn executable_perm(meta: &std::fs::Metadata) -> Option<bool> {
    use std::os::unix::fs::PermissionsExt;
    if meta.is_dir() {
        return None;
    }
    Some(meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable_perm(_meta: &std::fs::Metadata) -> Option<bool> {
    None
}

/// Authoritative metadata for one entry inside a directory.
/// Returned by `read_dir_entries`; used by the `ls` formatter to
/// render rows without parsing what the shell happened to print.
/// Per spec §07 rule 2 — "probe, don't screen-scrape" — every
/// classification is from the filesystem, not from SGR colours.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
// On Windows the classifier never constructs `Device`/`Socket`/
// `Fifo` (those concepts don't exist there), so clippy's dead-
// code lint would flag them — even though they're part of the
// wire format the frontend expects and *are* constructed on
// Unix. Suppress the lint on Windows builds only.
#[cfg_attr(not(unix), allow(dead_code))]
pub enum DirEntryKind {
    /// Regular directory.
    Dir,
    /// Regular file. `is_executable` carries the perm bit.
    File,
    /// Symlink (either dangling or live). `symlink_target` is the
    /// raw target string, exactly as `readlink` would return it.
    Symlink,
    /// Block / character device.
    Device,
    /// Unix-domain socket.
    Socket,
    /// Named pipe (FIFO).
    Fifo,
    /// Anything else / classification failed.
    Other,
}

#[derive(Debug, serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: DirEntryKind,
    pub size: u64,
    /// Unix-epoch milliseconds. `None` if the platform doesn't
    /// expose a usable mtime for this entry.
    pub modified_ms: Option<u64>,
    pub is_executable: bool,
    /// `None` unless `kind == Symlink`.
    pub symlink_target: Option<String>,
}

/// Read a directory's entries with enough metadata for the `ls`
/// formatter to render rows authoritatively. Refuses to follow
/// symlinks when stat-ing (`symlink_metadata` not `metadata`) so
/// dangling links don't surface as ENOENT errors.
///
/// Errors propagate as strings (no usable path, permission
/// denied, not a directory). The formatter falls back to RAW.
#[tauri::command]
pub async fn read_dir_entries(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut dir = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("{e}"))?;
    while let Some(entry) = dir.next_entry().await.map_err(|e| format!("{e}"))? {
        let name = entry.file_name().to_string_lossy().into_owned();
        // `symlink_metadata` so a broken symlink doesn't error
        // out the whole read — we still want to list it.
        let meta = match entry.path().symlink_metadata() {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("read_dir_entries: stat failed for {name}: {e}");
                continue;
            }
        };
        let kind = classify_file_type(&meta);
        // For symlinks the size is the *link* size, not the
        // target's. ls reports it the same way.
        let size = meta.len();
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        let is_executable = matches!(kind, DirEntryKind::File) && is_executable_perm(&meta);
        let symlink_target = if matches!(kind, DirEntryKind::Symlink) {
            tokio::fs::read_link(entry.path())
                .await
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        } else {
            None
        };
        entries.push(DirEntry {
            name,
            kind,
            size,
            modified_ms,
            is_executable,
            symlink_target,
        });
    }
    Ok(entries)
}

#[cfg(unix)]
fn classify_file_type(meta: &std::fs::Metadata) -> DirEntryKind {
    use std::os::unix::fs::FileTypeExt;
    let ft = meta.file_type();
    if ft.is_symlink() {
        DirEntryKind::Symlink
    } else if ft.is_dir() {
        DirEntryKind::Dir
    } else if ft.is_file() {
        DirEntryKind::File
    } else if ft.is_block_device() || ft.is_char_device() {
        DirEntryKind::Device
    } else if ft.is_socket() {
        DirEntryKind::Socket
    } else if ft.is_fifo() {
        DirEntryKind::Fifo
    } else {
        DirEntryKind::Other
    }
}

#[cfg(not(unix))]
fn classify_file_type(meta: &std::fs::Metadata) -> DirEntryKind {
    let ft = meta.file_type();
    if ft.is_symlink() {
        DirEntryKind::Symlink
    } else if ft.is_dir() {
        DirEntryKind::Dir
    } else if ft.is_file() {
        DirEntryKind::File
    } else {
        DirEntryKind::Other
    }
}

#[cfg(unix)]
fn is_executable_perm(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    (meta.permissions().mode() & 0o111) != 0
}

#[cfg(not(unix))]
fn is_executable_perm(_meta: &std::fs::Metadata) -> bool {
    // Windows: ls formatter falls back to filename-extension
    // heuristics on the frontend (`.exe` / `.bat` / `.cmd`).
    false
}

/// One community formatter discovered on disk. The frontend
/// parses the `manifest_json` and `source_js`, validates them,
/// then registers via `createSandboxedFormatter`.
#[derive(Debug, serde::Serialize)]
pub struct CommunityFormatterPayload {
    pub name: String,
    pub manifest_json: String,
    pub source_js: String,
}

/// Where on disk community formatters live. Each immediate
/// subdirectory of `~/.config/shax/formatters/` is a single
/// formatter; the subdirectory's name is the formatter's id.
fn community_formatters_root() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join(".config/shax/formatters"))
}

/// Maximum size of a single community-formatter source file
/// (bytes). A formatter that exceeds this is rejected — guards
/// against pathologically large source slipping in via a typo
/// or a packaging accident.
const MAX_FORMATTER_SOURCE_BYTES: u64 = 256 * 1024; // 256 KiB

/// Read every community formatter from `~/.config/shax/formatters/`.
///
/// One subdirectory per formatter. Each must contain
/// `manifest.json` + `formatter.js`. The frontend handles
/// validation + worker spawning; the backend only does the
/// filesystem walk + a size sanity cap.
///
/// Missing directory → empty list (not an error). Bad permissions
/// or per-formatter parse failures are skipped with a warn so a
/// single malformed add-on doesn't break the whole load.
#[tauri::command]
pub async fn list_community_formatters() -> Result<Vec<CommunityFormatterPayload>, String> {
    let root = match community_formatters_root() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let mut dir = match tokio::fs::read_dir(&root).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{e}")),
    };
    let mut out: Vec<CommunityFormatterPayload> = Vec::new();
    while let Some(entry) = dir.next_entry().await.map_err(|e| format!("{e}"))? {
        let entry_path = entry.path();
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("list_community_formatters: stat failed for {entry_path:?}: {e}");
                continue;
            }
        };
        if !meta.is_dir() {
            continue;
        }
        let name = match entry.file_name().to_str() {
            Some(s) => s.to_string(),
            None => {
                tracing::warn!(
                    "list_community_formatters: skipping non-utf8 dir name {entry_path:?}"
                );
                continue;
            }
        };
        // Hidden dirs are ignored — keeps `.git` / `.DS_Store`
        // and similar from poisoning the load.
        if name.starts_with('.') {
            continue;
        }
        let manifest_path = entry_path.join("manifest.json");
        let source_path = entry_path.join("formatter.js");
        let manifest_json = match tokio::fs::read_to_string(&manifest_path).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    "list_community_formatters: {name} missing/unreadable manifest.json: {e}"
                );
                continue;
            }
        };
        let source_meta = match tokio::fs::metadata(&source_path).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    "list_community_formatters: {name} missing/unreadable formatter.js: {e}"
                );
                continue;
            }
        };
        if source_meta.len() > MAX_FORMATTER_SOURCE_BYTES {
            tracing::warn!(
                "list_community_formatters: {name} formatter.js exceeds {MAX_FORMATTER_SOURCE_BYTES} bytes, skipping"
            );
            continue;
        }
        let source_js = match tokio::fs::read_to_string(&source_path).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("list_community_formatters: {name} read failed: {e}");
                continue;
            }
        };
        out.push(CommunityFormatterPayload {
            name,
            manifest_json,
            source_js,
        });
    }
    Ok(out)
}

/// Run `git status --porcelain=v2 --branch -z` in `cwd` and return
/// stdout. Why this and not "let the user pass arbitrary git
/// args": narrowing the API keeps the backend from becoming a
/// general git-runner, and the porcelain v2 format is stable
/// across git versions (the human output isn't). The `-z` keeps
/// paths null-terminated so filenames with newlines parse cleanly
/// on the frontend.
///
/// Cap on output size + a 10s hard timeout so a wedged git
/// invocation can't hang the formatter.
const MAX_GIT_OUTPUT_BYTES: usize = 16 * 1024 * 1024; // 16 MiB

#[tauri::command]
pub async fn git_status_porcelain(cwd: String) -> Result<String, String> {
    run_git(&cwd, &["status", "--porcelain=v2", "--branch", "-z"]).await
}

/// Run `git diff <args>` in `cwd`. `args` is the part of the
/// user's command after `diff` — we replay it verbatim because
/// the user might have typed `git diff HEAD`, `git diff
/// --stat`, or a path / pathspec. Unified diff is the machine-
/// readable format already, so no `--porcelain` substitution.
///
/// Same cap + timeout as `git_status_porcelain`. Refuses any
/// arg that starts with `--exec` / `--ext-` / `-c` to avoid
/// becoming a shell-out vector (those flags can run arbitrary
/// commands via `--ext-diff` config). The formatter still
/// renders RAW if we reject.
#[tauri::command]
pub async fn git_diff(cwd: String, args: Vec<String>) -> Result<String, String> {
    for arg in &args {
        if arg.starts_with("--ext-diff")
            || arg.starts_with("--exec")
            || arg == "-c"
            || arg.starts_with("--upload-pack")
            || arg.starts_with("--receive-pack")
        {
            return Err(format!("git_diff: refusing arg: {arg}"));
        }
    }
    let mut full: Vec<&str> = vec!["diff"];
    for a in &args {
        full.push(a.as_str());
    }
    run_git(&cwd, &full).await
}

/// Shared `git` runner. Returns stdout as a string; non-UTF-8
/// bytes pass through with replacement characters because the
/// formatter renders text, not bytes. Treats a non-zero exit as
/// an error iff stdout is empty — `git status` and `git diff`
/// can both report changes via stdout while exiting non-zero
/// (e.g. `git diff --exit-code` exits 1 when there are diffs).
async fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    // Hard timeout. 10s covers very large repos; anything past
    // that is almost certainly a hang and we'd rather surface
    // a clean error.
    let proc = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "git: timed out after 10s".to_string())?
    .map_err(|e| format!("git: failed to spawn: {e}"))?;

    if proc.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(format!(
            "git: output too large ({} bytes, cap {} bytes)",
            proc.stdout.len(),
            MAX_GIT_OUTPUT_BYTES
        ));
    }
    let stdout = String::from_utf8_lossy(&proc.stdout).into_owned();
    if !proc.status.success() && stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&proc.stderr);
        return Err(format!("git: exit {}: {}", proc.status, stderr.trim()));
    }
    Ok(stdout)
}

/// Load the persisted app-state JSON (tabs + layout tree + focused pane),
/// or `null` if the user has no prior session yet. The frontend hydrates
/// its tab reducer from this on mount; if the store isn't attached (rare,
/// only in bare `cargo test`-style runs without a DB), returns `null` too.
#[tauri::command]
pub async fn app_state_load(manager: State<'_, Arc<PtyManager>>) -> Result<Option<String>, String> {
    let Some(store) = manager.store() else {
        return Ok(None);
    };
    store.load_app_state().map_err(|e| e.to_string())
}

/// Persist the app-state JSON (tabs + layout tree + focused pane) so the
/// next launch can restore the user's layout. Called debounced by the
/// frontend whenever a tab is opened, closed, or split.
#[tauri::command]
pub async fn app_state_save(
    json: String,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<(), String> {
    let Some(store) = manager.store() else {
        return Ok(());
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    store
        .save_app_state(&json, now_ms)
        .map_err(|e| e.to_string())
}

/// Full-text search across all persisted block summaries. `opts.query`
/// is the raw FTS5 MATCH expression — multiple whitespace-separated
/// words are AND'd implicitly. Optional status / time filters compose
/// with the FTS match. An empty / whitespace-only query, or invalid
/// FTS5 syntax, returns no rows rather than surfacing an error so the
/// search overlay can show "no matches" cleanly while the user keeps
/// typing. Each hit carries the originating pane id (so the UI can
/// jump back to a still-alive pane) and, when the match landed in
/// output, a snippet excerpt with `<mark>` / `</mark>` markers.
#[tauri::command]
pub async fn search_blocks(
    opts: SearchOptions,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<Vec<SearchHit>, String> {
    let Some(store) = manager.store() else {
        return Ok(Vec::new());
    };
    store.search(&opts).map_err(|e| e.to_string())
}

/// Faceted branch list: every distinct non-empty `git_branch` that
/// appears in the result set defined by `opts`, ordered most-recently-
/// used first. `opts.git_branch` is deliberately ignored — picking a
/// branch must not collapse the dropdown to just that branch (standard
/// facet rule). Empty query + no other filters reduces to "every
/// branch in history". Returns an empty list when no store is attached.
#[tauri::command]
pub async fn list_branches(
    opts: SearchOptions,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<Vec<String>, String> {
    let Some(store) = manager.store() else {
        return Ok(Vec::new());
    };
    store
        .distinct_branches_for(&opts)
        .map_err(|e| e.to_string())
}

/// Faceted cwd list: same shape as `list_branches` but for the cwd
/// dropdown. Skips `opts.cwd` and `opts.cwd_prefix` themselves (those
/// are what this facet narrows) and caps at the 30 most-recent
/// directories so the popover stays usable.
#[tauri::command]
pub async fn list_cwds(
    opts: SearchOptions,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<Vec<String>, String> {
    let Some(store) = manager.store() else {
        return Ok(Vec::new());
    };
    store.distinct_cwds_for(&opts).map_err(|e| e.to_string())
}

/// Resolve the git worktree root containing `path` by walking up until
/// a `.git` entry is found (regular dir for a normal clone, file for a
/// worktree). Returns `None` if no `.git` exists anywhere on the way
/// up to the filesystem root, or if `path` is empty / not absolute.
/// Pure fs op — no `git` subprocess; safe to call on every search.
#[tauri::command]
pub async fn git_root_for(path: String) -> Result<Option<String>, String> {
    if path.is_empty() {
        return Ok(None);
    }
    let start = std::path::Path::new(&path);
    if !start.is_absolute() {
        return Ok(None);
    }
    let mut current: Option<&std::path::Path> = Some(start);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Ok(Some(dir.to_string_lossy().into_owned()));
        }
        current = dir.parent();
    }
    Ok(None)
}
