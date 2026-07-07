/**
 * Feature declarations + capability gating (M6 slice 4).
 *
 * Spec §09 mandates a **feature availability table** driven
 * by the active provider's declared capabilities. Rather
 * than hard-coding "grey out this button if Ollama is
 * selected", every assistant feature declares which
 * capability it needs and the chat surface consults this
 * module.
 *
 * For slice 4 the concrete features are minimal — text
 * conversation works everywhere; tools / goal mode / image
 * input are deferred. Even so, wiring the mechanism now
 * means slice 5+ can enable a feature by flipping one flag
 * and get "strict" capability gating (dim + tooltip) for
 * free.
 */

import type { ProviderCapabilities } from "./provider";

/** Machine identifiers for user-facing features. */
export type FeatureId = "tools" | "goal-mode" | "image-input";

export interface Feature {
  id: FeatureId;
  /** Short label used in the capability strip below the
   *  chat input. Kept terse — this is a badge, not a
   *  paragraph. */
  label: string;
  /** Which provider capability the feature depends on. */
  requires: keyof ProviderCapabilities;
  /** Explanation shown as a tooltip when the feature is
   *  unavailable with the active provider. Follows the
   *  "requires X" pattern from spec §09. */
  unavailableTooltip: string;
}

/** Registry of features the chat surface knows about. Add
 *  new features here — the capability strip picks them up
 *  automatically. */
export const FEATURES: readonly Feature[] = [
  {
    id: "tools",
    label: "tools",
    requires: "tools",
    unavailableTooltip:
      "This provider doesn't support tool-calling. Natural-language-to-command and other agentic features are dimmed.",
  },
  {
    id: "goal-mode",
    label: "goal mode",
    requires: "subagents",
    unavailableTooltip: "This provider doesn't support subagents. Goal mode is unavailable.",
  },
  {
    id: "image-input",
    label: "images",
    requires: "imageInput",
    unavailableTooltip: "This provider doesn't accept image input.",
  },
];

/** True iff the feature is available with the given
 *  capabilities. */
export function featureAvailable(feature: Feature, caps: ProviderCapabilities): boolean {
  return caps[feature.requires] === true;
}
