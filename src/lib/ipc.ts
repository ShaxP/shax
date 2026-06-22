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
