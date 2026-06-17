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

export interface SpawnOpts {
  rows: number;
  cols: number;
  cwd?: string;
  env?: Record<string, string>;
}

export type PtyEvent =
  | { kind: "output"; data: string } // base64-encoded bytes
  | { kind: "exit"; code: number | null };

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
