# 09 AI assistant and auth

The assistant is sprinkled in, not in charge. It is reached for explicitly and acts safely. It is built by driving the user's local Claude Agent SDK, not by reimplementing an agent loop or handling credentials.

## Integration: drive the local Agent SDK

Use the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) running locally as the harness. Constrain it for the daily-driver case with `allowedTools` and the `canUseTool` callback so it cannot wander the filesystem; widen the tool set only for the explicit agentic goal mode. Subagents (the SDK `agents` parameter) are available for the goal mode, one level deep (subagents cannot spawn subagents).

## The two auth lanes

Surface a clear choice in settings:

1. **Use my Claude subscription.** Shax drives the user's locally installed Claude (Agent SDK or Claude Code). The user authenticated it themselves; usage flows through their Agent SDK credit, then pay-as-you-go. Shax never sees or handles the credential.
2. **Use my Anthropic API key.** Standard `ANTHROPIC_API_KEY`, pay per token.

### Hard licensing rule

Never accept a Claude subscription login or token directly, never build a "Login with Claude" flow, and never read tokens out of the user's Claude config to replay them. Third-party apps may not route requests through a user's Pro or Max credentials on their behalf. The only permitted way to use a subscription is to invoke the user's own local Claude install, which handles its own auth. When in doubt, the API-key lane is always clean.

## Features (all understated, explicit by default)

- **Natural-language-to-command:** the user asks in words; the assistant proposes a command they can edit and run.
- **Explain-on-error:** attached to a failed block, on demand. Ambient auto-explain is opt-in, off by default.
- **Agentic goal mode (optional):** give a goal, the assistant proposes a plan of commands and runs them behind approval gates, optionally using subagents, optionally in its own pane (`04`).
- **Memory:** the assistant reads the search index (`05`) as its long-term memory, so "why did this fail" reads real history rather than guessing.

## Invocation

Explicit by default: a keybind or a prompt prefix. The assistant does not interrupt. The daily-driver feel comes first.

## Everything routes through the gate

Any command the assistant would run, like any widget action, passes through the permission and approval gate in `10`. There is no bypass for "trusted" agent actions. The assistant acts through visible commands, consistent with the honest-log principle.

## Constraints to respect

- Keep the inline assistant lightweight by restricting tools; do not run the full file-editing harness for a simple natural-language-to-command.
- The assistant is a feature of the terminal, not a separate product surface. No separate sub-brand.
