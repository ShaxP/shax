/**
 * IPC client — single source of truth for the Tauri PTY command contract.
 *
 * All four PTY operations live here. Callers outside this module should never
 * call `invoke` directly for PTY commands; they go through these wrappers so
 * the contract is enforced in one place.
 *
 * When the code is NOT running inside Tauri (plain browser dev or Playwright)
 * `spawnPty` returns a sentinel id and the other functions become no-ops, so
 * the app still mounts without crashing.
 */

// Channel is imported by type only when Tauri is present; we dynamic-import
// it at runtime so the module resolves in non-Tauri contexts too.
import type { Channel } from "@tauri-apps/api/core";

export type PtyId = string; // uuid serialized as string
export type BlockId = string; // uuid serialized as string

export interface SpawnOpts {
  rows: number;
  cols: number;
  cwd?: string;
  env?: Record<string, string>;
}

export type PtyEvent =
  | { kind: "output"; data: string } // base64-encoded bytes
  | { kind: "exit"; code: number | null }
  | { kind: "alt_screen_changed"; active: boolean }
  | {
      kind: "block_started";
      block_id: BlockId;
      command: string | null;
      cwd: string | null;
      git_branch: string | null;
      started_at_ms: number;
    }
  | {
      kind: "block_completed";
      block_id: BlockId;
      exit_code: number;
      ended_at_ms: number;
      duration_ms: number;
      /**
       * True for both abort paths (PTY exited mid-block, or a second OSC 133 C
       * arrived first). The UI keys the "aborted" status pill off this flag,
       * not off `exit_code` — `exit_code` is `-1` as a sentinel in abort cases.
       */
      aborted: boolean;
      /**
       * cwd and branch the command *ended* in, reported by the shell on
       * OSC 133 D. For `cd X && ls` this is X, not the previous prompt's
       * directory. `null` when the shell integration didn't include them.
       */
      cwd: string | null;
      git_branch: string | null;
      /**
       * True if the alt-screen was active at any point during this block —
       * the user ran vim / htop / less / ssh / a REPL. Backend authoritative;
       * the UI hides the output preview when set.
       */
      interactive: boolean;
    }
  | {
      /**
       * A chunk of raw output bytes scoped to the currently-running block.
       * Emitted alongside `output` so xterm.js still gets the full byte
       * stream (alt-screen passthrough stays exact) while the block stack
       * can render the same bytes inline without an IPC fetch on expand.
       */
      kind: "block_chunk";
      block_id: BlockId;
      /** Base64-encoded bytes. */
      data: string;
    }
  | {
      /**
       * A chunk of raw bytes that arrived while the shell is at a prompt —
       * between OSC 133 D (or session start) and the next OSC 133 C.
       * These are the shell's PS1 rendering plus the local echo of the
       * user's typing. The M1.9 PromptStrip feeds them through a tiny
       * single-line VT renderer to mirror the shell's current prompt line.
       */
      kind: "prompt_chunk";
      /** Base64-encoded bytes. */
      data: string;
    }
  | {
      /**
       * Soft-clear signal — the shell ran `clear` / `Ctrl+L` / any alias
       * that emits `CSI 3 J` on the wire. The frontend drops the pane's
       * visible block list in response. Persistent storage is untouched;
       * the cleared blocks stay searchable via the overlay.
       */
      kind: "scrollback_cleared";
    }
  | {
      /**
       * The shell just started rendering a prompt (OSC 133 A / precmd).
       * Fires on every prompt including the first — the prompt strip
       * uses it as the primary source for pane-context display.
       *
       * M12.4 grew the payload. All fields are `null` when the shell
       * integration didn't report them (bare `A` marker, missing key,
       * or empty value):
       *
       * - `cwd` / `git_branch` — since M1.
       * - `git_ahead` / `git_behind` — commit counts vs upstream, both
       *   `null` when no upstream is set OR the shim omitted them
       *   because both were zero (frontend then renders no chip).
       * - `language` — primary language detected for the cwd (e.g.
       *   `"rust"`, `"typescript"`); `null` when detection didn't
       *   match anything.
       * - `user` / `host` — session identity from `whoami` / `hostname -s`.
       *   Session-constant; emitted on every A for uniformity.
       */
      kind: "prompt_ready";
      cwd: string | null;
      git_branch: string | null;
      git_ahead: number | null;
      git_behind: number | null;
      language: string | null;
      user: string | null;
      host: string | null;
    }
  | {
      /**
       * The shell's line-editor keymap changed (M12.2). Emitted from the
       * OSC 133;M marker the zsh shim produces when the user picked Vi.
       * The frontend uses `keymap` to drive the statusline's two-chip
       * pill sub-mode. Values seen in practice: `main`, `emacs`, `viins`,
       * `vicmd`, `visual`.
       */
      kind: "keymap_changed";
      keymap: string;
    };

