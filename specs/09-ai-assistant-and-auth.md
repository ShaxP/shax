# 09 AI assistant and auth

The assistant is sprinkled in, not in charge. It is reached for explicitly and acts safely. Shax orchestrates it through a **pluggable provider interface**: the assistant surface is one thing, the AI backend behind it is another, and the two are joined by a capability-based boundary. Users bring the model of their choice. Local models are treated as first-class citizens, not fallbacks.

## The assistant is a feature, the provider is a backend

The user-visible surface (invocation, streamed responses, tool proposals, approval-gate flow, feature set) is provider-agnostic. Whether the user picks Claude, a local Ollama model, or a future community adapter, the terminal feels the same. What differs is *which features are available*, driven by declared provider capabilities.

This positioning is deliberate: Shax is a terminal with a pluggable assistant, first shipped with Claude and Ollama. It is not a Claude client.

## The provider interface

Every backend implements a common `AssistantProvider` interface:

```ts
interface AssistantProvider {
  id: string;                       // "claude" | "ollama" | ...
  displayName: string;
  authKind: "local" | "api-key" | "subscription-delegate";
  privacyPosture: "local" | "cloud";
  capabilities: {
    tools: boolean;                 // structured tool calls
    subagents: boolean;             // constrained sub-loops
    streaming: boolean;
    imageInput: boolean;
    contextWindow: number;          // in tokens (best-effort)
  };
  stream(input: StreamInput): AsyncIterable<StreamEvent>;
  // Called before the provider would run a tool. Delegates
  // to the same safety gate widgets use (§10). Providers do
  // NOT get to bypass this — it is a hard security invariant.
  onToolProposed?(call: ToolCall): Promise<ToolVerdict>;
}
```

The concrete providers listed below are all shipped as first-party implementations of this interface. Community-authored providers plug into the same interface via a sandboxed adapter (see "Community providers", below).

## Feature availability degrades gracefully

Not every provider supports every capability. Rather than pretend they are equivalent, features are gated on declared capabilities and the UI reflects reality:

| Feature | Requires |
|---|---|
| Explain-on-error, natural-language chat | none — any provider |
| Natural-language-to-command | `tools` |
| Agentic goal mode | `tools` and `subagents` |
| Attached image analysis | `imageInput` |

When a user picks a provider without a required capability, the affected feature dims with a short hint (for example, "Requires tool-calling — not available with this provider"). No mystery about why a feature is missing.

## Tool schema

Tools are defined once, in the shape of **Anthropic's tool-use schema**. That schema is the cleanest currently available and maps directly to the Claude Agent SDK. Each non-Anthropic provider ships a translation layer that maps the internal schema into its own format on the way out (and its tool-use events into the internal event shape on the way back in). Providers that don't support tool calls skip the translation entirely.

This keeps tool definitions single-sourced, keeps Claude fast-path (no translation), and lets non-Claude providers evolve without touching the tool set.

## Local-first is a first-class label

Providers declare a `privacyPosture` — `"local"` when no data leaves the machine, `"cloud"` otherwise. The settings surface displays this prominently, not as a footnote:

```
● Claude (Anthropic API)     ☁ cloud
○ Ollama                     ⌂ local — nothing leaves your machine
○ OpenAI                     ☁ cloud     (coming)
○ GitHub Copilot             ☁ cloud     (coming)
○ MLX (Apple Silicon)        ⌂ local     (coming)
○ Off
```

Users optimising for privacy or offline use can see the local providers immediately. This alignment with §10's local-first stance is intentional.

## First-party provider list

Shipped with M6:

1. **Claude** — via the local Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). Full capabilities (tools, subagents, streaming, image input). Two auth lanes, see below.
2. **Ollama** — talks HTTP to a locally running Ollama daemon. Capabilities: streaming; tools and subagents are model-dependent and probed at connect time. Zero auth (local socket). Privacy posture: local.

Planned next (M6.5 or M7):

3. **OpenAI** — via the OpenAI SDK. Capabilities: tools, streaming, image input on capable models. Auth: API key.
4. **GitHub Copilot** — via the Copilot API surface. Auth: OAuth device flow through the user's GitHub account, no long-lived token handled by Shax. Capability set to be confirmed against the current Copilot API.
5. **MLX** — local, Apple Silicon only, via the MLX runtime. Privacy posture: local. Capability set model-dependent.

