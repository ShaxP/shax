/**
 * Ollama provider — local lane (M6 slice 3).
 *
 * Talks HTTP to the local Ollama daemon (default
 * `http://localhost:11434`) via the Rust proxy. Same
 * "provider is a swappable backend" pattern as the Claude
 * lanes; the difference — deliberately — is what this
 * provider *declares*:
 *
 *   - **`privacyPosture: "local"`**: the whole point of
 *     shipping Ollama alongside Claude is to prove the
 *     graceful-degradation model. Users optimising for
 *     privacy see the ⌂ local badge in settings and know
 *     nothing leaves their machine.
 *   - **`authKind: "local"`**: no credential, no keychain,
 *     no configuration beyond picking a model.
 *   - **`tools: false`, `subagents: false`**: honest for the
 *     MVP. Tool support is model-dependent in Ollama; per-
 *     model capability probing is a follow-up.
 *   - **`streaming: true`**: works today.
 *
 * The chat surface (slice 4) will dim tool-using features
 * when this provider is active and the user will see a
 * "requires tool-calling" hint. That's the graceful
 * degradation from spec §09 in practice.
 */

import type {
  AssistantProvider,
  ProviderCapabilities,
  StreamEvent,
  StreamInput,
  ToolCall,
  ToolVerdict,
} from "../../provider";

interface OllamaStreamCommandInput {
  model: string;
  messages: OllamaMessage[];
  tools: OllamaTool[];
  system: string | null;
  max_tokens: number;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OllamaContentBlock[];
  tool_call_id?: string;
}

type OllamaContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface OllamaTool {
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

const BASE_CAPABILITIES: ProviderCapabilities = {
  tools: false,
  subagents: false,
  streaming: true,
  imageInput: false,
  // Context window varies wildly by model; report a modest
  // default. Chat surface can override once model metadata
  // is available.
  contextWindow: 8192,
};

/** Model name used when the user hasn't picked one — matches
 *  a common install. The settings modal always fills this in
 *  before invoking the provider, but a sane default keeps
 *  unit tests + accidental invocations from crashing. */
export const DEFAULT_MODEL = "llama3.1";

export function createOllamaProvider(opts?: {
  invoker?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  model?: string;
  onToolProposed?: (call: ToolCall) => Promise<ToolVerdict>;
  /** Per-model capability overrides discovered via
   *  `probeOllamaModel`. When absent, provider stays at the
   *  conservative base (`tools: false`, `imageInput: false`).
   *  When present, the provider honestly declares what the
   *  selected model supports so the feature-gating in the
   *  chat surface reflects reality. */
  capabilities?: Partial<ProviderCapabilities>;
}): AssistantProvider {
  const model = opts?.model ?? DEFAULT_MODEL;
  const capabilities: ProviderCapabilities = {
    ...BASE_CAPABILITIES,
    ...(opts?.capabilities ?? {}),
  };
  return {
    id: "ollama",
    displayName: "Ollama (local)",
    authKind: "local",
    privacyPosture: "local",
    capabilities,
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      return streamViaOllama(input, model, opts?.invoker);
    },
    onToolProposed: opts?.onToolProposed,
  };
}

async function* streamViaOllama(
  input: StreamInput,
  model: string,
  injectedInvoker?: (command: string, args: Record<string, unknown>) => Promise<unknown>,
): AsyncIterable<StreamEvent> {
  const isTauri = injectedInvoker !== undefined || isTauriContext();
  if (!isTauri) {
    yield {
      kind: "error",
      message: "Ollama provider requires a Tauri host — not available in this context",
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
      await injectedInvoker("ollama_stream", { input: commandInput, onEvent: push });
      return;
    }
    const { invoke, Channel: TauriChannel } = await import("@tauri-apps/api/core");
    const ch = new TauriChannel<WireStreamEvent>();
    ch.onmessage = push;
    try {
      await invoke("ollama_stream", { input: commandInput, onEvent: ch });
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

function translateInput(input: StreamInput, model: string): OllamaStreamCommandInput {
  const messages: OllamaMessage[] = [];
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
        const blocks: OllamaContentBlock[] = [];
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
      console.warn(`ollama stream: ${event.message}`);
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

// --- Probe --------------------------------------------------

export interface OllamaProbeResult {
  reachable: boolean;
  models: string[];
  error: string | null;
}

/** Ask Rust whether the local Ollama daemon is reachable and,
 *  if so, which models are installed. Never rejects — an
 *  unreachable daemon is a valid state (Ollama might not be
 *  running yet). */
export async function probeOllama(): Promise<OllamaProbeResult> {
  if (!isTauriContext()) {
    return { reachable: false, models: [], error: "not a Tauri host" };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<OllamaProbeResult>("ollama_probe");
}

/** Per-model capabilities discovered via Ollama's `/api/show`
 *  endpoint. `unknown: true` means we couldn't reach the
 *  daemon or the model wasn't found — settings UI should
 *  treat that as "capabilities not confirmed" and not
 *  activate advanced features. */
export interface OllamaModelCapabilities {
  tools: boolean;
  vision: boolean;
  unknown: boolean;
}

/** Ask Rust to probe a specific Ollama model. Used by the
 *  settings modal when the user picks a model in the
 *  dropdown so the provider can honestly declare `tools` /
 *  `vision` availability for that model. Never rejects. */
export async function probeOllamaModel(model: string): Promise<OllamaModelCapabilities> {
  if (!isTauriContext()) {
    return { tools: false, vision: false, unknown: true };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<OllamaModelCapabilities>("ollama_probe_model", { model });
}
