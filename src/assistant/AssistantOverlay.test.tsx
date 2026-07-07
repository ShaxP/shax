import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { AssistantOverlay } from "./AssistantOverlay";
import type { StreamEvent } from "./provider";

// Mock the settings config loader — we don't want a real
// Tauri call in tests.
vi.mock("../settings/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings/config")>();
  return {
    ...actual,
    getAssistantConfig: vi.fn(),
  };
});

// Mock the provider factory so we can inject a controllable
// stream from tests. `providerFromConfig` is called from
// inside the overlay's useMemo — the mock lets us return a
// stub provider straight away.
vi.mock("./providerFactory", () => {
  return {
    providerFromConfig: vi.fn(),
  };
});

import { getAssistantConfig, type AssistantConfig } from "../settings/config";
import { providerFromConfig } from "./providerFactory";

const NOOP = (): void => {};

function stubProvider(events: StreamEvent[]) {
  const stream = vi.fn().mockImplementation(function* (): Generator<StreamEvent> {
    for (const e of events) yield e;
  });
  return {
    id: "claude",
    displayName: "Claude (test)",
    authKind: "api-key" as const,
    privacyPosture: "cloud" as const,
    capabilities: {
      tools: true,
      subagents: true,
      streaming: true,
      imageInput: true,
      contextWindow: 200_000,
    },
    stream,
  };
}

function stubOllamaProvider() {
  return {
    id: "ollama",
    displayName: "Ollama (local)",
    authKind: "local" as const,
    privacyPosture: "local" as const,
    capabilities: {
      tools: false,
      subagents: false,
      streaming: true,
      imageInput: false,
      contextWindow: 8192,
    },
    stream: vi.fn(),
  };
}

const BASE_CONFIG: AssistantConfig = {
  provider: "claude",
  claude_lane: "api-key",
  claude_model: "claude-sonnet-4-6",
  ollama_model: null,
};

function mockNotConfigured(): void {
  vi.mocked(getAssistantConfig).mockResolvedValue({ ...BASE_CONFIG, provider: "" });
  vi.mocked(providerFromConfig).mockReturnValue({
    provider: null,
    reason: { kind: "no-provider", hint: "Choose a provider in Settings (⌘,)." },
  });
}

function mockClaudeProvider(events: StreamEvent[]) {
  vi.mocked(getAssistantConfig).mockResolvedValue(BASE_CONFIG);
  const provider = stubProvider(events);
  vi.mocked(providerFromConfig).mockReturnValue({ provider, reason: null });
  return provider;
}

describe("AssistantOverlay", () => {
  it("shows a not-configured state when no provider resolves", async () => {
    mockNotConfigured();
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("No provider configured")).toBeInTheDocument();
    });
    expect(screen.getByText("Choose a provider in Settings (⌘,).")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-overlay-open-settings")).toBeInTheDocument();
  });

  it("streams a user + assistant round trip", async () => {
    mockClaudeProvider([
      { kind: "text", delta: "Hello " },
      { kind: "text", delta: "there" },
      { kind: "done", stopReason: "end_turn" },
    ]);
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
      />,
    );
    // Provider available → input renders.
    const input = await screen.findByTestId("assistant-overlay-input");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const userBubbles = screen.getAllByTestId("assistant-overlay-turn-user");
      expect(userBubbles).toHaveLength(1);
      expect(userBubbles[0]).toHaveTextContent("hi");
    });
    await waitFor(() => {
      const assistantBubbles = screen.getAllByTestId("assistant-overlay-turn-assistant");
      expect(assistantBubbles[0]).toHaveTextContent("Hello there");
    });
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    mockClaudeProvider([{ kind: "done", stopReason: "end_turn" }]);
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
      />,
    );
    const input = await screen.findByTestId("assistant-overlay-input");
    fireEvent.change(input, { target: { value: "line 1" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    // No user turn appeared — Shift+Enter shouldn't send.
    expect(screen.queryAllByTestId("assistant-overlay-turn-user")).toHaveLength(0);
  });

  it("auto-sends a seeded prompt and calls onSeedConsumed", async () => {
    const seedConsumed = vi.fn();
    mockClaudeProvider([
      { kind: "text", delta: "Because you forgot -a" },
      { kind: "done", stopReason: "end_turn" },
    ]);
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt="Explain: git status --unknownflag"
        onSeedConsumed={seedConsumed}
        onOpenSettings={NOOP}
      />,
    );
    await waitFor(() => {
      const userBubbles = screen.getAllByTestId("assistant-overlay-turn-user");
      expect(userBubbles[0]).toHaveTextContent("Explain: git status --unknownflag");
    });
    expect(seedConsumed).toHaveBeenCalled();
    await waitFor(() => {
      const assistantBubbles = screen.getAllByTestId("assistant-overlay-turn-assistant");
      expect(assistantBubbles[0]).toHaveTextContent("Because you forgot -a");
    });
  });

  it("renders capability strip with strict dim-and-tooltip gating", async () => {
    vi.mocked(getAssistantConfig).mockResolvedValue({
      ...BASE_CONFIG,
      provider: "ollama",
      ollama_model: "llama3.1",
    });
    const provider = stubOllamaProvider();
    vi.mocked(providerFromConfig).mockReturnValue({ provider, reason: null });
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("assistant-overlay-capabilities")).toBeInTheDocument(),
    );
    // Ollama declares tools/subagents/imageInput = false; the
    // badges get data-available="false".
    expect(screen.getByTestId("assistant-overlay-cap-tools")).toHaveAttribute(
      "data-available",
      "false",
    );
    expect(screen.getByTestId("assistant-overlay-cap-goal-mode")).toHaveAttribute(
      "data-available",
      "false",
    );
    expect(screen.getByTestId("assistant-overlay-cap-image-input")).toHaveAttribute(
      "data-available",
      "false",
    );
  });

  it("shows the ⌂ local posture badge for local providers", async () => {
    vi.mocked(getAssistantConfig).mockResolvedValue({
      ...BASE_CONFIG,
      provider: "ollama",
      ollama_model: "llama3.1",
    });
    vi.mocked(providerFromConfig).mockReturnValue({
      provider: stubOllamaProvider(),
      reason: null,
    });
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
      />,
    );
    const badge = await screen.findByTestId("assistant-overlay-posture");
    expect(badge).toHaveTextContent("local");
  });

  it("Escape closes via onClose", async () => {
    const onClose = vi.fn();
    mockClaudeProvider([]);
    render(
      <AssistantOverlay
        onClose={onClose}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
      />,
    );
    await screen.findByTestId("assistant-overlay-input");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
