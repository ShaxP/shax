/**
 * Host-side Worker manager for sandboxed palette commands
 * (M8.5 spec §14). One Worker per registered community command,
 * lazily spawned on first invocation and kept alive across
 * palette openings.
 *
 * Two-phase protocol so the user can fill in the panel between
 * calls:
 *
 *   invokeBuildPanel(ctx)     — returns PanelNode | null
 *   invokeBuildCommand(values) — returns string | null | undefined
 *                                (undefined = worker failure;
 *                                 null = command explicitly cancelled)
 *
 * Same security posture as the formatter sandbox: no DOM, no
 * window, no fetch to same origin (blob URL), no Tauri invoke.
 * A runaway command stays trapped on its own thread until the
 * per-phase timeout reaps it.
 */

import type { CommunityCommandContext } from "./types";
import { estimateNodeBytes, isPanelNode, type PanelNode } from "./schema";
import { buildWorkerSource } from "./workerEntry";

/** Hard timeout per phase. Matches the formatter host so users
 *  never wait longer than 1 s on a stuck sandbox call. */
const INVOCATION_TIMEOUT_MS = 1000;

/** Cap on the panel schema size (bytes, approx) so a malicious
 *  worker can't return a multi-gigabyte tree that crashes the
 *  renderer. Same cap as formatters. */
const MAX_SCHEMA_BYTES = 1 * 1024 * 1024;

/** Cap on the command string length so a runaway worker can't
 *  produce a gigabyte-long shell command. */
const MAX_COMMAND_LENGTH = 128 * 1024;

/** Invoke the sandboxed command's buildPanel phase. Returns the
 *  validated PanelNode on success, `null` if the worker failed
 *  (missing function, threw, timed out, returned malformed
 *  data, exceeded cap). Caller renders an error state on
 *  `null`. */
export async function invokeBuildPanel(
  name: string,
  source: string,
  ctx: CommunityCommandContext,
): Promise<PanelNode | null> {
  if (typeof Worker === "undefined") return null;
  const worker = getOrSpawnWorker(name, source);
  if (worker === null) return null;
  invocationCount++;
  publishDebugHandle();
  return new Promise((resolve) => {
    const id = nextRequestId();
    let resolved = false;
    const timer = window.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      tearDownWorker(name);
      resolve(null);
    }, INVOCATION_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { id?: number } | undefined;
      if (data?.id !== id) return;
      worker.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      resolve(validatePanelReply(event.data));
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, phase: "buildPanel", ctx });
  });
}

/** Invoke the sandboxed command's buildCommand phase. Returns
 *  the command string on success, `null` if the worker returned
 *  `null` (explicit cancel), or `undefined` if the worker
 *  failed. Caller distinguishes these:
 *
 *    - `string` → emit the command through the safety gate
 *    - `null`   → close the palette without emitting
 *    - `undefined` → surface an error and let the user retry
 */
export async function invokeBuildCommand(
  name: string,
  values: Record<string, unknown>,
): Promise<string | null | undefined> {
  const worker = WORKERS.get(name);
  if (worker === undefined) return undefined;
  invocationCount++;
  publishDebugHandle();
  return new Promise((resolve) => {
    const id = nextRequestId();
    let resolved = false;
    const timer = window.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      tearDownWorker(name);
      resolve(undefined);
    }, INVOCATION_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { id?: number } | undefined;
      if (data?.id !== id) return;
      worker.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      resolve(validateCommandReply(event.data));
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, phase: "buildCommand", values });
  });
}

/** Tear down all known sandbox-command workers. Tests use this
 *  for isolation; the app calls it on shutdown. */
export function tearDownAllCommandWorkers(): void {
  for (const name of Array.from(WORKERS.keys())) {
    tearDownWorker(name);
  }
}

// ─── internals ──────────────────────────────────────────────────

const WORKERS = new Map<string, Worker>();
let requestCounter = 0;
let invocationCount = 0;

function nextRequestId(): number {
  requestCounter = (requestCounter + 1) | 0;
  return requestCounter;
}

function getOrSpawnWorker(name: string, source: string): Worker | null {
  const existing = WORKERS.get(name);
  if (existing !== undefined) return existing;
  try {
    const code = buildWorkerSource(source);
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    WORKERS.set(name, worker);
    console.info(`[shax command sandbox] spawned worker for "${name}"`);
    publishDebugHandle();
    return worker;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`command sandbox: failed to spawn worker for ${name}: ${msg}`);
    return null;
  }
}

function tearDownWorker(name: string): void {
  const worker = WORKERS.get(name);
  if (worker === undefined) return;
  try {
    worker.terminate();
  } catch {
    // best-effort
  }
  WORKERS.delete(name);
  console.info(`[shax command sandbox] tore down worker for "${name}"`);
  publishDebugHandle();
}

interface ShaxCommandSandboxDebug {
  readonly active: readonly string[];
  readonly invocations: number;
}

function publishDebugHandle(): void {
  if (typeof window === "undefined") return;
  const debug: ShaxCommandSandboxDebug = {
    active: Array.from(WORKERS.keys()),
    invocations: invocationCount,
  };
  (window as unknown as { __shaxCommandSandbox?: ShaxCommandSandboxDebug }).__shaxCommandSandbox =
    debug;
}

function validatePanelReply(data: unknown): PanelNode | null {
  if (typeof data !== "object" || data === null) return null;
  const reply = data as { ok?: unknown; node?: unknown; reason?: unknown };
  if (reply.ok !== true) {
    if (typeof reply.reason === "string" && reply.reason.length > 0) {
      console.warn(`command sandbox: buildPanel declined: ${reply.reason}`);
    }
    return null;
  }
  const node = reply.node;
  const approxSize = estimateNodeBytes(node);
  if (approxSize > MAX_SCHEMA_BYTES) {
    console.warn(`command sandbox: panel exceeds ${MAX_SCHEMA_BYTES} bytes (got ~${approxSize})`);
    return null;
  }
  if (!isPanelNode(node)) return null;
  return node;
}

function validateCommandReply(data: unknown): string | null | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const reply = data as { ok?: unknown; command?: unknown; reason?: unknown };
  if (reply.ok !== true) {
    if (typeof reply.reason === "string" && reply.reason.length > 0) {
      console.warn(`command sandbox: buildCommand declined: ${reply.reason}`);
    }
    return undefined;
  }
  const cmd = reply.command;
  if (cmd === null) return null;
  if (typeof cmd !== "string") return undefined;
  if (cmd.length > MAX_COMMAND_LENGTH) {
    console.warn(
      `command sandbox: command exceeds ${MAX_COMMAND_LENGTH} chars (got ${cmd.length})`,
    );
    return undefined;
  }
  return cmd;
}
