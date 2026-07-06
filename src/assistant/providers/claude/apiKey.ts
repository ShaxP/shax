/**
 * Claude provider — API key lane (M6 slice 2a).
 *
 * Implements `AssistantProvider` by delegating to the Rust
 * proxy. Per the slice's Rust-proxy decision, the API key
 * lives in the OS keychain and never crosses the IPC
 * boundary: the renderer sends messages + tools, Rust
 * fetches the key, calls Anthropic, and streams events back
 * over a Tauri `Channel`.
 *
 * Capabilities: full — tools, subagents, streaming, image
 * input. Context window is a best-effort guess for the
 * default sonnet-tier model; can be revised per-model.
 */

import type {
  AssistantProvider,
  ProviderCapabilities,
  StreamEvent,
  StreamInput,
  ToolCall,
  ToolVerdict,
} from "../../provider";

/** Wire shape of the `claude_stream` command's input. Kept
 *  separate from `StreamInput` because the Rust side needs
 *  the `model` and `max_tokens` fields explicitly and expects
 *  Anthropic-shaped messages. */
interface ClaudeStreamCommandInput {
  model: string;
  messages: ClaudeMessage[];
  tools: ClaudeTool[];
  system: string | null;
  max_tokens: number;
}

interface ClaudeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ClaudeContentBlock[];
  tool_call_id?: string;
}

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface ClaudeTool {
  name: string;
  description: string;
  input_schema: unknown;
}

/** Wire shape of `StreamEvent` as it arrives from Rust. The
 *  Rust enum is tagged with `kind` in snake_case. */
type WireStreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string }
  | { kind: "done"; stop_reason: string };

const CAPABILITIES: ProviderCapabilities = {
  tools: true,
  subagents: true,
  streaming: true,
  imageInput: true,
  contextWindow: 200_000,
};

/** Default model — kept in one place so a future settings
 *  dropdown can override without touching the provider
 *  itself. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Factory rather than a plain object so tests can inject a
 *  mock invoker. In production, `invoker` defaults to the
 *  Tauri `invoke`. */
export function createClaudeApiKeyProvider(opts?: {
  invoker?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  model?: string;
  onToolProposed?: (call: ToolCall) => Promise<ToolVerdict>;
}): AssistantProvider {
  const model = opts?.model ?? DEFAULT_MODEL;
  return {
    id: "claude",
    displayName: "Claude (Anthropic API)",
    authKind: "api-key",
    privacyPosture: "cloud",
    capabilities: CAPABILITIES,
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      return streamViaRust(input, model, opts?.invoker);
    },
    onToolProposed: opts?.onToolProposed,
  };
}

/** Bridge `StreamInput` → the Rust `claude_stream` command
 *  and yield events out of the Tauri `Channel`. Keeps the
 *  `AsyncIterable` shape callers already understand. */
async function* streamViaRust(
  input: StreamInput,
  model: string,
  injectedInvoker?: (command: string, args: Record<string, unknown>) => Promise<unknown>,
): AsyncIterable<StreamEvent> {
  const isTauri = injectedInvoker !== undefined || isTauriContext();
  if (!isTauri) {
    yield {
      kind: "error",
      message: "Claude provider requires a Tauri host — not available in this context",
    };
    yield { kind: "done", stopReason: "error" };
    return;
  }

  const commandInput = translateInput(input, model);

  // Buffer events between Rust pushes and this iterator's
  // consumer via a small queue. The Tauri Channel calls a
  // JS callback on every send; we flip that into an async
  // iterable by keeping a queue + pending resolver.
  const queue: WireStreamEvent[] = [];
  let waiter: ((event: WireStreamEvent | null) => void) | null = null;
  let done = false;

  const flushWaiter = (event: WireStreamEvent | null): boolean => {
    const w = waiter;
    if (w === null) return false;
    waiter = null;
    w(event);
    return true;
  };
  const push = (event: WireStreamEvent): void => {
    if (!flushWaiter(event)) queue.push(event);
    if (event.kind === "done" || event.kind === "error") {
      done = true;
      // A separate flush for the null-terminator; if the
      // consumer is already awaiting `next()`, deliver `null`.
      flushWaiter(null);
    }
  };

  const next = (): Promise<WireStreamEvent | null> => {
    const buffered = queue.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (done) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  };

  const invokePromise = (async () => {
    if (injectedInvoker !== undefined) {
      // Test-mode invoker: caller synchronously invokes `push`
      // via a side channel. Nothing to do here.
      await injectedInvoker("claude_stream", { input: commandInput, onEvent: push });
      return;
    }
    const { invoke, Channel: TauriChannel } = await import("@tauri-apps/api/core");
    // Import at call site so jsdom tests never load @tauri-apps/api/core.
    const ch = new TauriChannel<WireStreamEvent>();
    ch.onmessage = push;
    try {
      await invoke("claude_stream", { input: commandInput, onEvent: ch });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      push({ kind: "error", message });
      push({ kind: "done", stop_reason: "error" });
    }
  })();

  try {
    while (true) {
      const event = await next();
      if (event === null) break;
      const translated = translateEvent(event);
      if (translated !== null) yield translated;
      if (event.kind === "done" || event.kind === "error") break;
    }
  } finally {
    await invokePromise.catch(() => {});
  }
}

function translateInput(input: StreamInput, model: string): ClaudeStreamCommandInput {
  const messages: ClaudeMessage[] = [];
  let system: string | null = null;
  for (const m of input.messages) {
    if (m.role === "system") {
      // Collect into the top-level system field; multiple
      // system messages concatenate.
      system = system === null ? m.content : `${system}\n\n${m.content}`;
      continue;
    }
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
        const blocks: ClaudeContentBlock[] = [];
        if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
        for (const call of m.toolCalls) {
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
        }
        messages.push({ role: "assistant", content: blocks });
      } else {
        messages.push({ role: "assistant", content: m.content });
      }
      continue;
    }
    if (m.role === "tool") {
      messages.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId });
    }
  }
  return {
    model,
    messages,
    tools: (input.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
    system,
    max_tokens: input.maxOutputTokens ?? 4096,
  };
}

function translateEvent(event: WireStreamEvent): StreamEvent | null {
  switch (event.kind) {
    case "text":
      return { kind: "text", delta: event.delta };
    case "tool_call":
      return {
        kind: "tool_call",
        call: { id: event.id, name: event.name, input: event.input },
      };
    case "warning":
      // Warnings surface in dev tools but don't reach the
      // caller as `StreamEvent`s — they're not error-severity
      // and the surface has no separate lane yet.
      console.warn(`claude stream: ${event.message}`);
      return null;
    case "error":
      return { kind: "error", message: event.message };
    case "done":
      return { kind: "done", stopReason: normaliseStopReason(event.stop_reason) };
  }
}

function normaliseStopReason(raw: string): "end_turn" | "tool_use" | "max_tokens" | "error" {
  switch (raw) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "error":
      return raw;
    default:
      return "end_turn";
  }
}

function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// --- Keychain helpers exposed for the settings UI ----------

/** Store the user's API key in the OS keychain. */
export async function setClaudeApiKey(secret: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_assistant_api_key", { providerId: "claude", secret });
}

/** True when a key has already been stored. Cheap: doesn't
 *  actually decrypt the key material. */
export async function hasClaudeApiKey(): Promise<boolean> {
  if (!isTauriContext()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("has_assistant_api_key", { providerId: "claude" });
}

/** Remove the stored API key. Idempotent. */
export async function deleteClaudeApiKey(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("delete_assistant_api_key", { providerId: "claude" });
}
