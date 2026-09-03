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

  // M7.7c — focus routing after the gate closes. AI-sourced
  // approvals go inline via `shax:approval-resolve` (M7.7d), so
  // approve them by dispatching that event instead of clicking.
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
            detail: {
              paneId: "pty-1",
              command: "ls",
              source: "ai",
              reason: "list files",
              toolCallId: "call-1",
            },
          }),
        );
      });
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:approval-resolve", {
            detail: { id: "call-1", decision: "approve" },
          }),
        );
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

  // M7.7d — AI-sourced commands no longer render a modal. They
  // publish `shax:approval-pending` for the assistant's APPROVAL
  // card to drive.
  it("publishes shax:approval-pending for AI-sourced commands and does not render a modal", () => {
    render(<SafetyGate />);
    const pendingSpy = vi.fn();
    window.addEventListener("shax:approval-pending", pendingSpy);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: {
              paneId: "pty-1",
              command: "ls",
              source: "ai",
              reason: "list files",
              toolCallId: "call-42",
            },
          }),
        );
      });
      expect(screen.queryByTestId("safety-gate")).toBeNull();
      expect(pendingSpy).toHaveBeenCalledTimes(1);
      const detail = (pendingSpy.mock.calls[0]?.[0] as CustomEvent).detail as {
        id: string;
        kind: string;
        command: string;
        reason?: string;
      };
      expect(detail.id).toBe("call-42");
      expect(detail.kind).toBe("ai");
      expect(detail.command).toBe("ls");
      expect(detail.reason).toBe("list files");
    } finally {
      window.removeEventListener("shax:approval-pending", pendingSpy);
    }
  });

  it("routes an AI-sourced approval through shax:approval-resolve → -approved", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: {
              paneId: "pty-1",
              command: "ls",
              source: "ai",
              toolCallId: "call-1",
            },
          }),
        );
      });
      // No modal, no forwarded event yet.
      expect(approvedSpy).not.toHaveBeenCalled();
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:approval-resolve", {
            detail: { id: "call-1", decision: "approve" },
          }),
        );
      });
      expect(approvedSpy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("shax:emit-command-approved", approvedSpy);
    }
  });

  it("routes an AI-sourced decline through shax:approval-resolve → drop", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: {
              paneId: "pty-1",
              command: "rm -rf /tmp/x",
              source: "ai",
              toolCallId: "call-2",
            },
          }),
        );
      });
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:approval-resolve", {
            detail: { id: "call-2", decision: "decline" },
          }),
        );
      });
      expect(approvedSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("shax:emit-command-approved", approvedSpy);
    }
  });

  it("ignores shax:approval-resolve for a non-matching correlation id", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: {
              paneId: "pty-1",
              command: "ls",
              source: "ai",
              toolCallId: "call-a",
            },
          }),
        );
      });
      // Wrong id — must not resolve the pending proposal.
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:approval-resolve", {
            detail: { id: "call-b", decision: "approve" },
          }),
        );
      });
      expect(approvedSpy).not.toHaveBeenCalled();
      // The right id still resolves.
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:approval-resolve", {
            detail: { id: "call-a", decision: "approve" },
          }),
        );
      });
      expect(approvedSpy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("shax:emit-command-approved", approvedSpy);
    }
  });

  // M7.7e — read-only fast path.
  it("silent-forwards a non-destructive readonly emit; no pending, no modal", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    const pendingSpy = vi.fn();
    const rejectedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    window.addEventListener("shax:approval-pending", pendingSpy);
    window.addEventListener("shax:approval-rejected", rejectedSpy);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: {
              paneId: "pty-1",
              command: "ls",
              source: "ai",
              readonly: true,
              toolCallId: "probe-1",
            },
          }),
        );
      });
      expect(approvedSpy).toHaveBeenCalledTimes(1);
      expect(pendingSpy).not.toHaveBeenCalled();
      expect(rejectedSpy).not.toHaveBeenCalled();
      expect(screen.queryByTestId("safety-gate")).toBeNull();
    } finally {
      window.removeEventListener("shax:emit-command-approved", approvedSpy);
      window.removeEventListener("shax:approval-pending", pendingSpy);
      window.removeEventListener("shax:approval-rejected", rejectedSpy);
    }
  });

  it("refuses a destructive readonly emit via shax:approval-rejected; no -approved fires", () => {
    render(<SafetyGate />);
    const approvedSpy = vi.fn();
    const rejectedSpy = vi.fn();
    window.addEventListener("shax:emit-command-approved", approvedSpy);
    window.addEventListener("shax:approval-rejected", rejectedSpy);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: {
              paneId: "pty-1",
              command: "rm -rf /tmp/x",
              source: "ai",
              readonly: true,
              toolCallId: "probe-bad",
            },
          }),
        );
      });
      expect(approvedSpy).not.toHaveBeenCalled();
      expect(rejectedSpy).toHaveBeenCalledTimes(1);
      const detail = (rejectedSpy.mock.calls[0]?.[0] as CustomEvent).detail as {
        id: string;
        reason: string;
      };
      expect(detail.id).toBe("probe-bad");
      expect(detail.reason.length).toBeGreaterThan(0);
    } finally {
      window.removeEventListener("shax:emit-command-approved", approvedSpy);
      window.removeEventListener("shax:approval-rejected", rejectedSpy);
    }
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