/**
 * A summary of a single captured command block.
 *
 * `ended_at_ms`, `exit_code`, and `duration_ms` are null while the block is
 * still running. `command`, `cwd`, and `git_branch` are null when the shell
 * did not emit them (older or third-party integration). `aborted` is true
 * when the block closed without a clean OSC 133 D — either by the PTY
 * exiting mid-block or by a second C.
 */
export interface BlockSummary {
  id: BlockId;
  command: string | null;
  cwd: string | null;
  git_branch: string | null;
  started_at_ms: number;
  ended_at_ms: number | null;
  exit_code: number | null;
  duration_ms: number | null;
  aborted: boolean;
  /**
   * True when the alternate screen was active at any point during this
   * block (vim, htop, less, …). The frontend hides the output preview
   * for these blocks because the captured bytes are cursor / grid
   * manipulation rather than flow text.
   */
  interactive: boolean;
}

// ---------------------------------------------------------------------------
// Base64 helpers
//
// `btoa` / `atob` treat each character as a byte (Latin-1). For arbitrary
// binary data we must convert via a byte-at-a-time approach rather than
// passing a JS string directly, which would mangle multi-byte characters.
// We chunk the forward pass to avoid blowing the call stack with large arrays.
// ---------------------------------------------------------------------------

const CHUNK = 8192; // safe chunk size for spread-into-String.fromCharCode

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    // slice produces a plain Array copy — fromCharCode handles it fine
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    // charCodeAt is always 0-255 after atob
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Tauri context detection
// ---------------------------------------------------------------------------

function isTauriContext(): boolean {
  return (
    typeof window !== "undefined" &&
    // __TAURI_INTERNALS__ is injected by the Tauri webview host
    "__TAURI_INTERNALS__" in window
  );
}

// ---------------------------------------------------------------------------
// Public IPC wrappers
// ---------------------------------------------------------------------------

/**
 * Spawns a new PTY and begins streaming events via `onEvent`.
 *
 * Returns the PTY id needed for subsequent write / resize / kill calls.
 * In non-Tauri contexts returns a sentinel and never fires `onEvent`.
 */
export async function spawnPty(opts: SpawnOpts, onEvent: (e: PtyEvent) => void): Promise<PtyId> {
  if (!isTauriContext()) {
    // Running in plain browser / Playwright: return a no-op id.
    return "non-tauri";
  }

  // Dynamic import keeps @tauri-apps/api/core from being evaluated in tests
  // that run in jsdom without a Tauri host.
  const { invoke, Channel: TauriChannel } = await import("@tauri-apps/api/core");
  const ch: Channel<PtyEvent> = new TauriChannel<PtyEvent>();
  ch.onmessage = onEvent;
  return invoke<PtyId>("pty_spawn", { opts, onEvent: ch });
}

/**
 * Writes raw bytes to the PTY identified by `id`.
 * The bytes are base64-encoded for the IPC payload.
 */
export async function writePty(id: PtyId, bytes: Uint8Array): Promise<void> {
  if (!isTauriContext() || id === "non-tauri") return;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("pty_write", { id, data: base64Encode(bytes) });
}

/**
 * Informs the PTY of a terminal resize event.
 */
export async function resizePty(id: PtyId, rows: number, cols: number): Promise<void> {
  if (!isTauriContext() || id === "non-tauri") return;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("pty_resize", { id, rows, cols });
}

/**
 * Kills the PTY process and tears down the PTY.
 */
export async function killPty(id: PtyId): Promise<void> {
  if (!isTauriContext() || id === "non-tauri") return;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("pty_kill", { id });
}

/**
 * Returns all block summaries recorded for the given PTY, in chronological
 * order. Used to seed React state when mounting a pane that may have blocks
 * from before the frontend started listening.
 *
 * In non-Tauri contexts returns an empty array so callers need no special case.
 */
export async function listBlocks(id: PtyId): Promise<BlockSummary[]> {
  if (!isTauriContext() || id === "non-tauri") return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<BlockSummary[]>("pty_list_blocks", { id });
}

/**
 * Fetches the captured stdout/stderr bytes for a single completed block.
 *
 * Returns an empty Uint8Array if the pane or block id is unknown, or if the
 * block is still running. Callers should treat an empty result uniformly.
 */
export async function getBlockOutput(id: PtyId, blockId: BlockId): Promise<Uint8Array> {
  if (!isTauriContext() || id === "non-tauri") return new Uint8Array();
  const { invoke } = await import("@tauri-apps/api/core");
  const b64 = await invoke<string>("pty_get_block_output", { id, blockId });
  return base64Decode(b64);
}

/**
 * Load the persisted app-state JSON (tabs + layout tree + focused pane id).
 * Returns `null` when no prior session has been saved yet, or when running
 * outside Tauri (the e2e/jsdom env).
 */
