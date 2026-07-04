import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { GitStatusWidget } from "./GitStatusWidget";
import type { GitStatus, StatusEntry } from "../../formatters/parseGitStatus";

// The widget calls `gitStatusPorcelain` directly for silent
// refresh. Mock it so tests can drive the "block-complete →
// re-probe" path without a real Tauri context.
vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    gitStatusPorcelain: vi.fn().mockResolvedValue(""),
  };
});
import { gitStatusPorcelain } from "../../lib/ipc";

const EMPTY_BRANCH = { head: "main", oid: null, upstream: null, ahead: 0, behind: 0 };

function mkStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: EMPTY_BRANCH,
    staged: [],
    unstaged: [],
    untracked: [],
    ignored: [],
    unmerged: [],
    ...overrides,
  };
}

function mkEntry(path: string, overrides: Partial<StatusEntry> = {}): StatusEntry {
  return {
    path,
    origPath: null,
    index: ".",
    worktree: "M",
    unmerged: false,
    ...overrides,
  };
}

/** Wrap the widget in a fake BlockRow ancestor with the
 *  `data-block-id` + `data-is-latest` attributes the widget
 *  reads. Default to the *live* case so most tests exercise
 *  the interactive path; the historical case gets its own
 *  test with `isLatest: false`. */
function withBlock(
  id: string,
  { isLatest = true }: { isLatest?: boolean } = {},
): (children: React.ReactElement) => React.ReactElement {
  return (children) => (
    <div data-block-id={id} data-is-latest={isLatest ? "true" : "false"}>
      {children}
    </div>
  );
}

