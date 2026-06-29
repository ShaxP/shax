/**
 * Host-side Worker manager for sandboxed formatters
 * (slice 4.6b1).
 *
 * One Worker per registered community formatter. The Worker is
 * spawned lazily on first invocation and kept alive across
 * blocks (cheap — the worker init runs once). A 1-second
 * timeout protects against hung user code; on timeout the
 * Worker is terminated and a fresh one is spun up next time.
 *
 * The single invocation slot is serialised: while one block is
 * being formatted, subsequent invocations queue. In practice
 * the renderer only invokes a formatter once per block per
 * mount, so contention is rare.
 *
 * **Why a Worker, not just `eval`?** The worker is the security
 * boundary. Community formatter code can't reach the host's
 * `window`, the DOM, the user's clipboard, or our Tauri
 * `invoke` surface — none of those exist in a Worker context.
 * It also can't block the main thread; a runaway formatter
 * stays trapped on its own thread until our timeout reaps it.
 */

import { isSandboxNode, type SandboxNode } from "./schema";
import { buildWorkerSource } from "./workerEntry";

/** Hard timeout per invocation. Community formatters that take
 *  longer than this are reaped and the block falls back to
 *  RAW. Slightly higher than the 100 ms target most renderers
 *  need so we don't kill legitimate slow ones, low enough that
 *  a runaway loop doesn't keep the user waiting. */
const INVOCATION_TIMEOUT_MS = 1000;

/** Maximum size of the schema returned by a worker, in bytes
 *  (UTF-16 chars × 2 for an approximation). Stops a malicious
 *  formatter from returning a multi-gigabyte tree that crashes
 *  the renderer. */
const MAX_SCHEMA_BYTES = 1 * 1024 * 1024; // 1 MiB

export interface SandboxInvokeContext {
  readonly argv: readonly string[];
  readonly cwd: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

/**
 * Invoke the sandboxed formatter identified by `name` with the
 * given context. Returns the validated schema node on success,
 * or `null` if the worker failed (no render fn, threw, timed
 * out, returned malformed data, exceeded the size cap). The
 * caller treats `null` like a `PASS` from a built-in formatter
 * — fall back to RAW.
 *
 * If `Worker` isn't available (jsdom in vitest, very old runtimes),
 * returns `null` synchronously. Tests for the worker dispatch
 * logic exercise `buildWorkerSource` directly, not through this
 * function.
 */
export async function invokeSandboxFormatter(
  name: string,
  source: string,
  ctx: SandboxInvokeContext,
): Promise<SandboxNode | null> {
  if (typeof Worker === "undefined") return null;
  const worker = getOrSpawnWorker(name, source);
  if (worker === null) return null;
  return new Promise((resolve) => {
    const id = nextRequestId();
    let resolved = false;
    const timer = window.setTimeout(() => {
      if (resolved) return;
      resolved = true;
      // The worker is non-responsive — reap it. Next invocation
      // will spin a fresh one.
      tearDownWorker(name);
      resolve(null);
    }, INVOCATION_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { id?: number } | undefined;
      if (data?.id !== id) return; // stale / out-of-order
      worker.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      const result = validateWorkerReply(event.data);
      resolve(result);
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, ctx });
  });
}

/** Tear down all known sandbox workers. Tests call this for
 *  isolation; the app calls it on shutdown to avoid lingering
 *  background threads. */
export function tearDownAllWorkers(): void {
  for (const name of Array.from(WORKERS.keys())) {
    tearDownWorker(name);
  }
}

// ─── internals ──────────────────────────────────────────────────

const WORKERS = new Map<string, Worker>();
let requestCounter = 0;

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
    // The blob URL can be revoked immediately — the worker holds
    // its own reference to the source until terminated.
    URL.revokeObjectURL(url);
    WORKERS.set(name, worker);
    return worker;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`sandbox: failed to spawn worker for ${name}: ${msg}`);
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
}

function validateWorkerReply(data: unknown): SandboxNode | null {
  if (typeof data !== "object" || data === null) return null;
  const reply = data as { ok?: unknown; node?: unknown; reason?: unknown };
  if (reply.ok !== true) {
    if (typeof reply.reason === "string" && reply.reason.length > 0) {
      console.warn(`sandbox: worker declined: ${reply.reason}`);
    }
    return null;
  }
  const node = reply.node;
  // Size cap before validation — limits how much we walk on the
  // worst-case malformed input.
  let approxSize: number;
  try {
    approxSize = JSON.stringify(node).length * 2;
  } catch {
    return null; // unserialisable means we can't validate
  }
  if (approxSize > MAX_SCHEMA_BYTES) {
    console.warn(`sandbox: returned schema exceeds ${MAX_SCHEMA_BYTES} bytes (got ~${approxSize})`);
    return null;
  }
  if (!isSandboxNode(node)) return null;
  return node;
}