export async function appStateLoad(): Promise<string | null> {
  if (!isTauriContext()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("app_state_load");
}

/**
 * Persist the app-state JSON blob. The frontend debounces saves so a burst
 * of layout edits (e.g. dragging a divider) doesn't hammer SQLite.
 */
export async function appStateSave(json: string): Promise<void> {
  if (!isTauriContext()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("app_state_save", { json });
}

/**
 * Filter on a block's final terminal status. Mirrors the iconography
 * on each row (✓ / ✗ / · / …). The frontend cycles through these on
 * the status chip; `any` skips the filter entirely.
 */
export type SearchStatus = "any" | "ok" | "fail" | "aborted";

/**
 * Composite options for `searchBlocks`. Matches the backend's
 * `SearchOptions` struct shape one-for-one so Tauri's auto-derived
 * deserialisation just works.
 */
export interface SearchOptions {
  query: string;
  limit: number;
  offset: number;
  status?: SearchStatus;
  /** Lower bound on `started_at_ms` (inclusive). Omit to skip. */
  since_ms?: number;
  /**
   * Narrow on the exact cwd the block ran in. The slice-3.3 "Here"
   * chip passes the active pane's cwd verbatim. Free-form / glob
   * filtering is a deferred M3 follow-up.
   */
  cwd?: string;
  /**
   * Narrow to blocks whose `cwd` starts with this prefix. Drives the
   * cwd chip's "Repo · <root>" option — the frontend resolves the
   * worktree root via `gitRootFor` and passes the result here. Exact
   * byte-prefix matching (via SQL `INSTR` on the backend), so paths
   * with `_` / `%` aren't surprise-matched.
   */
  cwd_prefix?: string;
  /**
   * Narrow to blocks whose `cwd` matches this shell-style glob
   * pattern (`*`, `?`, `[…]`). Drives the cwd dropdown's free-form
   * "Path: …" input. Without wildcards the glob behaves as an
   * exact match, so a bare path filters to itself.
   */
  cwd_glob?: string;
  /** Narrow on the exact git branch the block ran on. */
  git_branch?: string;
}

/**
 * One search result: the matching block plus the originating pane id
 * (so the UI can jump to a still-alive pane) and an optional snippet
 * excerpt with `<mark>` / `</mark>` around the matched tokens.
 */
export interface SearchHit {
  block: BlockSummary;
  pane_id: PtyId;
  snippet: string | null;
  /**
   * `true` when this row was matched only by the trigram (substring)
   * fuzzy index — the literal-token search didn't find it. The UI
   * tags these rows so the user can tell at a glance why a result
   * with no obvious match showed up. Defaults to `false`.
   */
  fuzzy?: boolean;
}

/**
 * Full-text search across persisted block summaries. `query` is the raw
 * FTS5 MATCH expression — whitespace-separated words are AND'd implicitly,
 * `*` is the prefix wildcard, `"…"` quotes a phrase. Empty / invalid
 * queries resolve to an empty array (no error), so the search overlay
 * can show "no results" while the user finishes typing.
 */
export async function searchBlocks(opts: SearchOptions): Promise<SearchHit[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SearchHit[]>("search_blocks", { opts });
}

/**
 * One semantic-search result. Shape mirrors `SearchHit` so the overlay
 * can reuse `SearchResultRow`, but replaces the FTS-specific `snippet`
 * / `fuzzy` fields with a cosine `similarity` in `[-1, 1]`.
 */
export interface SemanticHit {
  block: BlockSummary;
  pane_id: PtyId;
  /** Cosine similarity in `[-1, 1]`. Higher = more relevant. */
  similarity: number;
}

/**
 * Semantic nearest-neighbours query over the block embeddings. Runs the
 * active embedder (the real ONNX `all-MiniLM-L6-v2` when available,
 * otherwise the mock fallback — see `embeddingProgress`) over `query`
 * and returns the top-`limit` hits sorted by similarity descending.
 * Empty / whitespace-only queries short-circuit to an empty array —
 * similarity against no query is meaningless.
 */
export async function semanticSearch(query: string, limit: number): Promise<SemanticHit[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SemanticHit[]>("semantic_search", { query, limit });
}

/**
 * Progress + identity of the active embedder. `indexed` / `total` drive
 * the overlay's "N of M indexed" pill. `model_id` starts with `mock-`
 * when the real ONNX model isn't loaded (missing bundle file, ORT init
 * failure) so the frontend can flag the semantic tier as unavailable
 * instead of pretending its placeholder ranking is meaningful.
 */
export interface EmbeddingProgress {
  indexed: number;
  total: number;
  model_id: string;
}

export async function embeddingProgress(): Promise<EmbeddingProgress> {
  if (!isTauriContext()) return { indexed: 0, total: 0, model_id: "unknown" };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<EmbeddingProgress>("embedding_progress");
}

/**
 * Faceted branch list: distinct non-empty git branches that exist in
 * the result set of `opts`, ordered most-recently-used first. Mirrors
 * `searchBlocks(opts)` for the same query / cwd / status / since
 * filters, but deliberately *ignores* `opts.git_branch` — picking a
 * branch must not collapse the dropdown to just that one option.
 *
 * Empty query + no other filters reduces to "every branch in history".
 */
export async function listBranches(opts: SearchOptions): Promise<string[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("list_branches", { opts });
}

/**
 * Faceted cwd list for the search overlay's cwd dropdown — same
 * shape as `listBranches`, capped at the 30 most-recent directories.
 * Skips `opts.cwd` and `opts.cwd_prefix` themselves so picking a
 * directory doesn't collapse the list.
 */
export async function listCwds(opts: SearchOptions): Promise<string[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("list_cwds", { opts });
}

/**
 * Walk up from `path` until a `.git` entry is found and return that
 * directory — the worktree root. `null` if `path` isn't inside a git
 * repo (or in any non-Tauri context).
 */
export async function gitRootFor(path: string): Promise<string | null> {
  if (!isTauriContext()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("git_root_for", { path });
}

/**
 * Fetch the user's home directory once. Used by the M7.6 cwd
 * compaction — the frontend caches the result at boot and passes it
 * into `compactCwd()` to display `~/dev/shax` instead of
 * `/Users/ada/dev/shax` in tab labels, the prompt strip, and the
 * statusline. `null` when the backend can't resolve one (rare —
 * minimal sandbox / headless test).
 */
export async function homeDir(): Promise<string | null> {
  if (!isTauriContext()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("home_dir");
}

/**
 * Fetch a block's captured bytes by id alone, straight from the store.
 * Used by the search-results viewer: hits are scoped to history, not to
 * any specific live pane, so we can't address the bytes by `(pty, block)`.
 */
export async function blockGetOutput(blockId: BlockId): Promise<Uint8Array> {
  if (!isTauriContext()) return new Uint8Array();
  const { invoke } = await import("@tauri-apps/api/core");
  const b64 = await invoke<string>("block_get_output", { blockId });
  return base64Decode(b64);
}

/**
 * Read a file's raw bytes from disk. The viewer modal uses this for
 * binary content (images) because the PTY's line discipline corrupts
 * binary captured-stdout bytes (`\n` → `\r\n` mangles every PNG signature).
 * Rejects (with the OS-level error string) on missing file, permission
 * denied, or files over 32 MiB. Empty Uint8Array in non-Tauri contexts.
 */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  if (!isTauriContext()) return new Uint8Array();
  const { invoke } = await import("@tauri-apps/api/core");
  const b64 = await invoke<string>("read_file_bytes", { path });
  return base64Decode(b64);
}

/** One directory entry, as classified by the backend. The string
 *  enum mirrors the Rust `DirEntryKind` with `serde(rename_all =
 *  "snake_case")`. */
export type DirEntryKind = "dir" | "file" | "symlink" | "device" | "socket" | "fifo" | "other";

export interface DirEntry {
  name: string;
  kind: DirEntryKind;
  size: number;
  /** Unix-epoch milliseconds; null if the platform can't report. */
  modified_ms: number | null;
  is_executable: boolean;
  /** Set only when `kind === "symlink"`. */
  symlink_target: string | null;
}

/**
 * Authoritative directory listing for the `ls` formatter
 * (slice 4.4). Re-probes the filesystem so colours / icons /
 * sizes come from `stat`, not from parsing the colour codes the
 * shell happened to print.
 *
 * Rejects with the OS-level error string on ENOENT / EACCES /
 * ENOTDIR. The formatter falls back to RAW silently.
 */
export async function readDirEntries(path: string): Promise<DirEntry[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DirEntry[]>("read_dir_entries", { path });
}

/**
 * Run `git status --porcelain=v2 --branch -z` in `cwd` and return
 * stdout. Used by the slice-4.5 git-status formatter so we parse a
 * stable machine-readable format instead of screen-scraping the
 * human-readable one. Rejects with the backend's error string on
 * not-a-repo / git-not-found / 10s timeout.
 */
export async function gitStatusPorcelain(cwd: string): Promise<string> {
  if (!isTauriContext()) return "";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("git_status_porcelain", { cwd });
}

/** A branch known to the repo. Powers the `git checkout` palette
 *  picker (M8.3). `kind: "local"` for `refs/heads/*` refs, `"remote"`
 *  for `refs/remotes/*`. `is_current` reflects `%(HEAD)` — true for
 *  the checked-out branch, false for everything else. */
export interface GitBranch {
  name: string;
  is_current: boolean;
  kind: "local" | "remote";
}

/**
 * List every branch known to the repo (local heads + remote-tracking).
 * Runs `git for-each-ref` on the backend so we never scrape porcelain
 * output. Returns an empty array outside Tauri. Rejects with the
 * backend's error string on not-a-repo / git-not-found / 10s timeout.
 */
export async function gitBranches(cwd: string): Promise<GitBranch[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<GitBranch[]>("git_branches", { cwd });
}

/**
 * Read the local `user.email` git config for `cwd`. Returns `null`
 * when the key isn't set or the process isn't in a Tauri context.
 * Powers the palette commit panel's `--signoff` toggle (M8.4) —
 * we only surface the toggle when a meaningful `Signed-off-by:`
 * line can be produced.
 */
export async function gitUserEmail(cwd: string): Promise<string | null> {
  if (!isTauriContext()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("git_user_email", { cwd });
}

/**
 * Run `git diff <args>` in `cwd` and return stdout. The unified
 * diff format is the machine-readable format already, so we don't
 * substitute the args — we replay what the user typed.
 */
export async function gitDiff(cwd: string, args: readonly string[]): Promise<string> {
  if (!isTauriContext()) return "";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("git_diff", { cwd, args: [...args] });
}

/**
 * One community formatter discovered on disk. Shape matches the
 * Rust `CommunityFormatterPayload`.
 */
export interface CommunityFormatterPayload {
  name: string;
  manifest_json: string;
  source_js: string;
}

/**
 * Read every community formatter from
 * `~/.config/shax/formatters/`. Returns an empty list when the
 * directory doesn't exist (the common case for a fresh install).
 * Per-formatter parse / size failures are logged on the backend
 * and silently skipped — a single malformed add-on doesn't break
 * the rest of the load.
 */
export async function listCommunityFormatters(): Promise<CommunityFormatterPayload[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CommunityFormatterPayload[]>("list_community_formatters");
}

/**
 * One community palette command discovered on disk. Shape matches
 * the Rust `CommunityCommandPayload` (M8.5 spec §14).
 */
export interface CommunityCommandPayload {
  name: string;
  manifest_json: string;
  source_js: string;
}

/**
 * Read every community palette command from
 * `~/.config/shax/commands/`. Empty when the directory doesn't
 * exist. Per-command parse / size failures are logged on the
 * backend and silently skipped so one bad add-on doesn't break
 * the load.
 */
export async function listCommunityCommands(): Promise<CommunityCommandPayload[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CommunityCommandPayload[]>("list_community_commands");
}

/**
 * File statistics returned by `statFile`. Shape mirrors the
 * backend `FileStat` (`serde` snake_case).
 *
 * - `created_unix_ms` is `null` on filesystems that don't
 *   track birth time (older Linux ext4 without statx, some
 *   network mounts).
 * - `is_executable` is `null` on Windows (no equivalent bit;
 *   the caller can fall back to extension heuristics).
 * - `symlink_target` is populated only when `is_symlink` is
 *   true and the target can be read.
 */
export interface FileStat {
  name: string;
  path: string;
  size_bytes: number;
  is_directory: boolean;
  is_symlink: boolean;
  is_executable: boolean | null;
  created_unix_ms: number | null;
  modified_unix_ms: number;
  symlink_target: string | null;
}

/**
 * Fetch filesystem metadata for a single path. Used by the
 * INFO lens on cat / bat blocks — a universal `FILE` section
 * on every text or binary file with a path in argv.
 *
 * Returns `null` outside a Tauri context (jsdom tests / browser
 * preview) or if the path can't be stat'd — the caller
 * gracefully falls back to hiding the FILE section.
 */
export async function statFile(path: string): Promise<FileStat | null> {
  if (!isTauriContext()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<FileStat>("stat_file", { path });
  } catch (err) {
    console.warn(`statFile(${path}) failed: ${String(err)}`);
    return null;
  }
}

/**
 * Spawn a fresh Shax window (M9.3). The new window loads the same
 * frontend bundle and runs its own React tree against the shared
 * Rust backend. Returns the Tauri window label assigned to the new
 * window — callers rarely need this since every command derives the
 * calling window from the injected `WebviewWindow`, but it's useful
 * for logging / diagnostics.
 *
 * No-op outside a Tauri context (jsdom tests / browser preview) —
 * returns an empty string so callers can `await` without a null
 * check.
 */
export async function openNewWindow(): Promise<string> {
  if (!isTauriContext()) return "";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("open_new_window");
}

/**
 * M9.6: list the PTY ids that are currently running a
 * foreground non-alt-screen command. Frontend calls this at
 * close-time (pane / tab / window / app quit) and intersects
 * with the PTY ids it owns for the closing scope to compute
 * the "N commands are still running" warning count. Empty
 * result → no warning. Empty return outside a Tauri context so
 * jsdom tests can call it freely.
 */
export async function ptyRunningCommands(): Promise<PtyId[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PtyId[]>("pty_running_commands");
}

/**
 * M9.6: confirm a window-close after the frontend showed the
 * warning modal and the user clicked "Close anyway". Sets the
 * per-window bypass flag on the backend, then re-invokes the
 * window's close — the on_window_event intercept sees the
 * flag and lets the close proceed without re-showing the
 * warning. No-op outside a Tauri context.
 */
export async function closeWindowConfirmed(label: string): Promise<void> {
  if (!isTauriContext()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("close_window_confirmed", { label });
}

/**
 * M9.6: confirm an app-quit after the frontend showed the
 * warning modal and the user clicked "Quit anyway". Sets the
 * app-wide bypass flag on the backend, then triggers
 * `app.exit(0)` — the ExitRequested handler sees the flag
 * and lets the exit proceed. No-op outside a Tauri context.
 */
export async function quitConfirmed(): Promise<void> {
  if (!isTauriContext()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("quit_confirmed");
}

// ── M10.2: theme catalog ──────────────────────────────────────

/**
 * A single ANSI 16-colour palette. Field names match xterm's
 * `ITheme` shape so the object can be spread straight in.
 */
export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Terminal-surface colours consumed by xterm.js. */
export interface TerminalPalette {
  foreground: string;
  background: string;
  cursor: string;
  selectionBackground: string;
  ansi: AnsiPalette;
}

/** Syntax-highlighting colours consumed by the code viewer,
 *  hljs-rendered code fences, and (M12.5) the prompt-strip's
 *  live shell tokenizer. hljs-flavoured names cover the editor
 *  side; `command`/`subcommand`/`flag`/`variable`/`operator`
 *  carry the shell-specific kinds. `string` and `comment` are
 *  shared across both so quoted-arg-in-prompt matches
 *  string-in-Rust-file. Mirrors `SyntaxPalette` in
 *  `src-tauri/src/themes.rs`. */
export interface SyntaxPalette {
  comment: string;
  keyword: string;
  string: string;
  number: string;
  literal: string;
  builtin: string;
  name: string;
  title: string;
  type: string;
  command: string;
  subcommand: string;
  flag: string;
  variable: string;
  operator: string;
}

/**
 * A complete theme preset returned by `listThemes` (M10.1).
 * `chrome` is a free-form map of CSS custom property names →
 * colour values so the catalog can grow tokens without a
 * schema change.
 */
export interface Theme {
  id: string;
  name: string;
  mode: "light" | "dark";
  source: string;
  license: string;
  chrome: Record<string, string>;
  terminal: TerminalPalette;
  syntax: SyntaxPalette;
  warning: string;
  caution: string;
  match: string;
}

// One-shot session cache. The catalog is fixed at compile
// time on the Rust side (embedded via include_str!), so
// re-fetching would return the same bytes every time.
let themesCache: Theme[] | null = null;

/**
 * Fetch the full built-in theme catalog (M10.1). Cached for
 * the session — every subsequent call resolves to the same
 * array reference. Outside Tauri returns an empty list so the
 * app still mounts in plain-browser dev (theme resolution
 * falls back to Shax Dark defaults baked into tokens.css).
 */
export async function listThemes(): Promise<Theme[]> {
  if (themesCache !== null) return themesCache;
  if (!isTauriContext()) {
    themesCache = [];
    return themesCache;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  themesCache = await invoke<Theme[]>("list_themes");
  return themesCache;
}

/** Test-only: forget the cached catalog so a subsequent
 *  `listThemes()` re-fetches. Never called from app code. */
export function __resetThemesCacheForTest(): void {
  themesCache = null;
}

// ── M12.4b: system status probes ────────────────────────────────────

/**
 * Snapshot of the host's power state, mirrors `BatteryStatus` in
 * `src-tauri/src/status.rs`. All rendering flows from the two
 * orthogonal booleans below; the frontend never proxies on percent.
 *
 * - `present = false` → desktop machine (no battery installed) OR
 *   the OS probe failed. Frontend renders the "plug alone" glyph.
 * - `present = true` → laptop with a battery. `percent` is 0..=100
 *   when the OS reported one and `null` when firmware returned
 *   garbage.
 * - `on_ac_power` — the machine is drawing wall power right now.
 *   True for both actively-charging AND fully-charged-plugged-in
 *   (macOS reports `charging=false` in the latter case). False for
 *   any laptop on battery, including a fully-charged laptop that
 *   was just unplugged.
 * - `charging` — the battery is actively being *charged*. True only
 *   when energy flows in. Frontend uses this only for the tooltip
 *   distinction "Charging (X%)" vs "AC power (X%)".
 */
export interface BatteryStatus {
  present: boolean;
  percent: number | null;
  on_ac_power: boolean;
  charging: boolean;
  /** OS-reported seconds until full (when charging) or until empty
   *  (when discharging), or null when at rest / unknown. Consumed by
   *  the sidebar Battery widget's `4h 20m` label; the statusbar chip
   *  currently only uses `percent`, `on_ac_power`, and `charging`. */
  seconds_remaining: number | null;
}

/** Absent-battery sentinel — used as the default before the first
 *  poll returns AND in the non-Tauri dev shell (browser). */
const BATTERY_ABSENT: BatteryStatus = {
  present: false,
  percent: null,
  on_ac_power: false,
  charging: false,
  seconds_remaining: null,
};

/** Poll the host's power state. Outside Tauri returns the absent
 *  sentinel so the browser dev shell renders the desktop chip. */
export async function systemBattery(): Promise<BatteryStatus> {
  if (!isTauriContext()) return BATTERY_ABSENT;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<BatteryStatus>("system_battery");
}

/** Poll the host's local IP (default-route interface). Outside
 *  Tauri returns null so the browser dev shell hides the chip. */
export async function systemLocalIp(): Promise<string | null> {
  if (!isTauriContext()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("system_local_ip");
}

/** CPU + memory snapshot for the sidebar's CpuMem widget (M13.3).
 *
 *  Percentages are 0..=100 floats (fractional). Memory is in bytes
 *  on both axes so the frontend can format ("3.4 GB / 16.0 GB") or
 *  derive its own percentage. The first call after startup returns
 *  cpu_percent = 0 (sysinfo needs a delta between two refreshes to
 *  compute usage); the second poll has real data. */
export interface SystemLoad {
  cpu_percent: number;
  mem_used_bytes: number;
  mem_total_bytes: number;
  /** Swap actually in use — not swap configured. Zero on machines
   *  with no active swap traffic (an idle Mac often reads exactly 0
   *  here even when `swap_total_bytes > 0`). */
  swap_used_bytes: number;
  /** Configured swap capacity. When 0, no swap is configured; the
   *  memory card hides its swap line rather than reading `0.0 / 0.0`. */
  swap_total_bytes: number;
  /** One-minute load average, or null where the platform has none to
   *  give (Windows). The CPU card omits the reading rather than
   *  printing a confident, meaningless `load 0.00`. */
  load_average_one: number | null;
  /** Physical core count, or null when the platform won't say. */
  core_count: number | null;
}

const SYSTEM_LOAD_ZERO: SystemLoad = {
  cpu_percent: 0,
  mem_used_bytes: 0,
  mem_total_bytes: 0,
  swap_used_bytes: 0,
  swap_total_bytes: 0,
  load_average_one: null,
  core_count: null,
};

/** The latest CPU/memory snapshot plus the recent CPU history behind
 *  it (M13 refinement). Both are owned by the backend because they
 *  are host-global facts and every window must agree on them — see
 *  `SystemLoadSeries` in `status.rs` for why per-window polling was
 *  not merely inconsistent but actively corrupted the readings. */
/** Bytes/sec for one interface, keyed by name so it can be joined to
 *  the descriptive data from `netInterfaces()`, which refreshes on a
 *  slower tier (spec §19 D5 item 3). */
export interface InterfaceRate {
  name: string;
  up_bps: number;
  down_bps: number;
}

export interface SystemLoadSeries {
  current: SystemLoad;
  /** Empty on the first sample: throughput is a delta, and with no
   *  previous sample there is no interval to divide by. */
  net_rates: InterfaceRate[];
  /** Oldest first, newest last. Shorter than the full window until
   *  the sampler has run long enough; the card draws empty slots
   *  rather than inventing readings. */
  history: number[];
}

const SYSTEM_LOAD_SERIES_EMPTY: SystemLoadSeries = {
  current: SYSTEM_LOAD_ZERO,
  net_rates: [],
  history: [],
};

/** Read the series once, for a window mounting mid-stream. Without
 *  this a window opened an hour in would start with an empty
 *  sparkline while its sibling showed a full one. */
export async function systemLoadSeries(): Promise<SystemLoadSeries> {
  if (!isTauriContext()) return SYSTEM_LOAD_SERIES_EMPTY;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SystemLoadSeries>("system_load_series");
}

/** Subscribe to the backend sampler. Returns an unsubscribe function.
 *
 *  There is no polling here on purpose. CPU usage is a delta between
 *  refreshes, so if each window drove its own refresh the cadence —
 *  and therefore the meaning of the number — would depend on how many
 *  windows were open. */
export function onSystemLoad(handler: (series: SystemLoadSeries) => void): () => void {
  if (!isTauriContext()) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<SystemLoadSeries>("shax:system-load", (e) => handler(e.payload)).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    }),
  );
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** Poll the connected Wi-Fi SSID (M13.3). Returns null when
 *  disconnected, when the probe fails, or unconditionally on macOS
 *  (see the Rust-side doc on `system_ssid` for why — Apple masks
 *  the SSID without a CoreLocation entitlement we deliberately
 *  don't request). The Network widget hides the SSID line when
 *  this is null and still renders the IP + up/down dot. */
/** How the primary interface connects. `unknown` is a real answer —
 *  a tunnel, a bridge, a platform we couldn't ask — and is never
 *  collapsed into `wired`, which was the original defect. */
export type NetworkMedium = "wi_fi" | "wired" | "unknown";

/** Whether the OS will hand over the network's name. Only macOS is
 *  ever anything but `not_required`; the distinction lets the card
 *  say "we can't name this" and "you haven't allowed it yet"
 *  differently, because they call for different responses. */
export type SsidAccess = "not_required" | "granted" | "not_determined" | "denied";

export interface WifiInfo {
  medium: NetworkMedium;
  ssid: string | null;
  ssid_access: SsidAccess;
}

const WIFI_UNKNOWN: WifiInfo = {
  medium: "unknown",
  ssid: null,
  ssid_access: "not_required",
};

export type InterfaceKind = "wi_fi" | "ethernet" | "vpn" | "other";

/** Wi-Fi specifics. Everything except `ssid` is readable with no
 *  permission, so declining the macOS location prompt costs the name
 *  and nothing else. */
export interface WifiDetail {
  ssid: string | null;
  ssid_access: SsidAccess;
  /** Raw dBm, for the tooltip. */
  rssi: number | null;
  /** 0-4, for the bar glyph. */
  bars: number | null;
  channel: number | null;
  security: string | null;
  /** True only when the OS itself detected a portal — we make no
   *  request of our own to find out. */
  captive: boolean;
}

export interface LinkDetail {
  speed_mbps: number | null;
  media: string | null;
  full_duplex: boolean | null;
}

export interface NetInterface {
  name: string;
  ip: string;
  kind: InterfaceKind;
  /** The interface holding the default route; the card opens here. */
  is_primary: boolean;
  wifi: WifiDetail | null;
  link: LinkDetail | null;
}

/** Every interface that is up and holds an address, primary first.
 *  The slow tier — 30s — because obtaining it means forking
 *  `networksetup` / `scutil` / `ifconfig` for values that essentially
 *  never change. */
export async function netInterfaces(): Promise<NetInterface[]> {
  if (!isTauriContext()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NetInterface[]>("net_interfaces");
}

/** Medium + SSID + access state for the primary interface. */
export async function wifiInfo(): Promise<WifiInfo> {
  if (!isTauriContext()) return WIFI_UNKNOWN;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WifiInfo>("wifi_info");
}

/** Ask macOS for location access so the SSID becomes readable, and
 *  return the state that holds afterwards. A no-op on every other
 *  platform, and on macOS once the user has already answered. */
export async function wifiRequestSsidAccess(): Promise<WifiInfo> {
  if (!isTauriContext()) return WIFI_UNKNOWN;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WifiInfo>("wifi_request_ssid_access");
}

export async function systemSsid(): Promise<string | null> {
  if (!isTauriContext()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("system_ssid");
}

/** The keep-awake assertion's state (M13.4, spec §19 D6). `sinceMs`
 *  is a Unix-epoch millisecond stamp owned by the backend, present
 *  only while held — so every window renders the same duration for
 *  the same assertion, including one that opened long after it
 *  started. */
export interface KeepAwakeState {
  held: boolean;
  since_ms: number | null;
}

const KEEP_AWAKE_OFF: KeepAwakeState = { held: false, since_ms: null };

/** Ask the OS to suppress idle sleep, or stop asking. Resolves to the
 *  state that actually holds afterwards — the backend is the source of
 *  truth, so a caller that optimistically rendered "on" must reconcile
 *  against this rather than assume the request succeeded. Rejects when
 *  the OS refuses; the assertion is guaranteed off in that case.
 *
 *  Also broadcasts `shax:keep-awake-changed` to every window — see
 *  `onKeepAwakeChanged`.
 *
 *  Outside Tauri (Playwright against the bare dev server) there is no
 *  OS to ask, so this resolves to "off" and the widget stays off. */
export async function powerKeepAwake(enable: boolean): Promise<KeepAwakeState> {
  if (!isTauriContext()) return KEEP_AWAKE_OFF;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<KeepAwakeState>("power_keep_awake", { enable });
}

/** Read the assertion back. The assertion is process-wide and outlives
 *  any single window's React tree, so a reloaded or newly-opened window
 *  adopts it rather than assuming off. */
export async function powerKeepAwakeState(): Promise<KeepAwakeState> {
  if (!isTauriContext()) return KEEP_AWAKE_OFF;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<KeepAwakeState>("power_keep_awake_state");
}

/** Subscribe to keep-awake changes made anywhere in the app. Returns
 *  an unsubscribe function.
 *
 *  One assertion, many windows: without this, a window that didn't
 *  issue the toggle would keep showing whatever it read at mount — an
 *  "off" switch on a machine that is genuinely being kept awake. */
export function onKeepAwakeChanged(handler: (state: KeepAwakeState) => void): () => void {
  if (!isTauriContext()) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<KeepAwakeState>("shax:keep-awake-changed", (e) => handler(e.payload)).then((off) => {
      // The caller may have unsubscribed while the dynamic import was
      // still resolving; honour that rather than leaking the listener.
      if (cancelled) off();
      else unlisten = off;
    }),
  );
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
