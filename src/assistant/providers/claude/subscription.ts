/**
 * Claude provider — subscription lane (M6 slice 2b).
 *
 * Drives the user's locally installed `claude` CLI as a
 * child process (per spec §09's hard licensing rule for
 * subscription auth — the only permitted path is to invoke
 * the user's own install). Shax never touches the token.
 *
 * Reuses the same `AssistantProvider` interface as the API
 * key lane; only the transport differs (`claude_cli_stream`
 * vs `claude_stream`). The chat surface consumes both
 * through the shared shape.
 *
 * MVP capabilities: text-only turns. `tools` / `subagents`
 * are declared `false` until we sort out how tool proposals
 * from the CLI thread through the safety gate. Text
 * streaming works today.
 */

import type {
  AssistantProvider,
  ProviderCapabilities,
  StreamEvent,
  StreamInput,
  ToolCall,
  ToolVerdict,
} from "../../provider";

/** Wire shape of the `claude_cli_stream` command's input.
 *  Deliberately identical to the API key lane's shape — the
 *  Rust side folds messages into a CLI-friendly prompt but
 *  the input schema is shared. */
interface ClaudeCliStreamCommandInput {
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

type WireStreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string }
  | { kind: "done"; stop_reason: string };

const CAPABILITIES: ProviderCapabilities = {
  // Text-only for the MVP subscription lane. Tools + subagents
  // require threading Claude Code's own tool-call proposals
  // through the safety gate, which is a follow-up.
  tools: false,
  subagents: false,
  streaming: true,
  imageInput: false,
  contextWindow: 200_000,
};

export const DEFAULT_MODEL = "claude-sonnet-4-6";

export function createClaudeSubscriptionProvider(opts?: {
  invoker?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  model?: string;
  onToolProposed?: (call: ToolCall) => Promise<ToolVerdict>;
}): AssistantProvider {
  const model = opts?.model ?? DEFAULT_MODEL;
  return {
    id: "claude",
    displayName: "Claude (via Claude Code subscription)",
    authKind: "subscription-delegate",
    privacyPosture: "cloud",
    capabilities: CAPABILITIES,
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      return streamViaCli(input, model, opts?.invoker);
    },
    onToolProposed: opts?.onToolProposed,
  };
}

async function* streamViaCli(
  input: StreamInput,
  model: string,
  injectedInvoker?: (command: string, args: Record<string, unknown>) => Promise<unknown>,
): AsyncIterable<StreamEvent> {
  const isTauri = injectedInvoker !== undefined || isTauriContext();
  if (!isTauri) {
    yield {
      kind: "error",
      message: "Claude subscription lane requires a Tauri host — not available in this context",
    };
    yield { kind: "done", stopReason: "error" };
    return;
  }

  const commandInput = translateInput(input, model);

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
      await injectedInvoker("claude_cli_stream", { input: commandInput, onEvent: push });
      return;
    }
    const { invoke, Channel: TauriChannel } = await import("@tauri-apps/api/core");
    const ch = new TauriChannel<WireStreamEvent>();
    ch.onmessage = push;
    try {
      await invoke("claude_cli_stream", { input: commandInput, onEvent: ch });
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

function translateInput(input: StreamInput, model: string): ClaudeCliStreamCommandInput {
  const messages: ClaudeMessage[] = [];
  let system: string | null = null;
  for (const m of input.messages) {
    if (m.role === "system") {
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
      console.warn(`claude-cli stream: ${event.message}`);
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

// --- CLI probe --------------------------------------------

/** Ask Rust to check for the `claude` CLI on PATH. Returns
 *  the reported version string when installed, `null` when
 *  not. Used by the settings UI to gate the subscription
 *  lane behind a "Claude Code detected" affordance. */
export async function probeClaudeCli(): Promise<string | null> {
  if (!isTauriContext()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<string | null>("claude_cli_probe");
  return result;
}
