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

// Mock chat history persistence. Default: empty history +
// no-op save/clear so existing tests that don't care about
// history keep passing.
vi.mock("./history", () => ({
  loadChatHistory: vi.fn().mockResolvedValue({ turns: [] }),
  saveChatHistory: vi.fn().mockResolvedValue(undefined),
  clearChatHistory: vi.fn().mockResolvedValue(undefined),
}));

import { getAssistantConfig, type AssistantConfig } from "../settings/config";
import { clearChatHistory, loadChatHistory, saveChatHistory } from "./history";
import { providerFromConfig } from "./providerFactory";

const NOOP = (): void => {};

function stubProvider(eventsOrSequences: StreamEvent[] | StreamEvent[][]) {
  // Accept either a single flat event list (single-turn
  // tests) or a nested array where each inner array is one
  // stream() iteration (multi-turn tool loop tests).
  const sequences: StreamEvent[][] = Array.isArray(eventsOrSequences[0])
    ? (eventsOrSequences as StreamEvent[][])
    : [eventsOrSequences as StreamEvent[]];
  let callIndex = 0;
  const stream = vi.fn().mockImplementation(function* (): Generator<StreamEvent> {
    const events = sequences[callIndex] ?? sequences[sequences.length - 1] ?? [];
    callIndex++;
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
  ollama_capabilities: null,
};

function mockNotConfigured(): void {
  vi.mocked(getAssistantConfig).mockResolvedValue({ ...BASE_CONFIG, provider: "" });
  vi.mocked(providerFromConfig).mockReturnValue({
    provider: null,
    reason: { kind: "no-provider", hint: "Choose a provider in Settings (⌘,)." },
  });
}

function mockClaudeProvider(events: StreamEvent[] | StreamEvent[][]) {
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
        targetPtyId={null}
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
        targetPtyId={null}
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
        targetPtyId={null}
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
        targetPtyId={null}
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
        targetPtyId={null}
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

  it("shows the local privacy strip for local providers (M7.7b)", async () => {
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
        targetPtyId={null}
      />,
    );
    // Header pill carries the provider name (ollama / claude); the
    // posture line moved to the bottom-of-input privacy strip.
    const provider = await screen.findByTestId("assistant-overlay-provider");
    expect(provider).toHaveTextContent(/ollama/i);
    const privacy = await screen.findByTestId("assistant-overlay-privacy");
    expect(privacy).toHaveAttribute("data-posture", "local");
    expect(privacy).toHaveTextContent(/nothing leaves this machine/i);
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
        targetPtyId={null}
      />,
    );
    await screen.findByTestId("assistant-overlay-input");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("restores persisted turns on mount", async () => {
    vi.mocked(loadChatHistory).mockResolvedValueOnce({
      turns: [
        { role: "user", content: "prior question", created_ms: 1 },
        { role: "assistant", content: "prior answer", created_ms: 2 },
      ],
    });
    mockClaudeProvider([]);
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    await waitFor(() => {
      const userBubbles = screen.getAllByTestId("assistant-overlay-turn-user");
      expect(userBubbles[0]).toHaveTextContent("prior question");
      const assistantBubbles = screen.getAllByTestId("assistant-overlay-turn-assistant");
      expect(assistantBubbles[0]).toHaveTextContent("prior answer");
    });
  });

  it("saves history after each completed turn", async () => {
    const saveSpy = vi.mocked(saveChatHistory);
    saveSpy.mockClear();
    mockClaudeProvider([
      { kind: "text", delta: "Hi back" },
      { kind: "done", stopReason: "end_turn" },
    ]);
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    const input = await screen.findByTestId("assistant-overlay-input");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalled();
    });
    // Last save should contain both turns.
    const lastCall = saveSpy.mock.calls[saveSpy.mock.calls.length - 1];
    const saved = lastCall?.[0]?.turns ?? [];
    expect(saved).toHaveLength(2);
    expect(saved[0]?.role).toBe("user");
    expect(saved[0]?.content).toBe("hi");
    expect(saved[1]?.role).toBe("assistant");
    expect(saved[1]?.content).toBe("Hi back");
  });

  it("New button clears turns and calls clearChatHistory", async () => {
    vi.mocked(loadChatHistory).mockResolvedValueOnce({
      turns: [{ role: "user", content: "old", created_ms: 1 }],
    });
    const clearSpy = vi.mocked(clearChatHistory);
    clearSpy.mockClear();
    mockClaudeProvider([]);
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    // Wait for restore.
    await waitFor(() => expect(screen.getByTestId("assistant-overlay-new")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("assistant-overlay-new"));
    await waitFor(() => {
      expect(screen.queryAllByTestId("assistant-overlay-turn-user")).toHaveLength(0);
    });
    expect(clearSpy).toHaveBeenCalled();
  });

  it("hides the New button when there are no turns", async () => {
    mockClaudeProvider([]);
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    await screen.findByTestId("assistant-overlay-input");
    expect(screen.queryByTestId("assistant-overlay-new")).not.toBeInTheDocument();
  });

  it("renders a tool_proposal bubble when the provider emits a tool_call", async () => {
    // Provider streams a tool_call then done — with no
    // targetPtyId, `executeToolCall` short-circuits to a
    // structured "no pane" result so the loop terminates
    // deterministically without waiting for a real block.
    mockClaudeProvider([
      // First stream() iteration — model proposes a tool.
      [
        {
          kind: "tool_call",
          call: {
            id: "toolu_1",
            name: "run_command",
            input: { command: "git status", reason: "check the working tree" },
          },
        },
        { kind: "done", stopReason: "tool_use" },
      ],
      // Second iteration — after the tool result, model
      // gives its final answer.
      [
        { kind: "text", delta: "All clean." },
        { kind: "done", stopReason: "end_turn" },
      ],
    ]);
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    const input = await screen.findByTestId("assistant-overlay-input");
    fireEvent.change(input, { target: { value: "check the repo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const proposals = screen.getAllByTestId("assistant-overlay-turn-tool_proposal");
      expect(proposals[0]).toHaveTextContent("git status");
      expect(proposals[0]).toHaveTextContent("check the working tree");
    });
    // Tool result bubble also renders — with no pane, the
    // structured "no active terminal pane" message flows
    // back and is shown.
    await waitFor(() => {
      const results = screen.getAllByTestId("assistant-overlay-turn-tool_result");
      expect(results[0]).toHaveTextContent("No active terminal pane");
    });
    // Final assistant text arrives after the tool round-trip.
    await waitFor(() => {
      const bubbles = screen.getAllByTestId("assistant-overlay-turn-assistant");
      expect(bubbles[bubbles.length - 1]).toHaveTextContent("All clean.");
    });
  });
});

describe("AssistantOverlay / M7.7b header + footer", () => {
  it("renders the Shax mark, the provider pill, and the close button", async () => {
    vi.mocked(getAssistantConfig).mockResolvedValue(BASE_CONFIG);
    vi.mocked(providerFromConfig).mockReturnValue({
      provider: stubProvider([]),
      reason: null,
    });
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    // Mark visible; provider pill carries the display name; close
    // button exposes an aria-label so it's tappable.
    expect(await screen.findByTestId("assistant-overlay-mark")).toHaveTextContent(/shax/i);
    expect(await screen.findByTestId("assistant-overlay-provider")).toHaveTextContent(/claude/i);
    expect(await screen.findByTestId("assistant-overlay-close")).toHaveAttribute(
      "aria-label",
      "Close assistant",
    );
  });

  it("shows the goal-mode stub button (disabled) in the input footer", async () => {
    vi.mocked(getAssistantConfig).mockResolvedValue(BASE_CONFIG);
    vi.mocked(providerFromConfig).mockReturnValue({
      provider: stubProvider([]),
      reason: null,
    });
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    const goal = await screen.findByTestId("assistant-overlay-goal-mode");
    expect(goal).toBeDisabled();
    expect(goal).toHaveTextContent(/goal mode/i);
  });

  it("input placeholder matches the design copy", async () => {
    vi.mocked(getAssistantConfig).mockResolvedValue(BASE_CONFIG);
    vi.mocked(providerFromConfig).mockReturnValue({
      provider: stubProvider([]),
      reason: null,
    });
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    expect(await screen.findByTestId("assistant-overlay-input")).toHaveAttribute(
      "placeholder",
      "Ask Shax, or describe a command…",
    );
  });

  it("assistant replies get a '✦ Shax' author label; user replies do not (M7.7b design pass 2)", async () => {
    vi.mocked(getAssistantConfig).mockResolvedValue(BASE_CONFIG);
    vi.mocked(providerFromConfig).mockReturnValue({
      provider: stubProvider([
        { kind: "text", delta: "Hello from Shax." },
        { kind: "done", stopReason: "end_turn" },
      ]),
      reason: null,
    });
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    // Send a user turn to trigger an assistant reply.
    const input = await screen.findByTestId("assistant-overlay-input");
    fireEvent.change(input, { target: { value: "hey" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Assistant turn arrives → its bubble carries the author label.
    await waitFor(() => {
      const author = screen.getByTestId("assistant-overlay-author");
      expect(author).toHaveTextContent(/shax/i);
      // The star glyph is a `<span aria-hidden>` child; check that
      // the ✦ character is present in the label.
      expect(author.textContent).toContain("✦");
    });
    // The user turn does NOT get an author label — there's exactly
    // one label element (on the assistant turn only).
    expect(screen.getAllByTestId("assistant-overlay-author")).toHaveLength(1);
  });

  it("privacy strip surfaces cloud posture for API-key Claude", async () => {
    vi.mocked(getAssistantConfig).mockResolvedValue(BASE_CONFIG);
    vi.mocked(providerFromConfig).mockReturnValue({
      provider: stubProvider([]),
      reason: null,
    });
    render(
      <AssistantOverlay
        onClose={NOOP}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    const privacy = await screen.findByTestId("assistant-overlay-privacy");
    expect(privacy).toHaveAttribute("data-posture", "cloud");
    expect(privacy).toHaveTextContent(/prompts leave your machine/i);
  });

  // M7.7c — regression: a parent re-render (which changes `onClose`'s
  // reference every time) must NOT steal focus back from the textarea.
  it("keeps textarea focus across parent re-renders that change onClose", async () => {
    vi.mocked(getAssistantConfig).mockResolvedValue(BASE_CONFIG);
    vi.mocked(providerFromConfig).mockReturnValue({
      provider: stubProvider([]),
      reason: null,
    });
    const { rerender } = render(
      <AssistantOverlay
        onClose={() => {}}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    const input = await screen.findByTestId("assistant-overlay-input");
    await waitFor(() => expect(document.activeElement).toBe(input));
    // Fresh onClose reference — mimics App re-rendering on unrelated state.
    rerender(
      <AssistantOverlay
        onClose={() => {}}
        seededPrompt={null}
        onSeedConsumed={NOOP}
        onOpenSettings={NOOP}
        targetPtyId={null}
      />,
    );
    expect(document.activeElement).toBe(input);
  });

  // M7.7c — INSERT/NORMAL mode indicator
  it("emits shax:assistant-input-focus on textarea focus and blur", async () => {
    vi.mocked(getAssistantConfig).mockResolvedValue(BASE_CONFIG);
    vi.mocked(providerFromConfig).mockReturnValue({
      provider: stubProvider([]),
      reason: null,
    });
    const events: boolean[] = [];
    const onFocus = (e: Event): void => {
      const detail = (e as CustomEvent<{ focused?: boolean }>).detail;
      if (typeof detail?.focused === "boolean") events.push(detail.focused);
    };
    window.addEventListener("shax:assistant-input-focus", onFocus);
    try {
      render(
        <AssistantOverlay
          onClose={NOOP}
          seededPrompt={null}
          onSeedConsumed={NOOP}
          onOpenSettings={NOOP}
          targetPtyId={null}
        />,
      );
      const input = await screen.findByTestId("assistant-overlay-input");
      // The overlay auto-focuses on mount once the provider resolves,
      // so at least one focus event should already have landed.
      await waitFor(() => expect(events).toContain(true));
      fireEvent.blur(input);
      await waitFor(() => expect(events[events.length - 1]).toBe(false));
      fireEvent.focus(input);
      await waitFor(() => expect(events[events.length - 1]).toBe(true));
    } finally {
      window.removeEventListener("shax:assistant-input-focus", onFocus);
    }
  });
});
