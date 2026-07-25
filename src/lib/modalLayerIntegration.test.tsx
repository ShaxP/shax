/**
 * Integration test — assistant + safety-gate modal.
 *
 * Verifies the specific scenario the user reported: with the
 * assistant dock rendered and the safety-gate modal visible,
 * pressing Escape closes ONLY the safety-gate, not the
 * assistant behind it.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { AssistantOverlay } from "../assistant/AssistantOverlay";
import { SafetyGate } from "../safetyGate/SafetyGate";
import { PaletteOverlay } from "../palette/PaletteOverlay";
import "../palette/builtins/echoHello";
import { _resetModalLayersForTests } from "./modalLayer";

// Same mocks the AssistantOverlay tests use.
vi.mock("../settings/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings/config")>();
  return {
    ...actual,
    getAssistantConfig: vi.fn().mockResolvedValue({
      provider: "claude",
      claude_lane: "api-key",
      claude_model: "claude-sonnet-4-6",
      ollama_model: null,
      ollama_capabilities: null,
    }),
  };
});
vi.mock("../assistant/providerFactory", () => ({
  providerFromConfig: vi.fn().mockReturnValue({
    provider: {
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
      stream: vi.fn(),
    },
    reason: null,
  }),
}));
vi.mock("../assistant/history", () => ({
  loadChatHistory: vi.fn().mockResolvedValue({ turns: [] }),
  saveChatHistory: vi.fn().mockResolvedValue(undefined),
  clearChatHistory: vi.fn().mockResolvedValue(undefined),
}));

describe("modal-layer integration — assistant + safety-gate", () => {
  it("Escape with both mounted closes only the safety-gate", async () => {
    _resetModalLayersForTests();
    const onCloseAssistant = vi.fn();
    render(
      <>
        <AssistantOverlay
          onClose={onCloseAssistant}
          seededPrompt={null}
          onSeedConsumed={() => {}}
          onOpenSettings={() => {}}
          targetPtyId={null}
        />
        <SafetyGate />
      </>,
    );

    // Wait for assistant to fully mount (its useEffects register listeners).
    await screen.findByTestId("assistant-overlay-input");

    // Trigger the safety-gate modal via a destructive widget emit.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: {
            paneId: "pty-1",
            command: "rm -rf /tmp/x",
            source: "widget",
          },
        }),
      );
    });

    // Modal should render.
    await screen.findByTestId("safety-gate");
    // And blur the input so we're not in the textarea-Escape path.
    const input = screen.getByTestId("assistant-overlay-input");
    act(() => input.blur());

    // Press Escape.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // Safety gate closes.
    await waitFor(() => expect(screen.queryByTestId("safety-gate")).not.toBeInTheDocument());
    // Assistant does NOT.
    expect(onCloseAssistant).not.toHaveBeenCalled();
  });

  it("With only the assistant mounted, Escape from outside the textarea closes it", async () => {
    _resetModalLayersForTests();
    const onCloseAssistant = vi.fn();
    render(
      <>
        <AssistantOverlay
          onClose={onCloseAssistant}
          seededPrompt={null}
          onSeedConsumed={() => {}}
          onOpenSettings={() => {}}
          targetPtyId={null}
        />
        <SafetyGate />
      </>,
    );
    const input = await screen.findByTestId("assistant-overlay-input");
    act(() => input.blur());
    // No modal on the stack — assistant should close on Escape.
    act(() => {
      // Fire ONCE so we don't double-count.
      const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      window.dispatchEvent(evt);
    });
    expect(onCloseAssistant).toHaveBeenCalled();
  });

  // Reproduces the exact user report: palette → Enter on Echo hello
  // → safety-gate modal appears (palette-sourced commands classify
  // as "ai" and hit the modal path) → Escape must close only the
  // safety-gate, not the assistant behind it.
  it("palette Enter → safety-gate → Escape leaves the assistant open", async () => {
    _resetModalLayersForTests();
    const onCloseAssistant = vi.fn();
    const onClosePalette = vi.fn();
    render(
      <>
        <AssistantOverlay
          onClose={onCloseAssistant}
          seededPrompt={null}
          onSeedConsumed={() => {}}
          onOpenSettings={() => {}}
          targetPtyId="pty-1"
        />
        <PaletteOverlay
          ctx={{ ptyId: "pty-1", cwd: "/tmp", branch: null }}
          onClose={onClosePalette}
        />
        <SafetyGate />
      </>,
    );

    await screen.findByTestId("assistant-overlay-input");
    // Filter to Echo hello, select, preview.
    const paletteInput = screen.getByTestId("palette-overlay-input");
    fireEvent.change(paletteInput, { target: { value: "echo" } });
    fireEvent.keyDown(paletteInput, { key: "Enter" });
    await screen.findByTestId("palette-overlay-preview");

    // Submit — palette dispatches emit-command with source="palette".
    // SafetyGate classifies as "ai" (non-inline for palette source),
    // renders the modal. Palette closes.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await screen.findByTestId("safety-gate");
    expect(onClosePalette).toHaveBeenCalledTimes(1);

    // Now the exact user gesture: Escape.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    await waitFor(() => expect(screen.queryByTestId("safety-gate")).not.toBeInTheDocument());
    expect(onCloseAssistant).not.toHaveBeenCalled();
  });

  it("Enter with both mounted approves only the safety-gate", async () => {
    _resetModalLayersForTests();
    const approvedEvents: unknown[] = [];
    const onApproved = (e: Event): void => {
      approvedEvents.push((e as CustomEvent).detail);
    };
    window.addEventListener("shax:emit-command-approved", onApproved);
    try {
      const onCloseAssistant = vi.fn();
      render(
        <>
          <AssistantOverlay
            onClose={onCloseAssistant}
            seededPrompt={null}
            onSeedConsumed={() => {}}
            onOpenSettings={() => {}}
            targetPtyId={null}
          />
          <SafetyGate />
        </>,
      );
      await screen.findByTestId("assistant-overlay-input");
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: {
              paneId: "pty-1",
              command: "rm -rf /tmp/x",
              source: "widget",
            },
          }),
        );
      });
      await screen.findByTestId("safety-gate");
      const input = screen.getByTestId("assistant-overlay-input");
      act(() => input.blur());
      // Enter — safety gate approves; assistant's textarea isn't
      // focused so nothing else should fire.
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(approvedEvents).toHaveLength(1);
      expect(onCloseAssistant).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("shax:emit-command-approved", onApproved);
    }
  });
});
