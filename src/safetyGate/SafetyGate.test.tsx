import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { SafetyGate } from "./SafetyGate";
import type { ApprovedCommandDetail, EmitCommandDetail } from "./SafetyGate";

/** Dispatch a proposal event to the gate and return whatever
 *  approved-events fired synchronously as a result. */
function proposeAndCollect(detail: EmitCommandDetail): CustomEvent<ApprovedCommandDetail>[] {
  const approvedEvents: CustomEvent<ApprovedCommandDetail>[] = [];
  const handler = (e: Event): void => {
    approvedEvents.push(e as CustomEvent<ApprovedCommandDetail>);
  };
  window.addEventListener("shax:emit-command-approved", handler);
  try {
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:emit-command", { detail }));
    });
  } finally {
    window.removeEventListener("shax:emit-command-approved", handler);
  }
  return approvedEvents;
}

describe("SafetyGate", () => {
  it("forwards routine widget emits silently — no modal, immediate approved event", () => {
    render(<SafetyGate />);
    const approved = proposeAndCollect({
      paneId: "pty-1",
      command: "git add -- src/foo.ts",
    });
    expect(approved).toHaveLength(1);
    expect(approved[0]?.detail).toEqual({
      paneId: "pty-1",
      command: "git add -- src/foo.ts",
      source: "widget",
    });
    expect(screen.queryByTestId("safety-gate")).not.toBeInTheDocument();
  });

  it("shows a modal for destructive commands, holds the approved event until approved", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId: "pty-1", command: "rm -rf /tmp/x" },
        }),
      );
    });
    const modal = screen.getByTestId("safety-gate");
    expect(modal).toHaveAttribute("data-kind", "destructive");
    expect(screen.getByTestId("safety-gate-command")).toHaveTextContent("rm -rf /tmp/x");
    // No approved event yet — the modal is holding the emit.
    expect(approvedSpy).not.toHaveBeenCalled();
    // Approve → event fires.
    act(() => {
      fireEvent.click(screen.getByTestId("safety-gate-approve"));
    });
    expect(approvedSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("safety-gate")).not.toBeInTheDocument();
    window.removeEventListener("shax:emit-command-approved", approvedSpy);
  });

  it("declines drop the emit — no approved event, modal closes", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId: "pty-1", command: "git push --force" },
        }),
      );
    });
    expect(screen.getByTestId("safety-gate")).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByTestId("safety-gate-decline"));
    });
    expect(approvedSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("safety-gate")).not.toBeInTheDocument();
    window.removeEventListener("shax:emit-command-approved", approvedSpy);
  });

  it("Enter approves, Escape declines", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    // Show modal via a destructive emit.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId: "pty-1", command: "rm -rf /tmp/x" },
        }),
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(approvedSpy).toHaveBeenCalledTimes(1);
    // New modal, Escape declines.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId: "pty-1", command: "rm -rf /tmp/x" },
        }),
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(approvedSpy).toHaveBeenCalledTimes(1); // still only the first approval
    window.removeEventListener("shax:emit-command-approved", approvedSpy);
  });

  // M7.7c — focus routing after the gate closes.
  it("routes focus to the assistant textarea after approving an AI-sourced command", () => {
    render(<SafetyGate />);
    const focusInput = vi.fn();
    const focusPane = vi.fn();
    window.addEventListener("shax:assistant-focus-input", focusInput);
    window.addEventListener("shax:refocus-pane", focusPane);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: { paneId: "pty-1", command: "ls", source: "ai", reason: "list files" },
          }),
        );
      });
      act(() => {
        fireEvent.click(screen.getByTestId("safety-gate-approve"));
      });
      expect(focusInput).toHaveBeenCalledTimes(1);
      expect(focusPane).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("shax:assistant-focus-input", focusInput);
      window.removeEventListener("shax:refocus-pane", focusPane);
    }
  });

  it("routes focus back to the terminal pane after approving a widget-sourced command", () => {
    render(<SafetyGate />);
    const focusInput = vi.fn();
    const focusPane = vi.fn();
    window.addEventListener("shax:assistant-focus-input", focusInput);
    window.addEventListener("shax:refocus-pane", focusPane);
    try {
      // Destructive so a modal opens for widget approval.
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: { paneId: "pty-1", command: "rm -rf /tmp/x", source: "widget" },
          }),
        );
      });
      act(() => {
        fireEvent.click(screen.getByTestId("safety-gate-approve"));
      });
      expect(focusPane).toHaveBeenCalledTimes(1);
      expect(focusInput).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("shax:assistant-focus-input", focusInput);
      window.removeEventListener("shax:refocus-pane", focusPane);
    }
  });

  it("shows a modal for AI-sourced commands even when non-destructive", () => {
    render(<SafetyGate />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId: "pty-1", command: "ls", source: "ai", reason: "list files" },
        }),
      );
    });
    const modal = screen.getByTestId("safety-gate");
    expect(modal).toHaveAttribute("data-kind", "ai");
    expect(modal).toHaveTextContent("why: list files");
  });

  it("drops proposals that arrive while a modal is already pending", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    // Open modal with a destructive command.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId: "pty-1", command: "rm -rf /tmp/x" },
        }),
      );
    });
    expect(screen.getByTestId("safety-gate-command")).toHaveTextContent("rm -rf /tmp/x");
    // Send a second proposal — routine, but should be dropped
    // because the modal is holding a decision.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId: "pty-1", command: "ls" },
        }),
      );
    });
    // Routine would have forwarded silently — but we're
    // pending, so it should be dropped.
    expect(approvedSpy).not.toHaveBeenCalled();
    // Modal is still on the original destructive command.
    expect(screen.getByTestId("safety-gate-command")).toHaveTextContent("rm -rf /tmp/x");
    window.removeEventListener("shax:emit-command-approved", approvedSpy);
  });

  it("does not modal-block subsequent routine emits after a decision closes the modal", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    // Open + approve.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId: "pty-1", command: "rm -rf /tmp/x" },
        }),
      );
    });
    act(() => {
      fireEvent.click(screen.getByTestId("safety-gate-approve"));
    });
    expect(approvedSpy).toHaveBeenCalledTimes(1);
    // A subsequent routine emit forwards immediately.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId: "pty-1", command: "ls" },
        }),
      );
    });
    expect(approvedSpy).toHaveBeenCalledTimes(2);
    window.removeEventListener("shax:emit-command-approved", approvedSpy);
  });
});
