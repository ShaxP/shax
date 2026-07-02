import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { GitStatusWidget } from "./GitStatusWidget";
import type { GitStatus, StatusEntry } from "../../formatters/parseGitStatus";

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

function withBlock(id: string): (children: React.ReactElement) => React.ReactElement {
  return (children) => <div data-block-id={id}>{children}</div>;
}

describe("GitStatusWidget", () => {
  it("shows a clean-tree note when nothing has changed", () => {
    render(<GitStatusWidget status={mkStatus()} paneId="pty-1" cwd="/repo-a" />);
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
        cwd="/repo-a"
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
        cwd="/repo-a"
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
          cwd="/repo-a"
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
          cwd="/repo-a"
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
          cwd="/repo-a"
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
    // Two emitted commands: the action itself, then a
    // `git status` refresh so the user sees the updated tree
    // in a fresh block right below.
    expect(spy).toHaveBeenCalledTimes(2);
    const first = spy.mock.calls[0]?.[0] as CustomEvent<{ paneId: string; command: string }>;
    const second = spy.mock.calls[1]?.[0] as CustomEvent<{ paneId: string; command: string }>;
    expect(first.detail).toEqual({
      paneId: "pty-42",
      command: "git -C /repo-a add -- src/foo.ts",
    });
    expect(second.detail).toEqual({
      paneId: "pty-42",
      command: "git -C /repo-a status",
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
          cwd="/repo-a"
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
    expect(call.detail.command).toBe("git -C /repo-a reset HEAD -- src/foo.ts");
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
          cwd="/repo-a"
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
          cwd="/repo-a"
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
    expect(call.detail.command).toBe("git -C /repo-a add -- 'path with spaces/file.txt'");
    window.removeEventListener("shax:emit-command", spy);
  });

  it("refuses to act when the widget has no origin cwd (unclaims Space)", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("bnull")(
        <GitStatusWidget
          status={mkStatus({
            unstaged: [mkEntry("src/foo.ts", { index: ".", worktree: "M" })],
          })}
          paneId="pty-42"
          cwd={null}
        />,
      ),
    );
    for (let i = 0; i < 2; i++) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:widget-nav", {
            detail: { blockId: "bnull", direction: "down", claimed: false },
          }),
        );
      });
    }
    const primaryDetail = { blockId: "bnull", claimed: false };
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:widget-primary", { detail: primaryDetail }));
    });
    expect(primaryDetail.claimed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    window.removeEventListener("shax:emit-command", spy);
  });

  it("quotes the origin cwd when it contains unusual characters", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("bcwd")(
        <GitStatusWidget
          status={mkStatus({
            unstaged: [mkEntry("src/foo.ts", { index: ".", worktree: "M" })],
          })}
          paneId="pty-42"
          cwd="/Users/ada/my repo"
        />,
      ),
    );
    for (let i = 0; i < 2; i++) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("shax:widget-nav", {
            detail: { blockId: "bcwd", direction: "down", claimed: false },
          }),
        );
      });
    }
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:widget-primary", {
          detail: { blockId: "bcwd", claimed: false },
        }),
      );
    });
    const call = spy.mock.calls[0]?.[0] as CustomEvent<{ paneId: string; command: string }>;
    expect(call.detail.command).toBe("git -C '/Users/ada/my repo' add -- src/foo.ts");
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
          cwd="/repo-a"
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
          cwd="/repo-a"
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
