import { describe, expect, it } from "vitest";
import { FEATURES, featureAvailable } from "./features";
import type { ProviderCapabilities } from "./provider";

const FULL: ProviderCapabilities = {
  tools: true,
  subagents: true,
  streaming: true,
  imageInput: true,
  contextWindow: 200_000,
};

const NONE: ProviderCapabilities = {
  tools: false,
  subagents: false,
  streaming: false,
  imageInput: false,
  contextWindow: 8192,
};

describe("featureAvailable", () => {
  it("returns true for every declared feature when caps are full", () => {
    for (const f of FEATURES) {
      expect(featureAvailable(f, FULL)).toBe(true);
    }
  });

  it("returns false for every declared feature when caps are empty", () => {
    for (const f of FEATURES) {
      expect(featureAvailable(f, NONE)).toBe(false);
    }
  });

  it("returns true only for tools when only tools is declared", () => {
    const caps: ProviderCapabilities = { ...NONE, tools: true };
    const results = FEATURES.map((f) => ({ id: f.id, ok: featureAvailable(f, caps) }));
    expect(results.find((r) => r.id === "tools")?.ok).toBe(true);
    expect(results.find((r) => r.id === "goal-mode")?.ok).toBe(false);
    expect(results.find((r) => r.id === "image-input")?.ok).toBe(false);
  });

  it("goal-mode requires subagents specifically, not just tools", () => {
    const tools_only: ProviderCapabilities = { ...NONE, tools: true, subagents: false };
    const goalMode = FEATURES.find((f) => f.id === "goal-mode");
    if (goalMode === undefined) throw new Error("goal-mode feature missing");
    expect(featureAvailable(goalMode, tools_only)).toBe(false);
  });
});
