/**
 * The `AssistantProvider` interface (M6 slice 1, spec §09).
 *
 * The boundary between the assistant surface and the AI
 * backend. Types-only in this slice — no concrete providers
 * are wired yet (Claude arrives in slice 2, Ollama in
 * slice 3). Defined now so the safety gate's event shape,
 * the settings scaffolding, and future provider PRs all
 * agree on what a provider looks like.
 *
 * Every provider funnels tool proposals through the same
 * `SafetyGate` widgets use. `onToolProposed` is the delegation
 * hook — a hard invariant, no bypass.
 */

/** Machine identifier — stable, kebab-case. Used in settings
 *  storage and event `source` tagging. */
export type ProviderId = string;

/** Human-readable label surfaced in the settings dropdown. */
export type ProviderDisplayName = string;

/** How the provider authenticates.
 *
 *   - `local`: no credential (Ollama, MLX).
 *   - `api-key`: user pastes a key, stored in the OS
 *     keychain via Stronghold, never persisted plain.
 *   - `subscription-delegate`: Shax invokes the user's own
 *     locally-installed vendor tooling; Shax never sees the
 *     credential (Claude subscription lane, GitHub Copilot).
 *     The **hard licensing rule** applies — see §09.
 */
export type AuthKind = "local" | "api-key" | "subscription-delegate";

/** First-class label surfaced prominently in the settings UI
 *  (spec §09). Never inferred from `authKind` alone — a
 *  provider may declare `local` explicitly even if it uses
 *  an API key (unusual, but possible for on-prem endpoints). */
export type PrivacyPosture = "local" | "cloud";

/** Capabilities a provider claims to support. Feature
 *  availability is gated on these; when a capability is
 *  false the corresponding assistant feature is dimmed with
 *  a "requires X" hint. */
export interface ProviderCapabilities {
  /** Structured tool calls (Anthropic-style). Required for
   *  natural-language-to-command and goal mode. */
  tools: boolean;
  /** Provider can spawn constrained sub-loops. Required for
   *  agentic goal mode. */
  subagents: boolean;
  /** Response streaming. When false the UI shows a spinner
   *  until the full response arrives. */
  streaming: boolean;
  /** Multimodal input. */
  imageInput: boolean;
  /** Context window in tokens (best-effort — providers vary
   *  by model). */
  contextWindow: number;
}

/** One turn in the conversation. Message roles mirror
 *  Anthropic's — this is the internal shape and the source
 *  of truth (spec §09 "tools defined once in Anthropic's
 *  tool-use schema"). */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** A tool the provider may call. Internal shape follows
 *  Anthropic's; non-Claude providers translate outbound. */
export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A structured tool call the provider is proposing to
 *  execute. Passes through `SafetyGate` via
 *  `onToolProposed`; only forwarded to the tool
 *  implementation on approval. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** The gate's verdict on a proposed tool call. Providers
 *  MUST respect the response — an `approve` verdict permits
 *  the run, `decline` drops it, `edit` runs the (edited)
 *  input instead. `edit` is for future slice UX and not
 *  required to be implemented by every provider. */
export type ToolVerdict =
  | { kind: "approve" }
  | { kind: "decline" }
  | { kind: "edit"; input: unknown };

/** Input to `stream()`. */
export interface StreamInput {
  messages: Message[];
  tools?: Tool[];
  /** Optional per-request override; providers may cap
   *  according to their model's max output. */
  maxOutputTokens?: number;
  /** Signal for cancellation. Provider must abort in-flight
   *  requests when this fires. */
  signal?: AbortSignal;
}

/** Events streamed back by `stream()`. Callers assemble the
 *  final response by consuming the async iterable. */
export type StreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "tool_verdict"; callId: string; verdict: ToolVerdict }
  | { kind: "error"; message: string }
  | { kind: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" };

/** The interface every provider (first-party or community)
 *  implements. */
export interface AssistantProvider {
  id: ProviderId;
  displayName: ProviderDisplayName;
  authKind: AuthKind;
  privacyPosture: PrivacyPosture;
  capabilities: ProviderCapabilities;

  /** Send messages, get a stream of events. */
  stream(input: StreamInput): AsyncIterable<StreamEvent>;

  /** Called before the provider would execute a tool. The
   *  default implementation (in the assistant runtime, not
   *  the provider) delegates to `SafetyGate`. Providers must
   *  not bypass this — spec §10 hard invariant. Optional so
   *  chat-only providers (no `tools` capability) don't need
   *  to implement it. */
  onToolProposed?(call: ToolCall): Promise<ToolVerdict>;
}