describe("SafetyGate — undeliverable approved emits", () => {
  // An approved command that no pane picks up used to vanish. The
  // pane handler ignores emits addressed elsewhere, so a stale or
  // closed paneId reached no listener and nobody was left to
  // complain; the assistant then waited out its full five-minute
  // timeout and told the user they had declined a command they had
  // in fact approved.
  it("reports an approved emit that no pane acknowledges", () => {
    vi.useFakeTimers();
    try {
      render(<SafetyGate />);
      const rejected: { id: string; reason: string }[] = [];
      const onRejected = (e: Event): void => {
        rejected.push((e as CustomEvent<{ id: string; reason: string }>).detail);
      };
      window.addEventListener("shax:approval-rejected", onRejected);
      try {
        act(() => {
          window.dispatchEvent(
            new CustomEvent("shax:emit-command", {
              // readonly → the gate's silent-forward path, which is
              // where a probe's command travels after the Run click.
              detail: {
                paneId: "pty-gone",
                command: "ls -lh",
                source: "ai",
                toolCallId: "call-1",
                readonly: true,
              },
            }),
          );
        });
        expect(rejected).toHaveLength(0);
        act(() => {
          vi.advanceTimersByTime(2500);
        });
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.id).toBe("call-1");
        expect(rejected[0]?.reason).toContain("no pane accepted");
      } finally {
        window.removeEventListener("shax:approval-rejected", onRejected);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet when a pane acknowledges the command", () => {
    vi.useFakeTimers();
    try {
      render(<SafetyGate />);
      const rejected: unknown[] = [];
      const onRejected = (e: Event): void => {
        rejected.push(e);
      };
      const onApproved = (e: Event): void => {
        const detail = (e as CustomEvent<ApprovedCommandDetail>).detail;
        // Stand in for TerminalPane committing the command.
        window.dispatchEvent(
          new CustomEvent("shax:emit-command-accepted", {
            detail: { toolCallId: detail.toolCallId },
          }),
        );
      };
      window.addEventListener("shax:approval-rejected", onRejected);
      window.addEventListener("shax:emit-command-approved", onApproved);
      try {
        act(() => {
          window.dispatchEvent(
            new CustomEvent("shax:emit-command", {
              detail: {
                paneId: "pty-1",
                command: "ls -lh",
                source: "ai",
                toolCallId: "call-2",
                readonly: true,
              },
            }),
          );
        });
        act(() => {
          vi.advanceTimersByTime(2500);
        });
        expect(rejected).toHaveLength(0);
      } finally {
        window.removeEventListener("shax:approval-rejected", onRejected);
        window.removeEventListener("shax:emit-command-approved", onApproved);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards the correlation id so the pane can report a refusal", () => {
    render(<SafetyGate />);
    const approved = proposeAndCollect({
      paneId: "pty-1",
      command: "ls -lh",
      source: "ai",
      toolCallId: "call-3",
      readonly: true,
    });
    expect(approved).toHaveLength(1);
    // Without this the pane has no id to speak with, which is why the
    // drop paths could only return silently.
    expect(approved[0]?.detail.toolCallId).toBe("call-3");
  });
});
