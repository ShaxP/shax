import { describe, expect, it } from "vitest";
import { providerFromConfig } from "./providerFactory";
import type { AssistantConfig } from "../settings/config";

const BASE: AssistantConfig = {
  provider: "",
  claude_lane: "none",
  claude_model: null,
  ollama_model: null,
};

describe("providerFromConfig", () => {
  it("returns no-provider when nothing is configured", () => {
    const res = providerFromConfig(BASE);
    expect(res.provider).toBeNull();
    expect(res.reason?.kind).toBe("no-provider");
  });

  it("returns no-lane when Claude is selected but no lane picked", () => {
    const res = providerFromConfig({ ...BASE, provider: "claude", claude_lane: "none" });
    expect(res.provider).toBeNull();
    expect(res.reason?.kind).toBe("no-lane");
  });

  it("builds the API-key provider when Claude + api-key is picked", () => {
    const res = providerFromConfig({
      ...BASE,
      provider: "claude",
      claude_lane: "api-key",
      claude_model: "claude-sonnet-4-6",
    });
    expect(res.reason).toBeNull();
    expect(res.provider?.id).toBe("claude");
    expect(res.provider?.authKind).toBe("api-key");
    expect(res.provider?.privacyPosture).toBe("cloud");
  });

  it("builds the subscription provider when Claude + subscription is picked", () => {
    const res = providerFromConfig({
      ...BASE,
      provider: "claude",
      claude_lane: "subscription",
    });
    expect(res.reason).toBeNull();
    expect(res.provider?.id).toBe("claude");
    expect(res.provider?.authKind).toBe("subscription-delegate");
  });

  it("returns no-model when Ollama is selected but no model picked", () => {
    const res = providerFromConfig({ ...BASE, provider: "ollama", ollama_model: null });
    expect(res.provider).toBeNull();
    expect(res.reason?.kind).toBe("no-model");
  });

  it("returns no-model when Ollama is selected with an empty model string", () => {
    const res = providerFromConfig({ ...BASE, provider: "ollama", ollama_model: "" });
    expect(res.provider).toBeNull();
    expect(res.reason?.kind).toBe("no-model");
  });

  it("builds the Ollama provider with the picked model", () => {
    const res = providerFromConfig({
      ...BASE,
      provider: "ollama",
      ollama_model: "llama3.1",
    });
    expect(res.reason).toBeNull();
    expect(res.provider?.id).toBe("ollama");
    expect(res.provider?.authKind).toBe("local");
    expect(res.provider?.privacyPosture).toBe("local");
  });
});
