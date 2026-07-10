/**
 * Provider factory — chooses the right `AssistantProvider`
 * for the user's current settings (M6 slice 4).
 *
 * The chat surface calls `providerFromConfig(config)` on
 * open (and whenever the config changes) to get a live
 * provider or `null` when nothing is configured.
 *
 * Keeping this in one place means:
 *   - The chat surface doesn't need to know which lane is
 *     active, only that a provider exists (or doesn't).
 *   - Future providers (OpenAI, Copilot, MLX, community) plug
 *     in by adding one branch here.
 *   - Feature-gating (`features.ts`) reads the provider's
 *     capabilities the same way regardless of which factory
 *     produced it.
 */

import type { AssistantConfig } from "../settings/config";
import { createClaudeApiKeyProvider } from "./providers/claude/apiKey";
import { createClaudeSubscriptionProvider } from "./providers/claude/subscription";
import { createOllamaProvider } from "./providers/ollama/ollama";
import type { AssistantProvider } from "./provider";

/** Reason a config resolves to `null` — used by the chat
 *  surface to show the right "not configured" message. */
export type NotConfiguredReason =
  | { kind: "no-provider"; hint: string }
  | { kind: "no-lane"; hint: string }
  | { kind: "no-model"; hint: string };

export interface ProviderResolution {
  provider: AssistantProvider | null;
  reason: NotConfiguredReason | null;
}

/** Given the persisted `AssistantConfig`, return a live
 *  provider *or* a structured reason it can't be built. The
 *  reason keeps error messages honest — "you haven't picked
 *  a model" is different from "no provider selected." */
export function providerFromConfig(config: AssistantConfig): ProviderResolution {
  if (config.provider === "claude") {
    if (config.claude_lane === "none") {
      return {
        provider: null,
        reason: {
          kind: "no-lane",
          hint: "Pick an API-key or subscription lane in Settings (⌘,).",
        },
      };
    }
    if (config.claude_lane === "api-key") {
      return {
        provider: createClaudeApiKeyProvider({
          model: config.claude_model ?? undefined,
        }),
        reason: null,
      };
    }
    if (config.claude_lane === "subscription") {
      return {
        provider: createClaudeSubscriptionProvider({
          model: config.claude_model ?? undefined,
        }),
        reason: null,
      };
    }
  }
  if (config.provider === "ollama") {
    if (config.ollama_model === null || config.ollama_model.length === 0) {
      return {
        provider: null,
        reason: {
          kind: "no-model",
          hint: "Pick an Ollama model in Settings (⌘,).",
        },
      };
    }
    // Cached per-model capabilities from `probeOllamaModel` in
    // the settings modal. Absent = we haven't probed → stay
    // conservative (tools/vision off) so the chat surface's
    // capability gating doesn't lie.
    const ollamaCaps = config.ollama_capabilities;
    return {
      provider: createOllamaProvider({
        model: config.ollama_model,
        capabilities:
          ollamaCaps === null
            ? undefined
            : { tools: ollamaCaps.tools, imageInput: ollamaCaps.vision },
      }),
      reason: null,
    };
  }
  return {
    provider: null,
    reason: {
      kind: "no-provider",
      hint: "Choose a provider in Settings (⌘,).",
    },
  };
}