Community providers come after those, via the sandbox pattern (see below).

## Auth lanes

Each provider declares an `authKind`. The settings UI adapts per lane:

- **`local`** (Ollama, MLX): no credential. Shax probes for the daemon or runtime on start. If missing, settings shows an install hint.
- **`api-key`** (OpenAI, and the Anthropic-direct Claude lane): the user pastes a key into settings, stored in the OS keychain via Tauri's Stronghold plugin. Never persisted in plain settings JSON. Never logged. Read from keychain into the provider's transport at request time.
- **`subscription-delegate`** (the Claude subscription lane, and the GitHub Copilot lane): Shax invokes the user's own locally-installed vendor tooling (Claude Code / Agent SDK for Claude; the Copilot device flow that returns to a Copilot-managed session for GitHub). Shax never sees the underlying credential. See "Hard licensing rule" below for why this shape is the only permitted one for delegated subscriptions.

### The two Claude lanes

For Claude specifically, users may choose:

1. **Use my Claude subscription.** Shax drives the locally installed Claude Agent SDK / Claude Code. The user authenticated that install themselves; usage flows through their SDK credit, then pay-as-you-go. Shax never sees or handles the credential.
2. **Use my Anthropic API key.** Standard `ANTHROPIC_API_KEY`. Pay per token. Stored in the OS keychain.

### Hard licensing rule (Claude subscriptions)

Never accept a Claude subscription login or token directly, never build a "Login with Claude" flow, and never read tokens out of the user's Claude config to replay them. Third-party apps may not route requests through a user's Pro or Max credentials on their behalf. The only permitted way to use a subscription is to invoke the user's own local Claude install, which handles its own auth. When in doubt, the API-key lane is always clean.

The same principle applies to any other provider whose terms forbid third-party proxying of a subscription. If a subscription cannot be delegated to a local install, ship only the API-key lane for that provider.

## Features (all understated, explicit by default)

- **Natural-language-to-command:** the user asks in words; the assistant proposes a command they can edit and run.
- **Explain-on-error:** attached to a failed block, on demand. Ambient auto-explain is opt-in, off by default.
- **Agentic goal mode (optional):** give a goal, the assistant proposes a plan of commands and runs them behind approval gates, optionally using subagents, optionally in its own pane (`04`). Available only when the selected provider declares `tools` and `subagents`.
- **Memory:** the assistant reads the search index (`05`) as its long-term memory, so "why did this fail" reads real history rather than guessing.

## Invocation

Explicit by default: a keybind or a prompt prefix. The assistant does not interrupt. The daily-driver feel comes first.

## Everything routes through the gate

Every command the assistant would run — from any provider — passes through the permission and approval gate in `10`. There is no bypass for "trusted" agent actions and no provider-specific escape hatch. The provider's `onToolProposed` hook delegates to the same gate that widgets use. The assistant acts through visible commands, consistent with the honest-log principle.

## Community providers

A community provider is a shell adapter that implements the same `AssistantProvider` interface, delivered via the sandbox pattern used for community formatters (`07`) and community pane commands (`14`):

- Runs in a worker isolate. No ambient filesystem or network access.
- Manifest declares the network endpoints the adapter needs. Requests to any other host are refused by the sandbox.
- Communicates with the assistant surface via message passing on the interface above.
- Cannot bypass the approval gate. Cannot handle Claude subscription credentials (the hard licensing rule applies to community code too).

Community providers are deferred until after the first-party set is stable; they are not part of M6. The trust envelope mirrors formatters — the only way an extension can "do" anything is to *propose* messages or tool calls that the user's approval gate then sees.

## Constraints to respect

- Keep the inline assistant lightweight by restricting tools; do not run the full file-editing harness for a simple natural-language-to-command.
- The assistant is a feature of the terminal, not a separate product surface. No separate sub-brand.
- Do not silently degrade features based on provider — surface the gap so the user understands which provider gives them which features.
- Do not weaken the gate, the sandbox, or the credential rules to make a provider integration easier. If a provider seems to require it, that is a design problem to escalate, not a rule to bend.
