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