describe("GitStatusWidget", () => {
  it("shows a clean-tree note when nothing has changed", () => {
    render(<GitStatusWidget status={mkStatus()} paneId="pty-1" />);
    expect(screen.getByTestId("widget-git-status")).toHaveTextContent(
      "nothing to commit, working tree clean",
    );
  });

  it("groups entries into staged / unstaged / untracked sections", () => {
    render(
      <GitStatusWidget
        status={mkStatus({
          staged: [mkEntry("src/a.ts", { index: "M", worktree: "." })],
          unstaged: [mkEntry("src/b.ts", { index: ".", worktree: "M" })],
          untracked: [mkEntry("new.txt", { index: "?", worktree: "?" })],
        })}
        paneId="pty-1"
      />,
    );
    expect(screen.getByTestId("widget-git-status-section-staged")).toHaveTextContent("src/a.ts");
    expect(screen.getByTestId("widget-git-status-section-unstaged")).toHaveTextContent("src/b.ts");
    expect(screen.getByTestId("widget-git-status-section-untracked")).toHaveTextContent("new.txt");
  });

  it("renders the branch pill and summary counts", () => {
    render(
      <GitStatusWidget
        status={mkStatus({
          branch: { head: "feat/x", oid: null, upstream: "origin/feat/x", ahead: 2, behind: 0 },
          staged: [mkEntry("a.ts", { index: "M", worktree: "." })],
          unstaged: [
            mkEntry("b.ts", { index: ".", worktree: "M" }),
            mkEntry("c.ts", { index: ".", worktree: "M" }),
          ],
        })}
        paneId="pty-1"
      />,
    );
    expect(screen.getByTestId("widget-git-status-branch")).toHaveTextContent("feat/x");
    expect(screen.getByTestId("widget-git-status-summary")).toHaveTextContent(
      "1 staged · 2 unstaged",
    );
  });

  it("widget-nav down / up walks section headers and entries in order", () => {
    render(
      withBlock("b1")(
        <GitStatusWidget
          status={mkStatus({
            staged: [mkEntry("a.ts", { index: "M", worktree: "." })],
            unstaged: [mkEntry("b.ts", { index: ".", worktree: "M" })],
          })}
          paneId="pty-1"
        />,
      ),
    );
    const send = (direction: "up" | "down" | "left" | "right") => {
      const detail: { blockId: string; direction: typeof direction; claimed: boolean } = {
        blockId: "b1",
        direction,
        claimed: false,
      };
      act(() => {
        window.dispatchEvent(new CustomEvent("shax:widget-nav", { detail }));
      });
      return detail.claimed;
    };
    // Order: staged header → a.ts → unstaged header → b.ts.
    expect(send("down")).toBe(true);
    expect(screen.getByTestId("widget-git-status-section-staged-header")).toHaveAttribute(
      "data-focused",
      "true",
    );
    expect(send("down")).toBe(true);
    const stagedEntries = screen
      .getAllByTestId("widget-git-status-entry")
      .filter((e) => e.getAttribute("data-section") === "staged");
    expect(stagedEntries[0]).toHaveAttribute("data-focused", "true");
    expect(send("down")).toBe(true);
    expect(screen.getByTestId("widget-git-status-section-unstaged-header")).toHaveAttribute(
      "data-focused",
      "true",
    );
    expect(send("down")).toBe(true);
    const unstagedEntries = screen
      .getAllByTestId("widget-git-status-entry")
      .filter((e) => e.getAttribute("data-section") === "unstaged");
    expect(unstagedEntries[0]).toHaveAttribute("data-focused", "true");
    // Past the last row → no claim so shell can advance to the next block.
    expect(send("down")).toBe(false);
  });

  it("widget-nav right on a collapsed section header re-expands it", () => {
    render(
      withBlock("b1a")(
        <GitStatusWidget
          status={mkStatus({
            staged: [mkEntry("a.ts", { index: "M", worktree: "." })],
          })}
          paneId="pty-1"
        />,
      ),
    );
    const send = (direction: "up" | "down" | "left" | "right") => {
      const detail: { blockId: string; direction: typeof direction; claimed: boolean } = {
        blockId: "b1a",
        direction,
        claimed: false,
      };
      act(() => {
        window.dispatchEvent(new CustomEvent("shax:widget-nav", { detail }));
      });
      return detail.claimed;
    };
    // Focus the section header, collapse it, verify no entries
    // are visible, then re-expand via `right` — the key path
    // the original bug closed off.
    send("down");
    send("left");
    expect(screen.getByTestId("widget-git-status-section-staged")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(screen.queryByTestId("widget-git-status-entry")).toBeNull();
    send("right");
    expect(screen.getByTestId("widget-git-status-section-staged")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
    expect(screen.getAllByTestId("widget-git-status-entry")).toHaveLength(1);
  });

  it("widget-primary on unstaged emits `git add -- <path>`", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("b2")(
        <GitStatusWidget
          status={mkStatus({
            unstaged: [mkEntry("src/foo.ts", { index: ".", worktree: "M" })],
          })}
          paneId="pty-42"
        />,
      ),
    );
    // Two `down` presses: first lands on the section header,
    // second on the first entry.
    for (let i = 0; i < 2; i++) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:widget-nav", {
            detail: { blockId: "b2", direction: "down", claimed: false },
          }),
        );
      });
    }
    // Fire the primary action.
    const primaryDetail = { blockId: "b2", claimed: false };
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:widget-primary", { detail: primaryDetail }));
    });
    expect(primaryDetail.claimed).toBe(true);
    // Only the action is emitted — the refresh happens
    // silently via the block-complete listener + a direct
    // `gitStatusPorcelain` re-probe, so no `git status`
    // follow-up appears in the scrollback.
    expect(spy).toHaveBeenCalledTimes(1);
    const only = spy.mock.calls[0]?.[0] as CustomEvent<{ paneId: string; command: string }>;
    expect(only.detail).toEqual({
      paneId: "pty-42",
      command: "git add -- src/foo.ts",
    });
    window.removeEventListener("shax:emit-command", spy);
  });

  it("widget-primary on staged emits `git reset HEAD -- <path>`", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("b3")(
        <GitStatusWidget
          status={mkStatus({
            staged: [mkEntry("src/foo.ts", { index: "M", worktree: "." })],
          })}
          paneId="pty-42"
        />,
      ),
    );
    for (let i = 0; i < 2; i++) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:widget-nav", {
            detail: { blockId: "b3", direction: "down", claimed: false },
          }),
        );
      });
    }
    const primaryDetail = { blockId: "b3", claimed: false };
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:widget-primary", { detail: primaryDetail }));
    });
    const call = spy.mock.calls[0]?.[0] as CustomEvent<{ paneId: string; command: string }>;
    expect(call.detail.command).toBe("git reset HEAD -- src/foo.ts");
    window.removeEventListener("shax:emit-command", spy);
  });

  it("widget-primary on a conflict is a no-op and does not claim", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("b4")(
        <GitStatusWidget
          status={mkStatus({
            unmerged: [mkEntry("src/foo.ts", { unmerged: true })],
          })}
          paneId="pty-42"
        />,
      ),
    );
    for (let i = 0; i < 2; i++) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:widget-nav", {
            detail: { blockId: "b4", direction: "down", claimed: false },
          }),
        );
      });
    }
    const primaryDetail = { blockId: "b4", claimed: false };
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:widget-primary", { detail: primaryDetail }));
    });
    expect(primaryDetail.claimed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    window.removeEventListener("shax:emit-command", spy);
  });

  it("quotes paths with unusual characters", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("b5")(
        <GitStatusWidget
          status={mkStatus({
            unstaged: [mkEntry("path with spaces/file.txt", { index: ".", worktree: "M" })],
          })}
          paneId="pty-42"
        />,
      ),
    );
    for (let i = 0; i < 2; i++) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:widget-nav", {
            detail: { blockId: "b5", direction: "down", claimed: false },
          }),
        );
      });
    }
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:widget-primary", {
          detail: { blockId: "b5", claimed: false },
        }),
      );
    });
    const call = spy.mock.calls[0]?.[0] as CustomEvent<{ paneId: string; command: string }>;
    expect(call.detail.command).toBe("git add -- 'path with spaces/file.txt'");
    window.removeEventListener("shax:emit-command", spy);
  });

  it("silent refresh: after a widget-emit block completes, the widget re-probes", async () => {
    const porcelainMock = vi.mocked(gitStatusPorcelain);
    porcelainMock.mockClear();
    // Post-stage snapshot: the file that was previously
    // unstaged is now in the staged bucket. Porcelain v2 with
    // `-z` uses NUL record separators.
    porcelainMock.mockResolvedValueOnce(
      ["# branch.head main", "1 M. N... 100644 100644 100644 aa aa src/foo.ts", ""].join("\0"),
    );
    render(
      withBlock("brefresh")(
        <GitStatusWidget
          status={mkStatus({
            unstaged: [mkEntry("src/foo.ts", { index: ".", worktree: "M" })],
          })}
          paneId="pty-42"
          cwd="/repo-a"
        />,
      ),
    );
    // Simulate the widget's own emit having just completed.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-complete", {
          detail: { paneId: "pty-42", blockId: "bwidget", source: "widget" },
        }),
      );
    });
    await waitFor(() => expect(porcelainMock).toHaveBeenCalledWith("/repo-a"));
    // Widget picks up the new snapshot: file moved to staged.
    await waitFor(() =>
      expect(screen.getByTestId("widget-git-status-section-staged")).toHaveTextContent(
        "src/foo.ts",
      ),
    );
    // Widget stays live (not frozen).
    expect(screen.getByTestId("widget-git-status")).toHaveAttribute("data-is-live", "true");
  });

  it("user-typed block completion freezes the widget", () => {
    render(
      withBlock("bfreeze")(
        <GitStatusWidget
          status={mkStatus({
            unstaged: [mkEntry("src/foo.ts", { index: ".", worktree: "M" })],
          })}
          paneId="pty-42"
          cwd="/repo-a"
        />,
      ),
    );
    expect(screen.getByTestId("widget-git-status")).toHaveAttribute("data-is-live", "true");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-complete", {
          detail: { paneId: "pty-42", blockId: "buser", source: "user" },
        }),
      );
    });
    expect(screen.getByTestId("widget-git-status")).toHaveAttribute("data-is-live", "false");
    expect(screen.getByTestId("widget-git-status-historical")).toBeInTheDocument();
  });

  it("historical (non-latest) widgets refuse to act on Space", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("bold", { isLatest: false })(
        <GitStatusWidget
          status={mkStatus({
            unstaged: [mkEntry("src/foo.ts", { index: ".", worktree: "M" })],
          })}
          paneId="pty-42"
        />,
      ),
    );
    // Nav still works — historical widgets stay navigable.
    for (let i = 0; i < 2; i++) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:widget-nav", {
            detail: { blockId: "bold", direction: "down", claimed: false },
          }),
        );
      });
    }
    // Space, however, does not claim and emits nothing.
    const primaryDetail = { blockId: "bold", claimed: false };
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:widget-primary", { detail: primaryDetail }));
    });
    expect(primaryDetail.claimed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    // Widget renders a `historical` badge and marks itself as
    // not-live via the data attribute.
    expect(screen.getByTestId("widget-git-status-historical")).toBeInTheDocument();
    expect(screen.getByTestId("widget-git-status")).toHaveAttribute("data-is-live", "false");
    window.removeEventListener("shax:emit-command", spy);
  });

  it("h collapses the focused entry's section", () => {
    render(
      withBlock("b6")(
        <GitStatusWidget
          status={mkStatus({
            staged: [mkEntry("a.ts", { index: "M", worktree: "." })],
            unstaged: [mkEntry("b.ts", { index: ".", worktree: "M" })],
          })}
          paneId="pty-1"
        />,
      ),
    );
    // Two `down`s to reach the first staged entry (past the
    // section header).
    for (let i = 0; i < 2; i++) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:widget-nav", {
            detail: { blockId: "b6", direction: "down", claimed: false },
          }),
        );
      });
    }
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:widget-nav", {
          detail: { blockId: "b6", direction: "left", claimed: false },
        }),
      );
    });
    expect(screen.getByTestId("widget-git-status-section-staged")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(screen.getByTestId("widget-git-status-section-unstaged")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
  });

  it("clicking a section header toggles that section", () => {
    render(
      withBlock("b7")(
        <GitStatusWidget
          status={mkStatus({
            unstaged: [mkEntry("a.ts", { index: ".", worktree: "M" })],
          })}
          paneId="pty-1"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId("widget-git-status-section-unstaged-header"));
    expect(screen.getByTestId("widget-git-status-section-unstaged")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
  });
});
