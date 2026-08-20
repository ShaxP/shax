/**
 * GitBranchWidget tests (M13.2).
 *
 * Covers:
 *   - null when no pane focused
 *   - null when focused pane's branch is null (non-repo cwd)
 *   - expanded renders "⎇ branch" + optional "↑n ↓n" (both hidden
 *     when 0 or null)
 *   - rail renders "⎇" glyph with a branch-name tooltip
 *   - updates when focused-pane context value changes (focus swap
 *     to a different repo, OSC 133 A update)
 *   - working-tree counts (+n ~n ?n) from `git status --porcelain=v2`
 *   - the refresh policy: focus / cwd changes and completed commands
 *     in the focused pane, never a timer
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const porcelainMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ipc", () => ({ gitStatusPorcelain: porcelainMock }));

import { FocusedPaneProvider, type FocusedPaneMeta } from "../../lib/FocusedPaneContext";
import { countFrom, GitBranchWidget } from "./GitBranchWidget";

/** Porcelain v2 records are NUL-separated. */
function porcelain(...records: string[]): string {
  return records.join("\0");
}

const CLEAN = porcelain("# branch.head main");
/** One staged add, two unstaged modifications, one untracked file —
 *  the exact state the mockup's `+1 ~2 ?1` row describes. */
const MOCKUP_STATE = porcelain(
  "# branch.head main",
  "1 A. N... 000000 100644 100644 0000000 1111111 staged.ts",
  "1 .M N... 100644 100644 100644 1111111 1111111 edited-one.ts",
  "1 .M N... 100644 100644 100644 1111111 1111111 edited-two.ts",
  "? untracked.ts",
);

afterEach(cleanup);

beforeEach(() => {
  porcelainMock.mockReset().mockResolvedValue(CLEAN);
});

function meta(overrides: Partial<FocusedPaneMeta> = {}): FocusedPaneMeta {
  return {
    ptyId: "pty-1",
    cwd: "/tmp/repo",
    branch: "main",
    ahead: null,
    behind: null,
    ...overrides,
  };
}

describe("GitBranchWidget / hidden", () => {
  it("renders nothing when no pane is focused (context null)", () => {
    render(
      <FocusedPaneProvider value={null}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    expect(screen.queryByTestId("sidebar-git-branch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-git-branch-rail")).not.toBeInTheDocument();
  });

  it("renders nothing when the focused pane's branch is null (non-repo)", () => {
    render(
      <FocusedPaneProvider value={meta({ branch: null })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    expect(screen.queryByTestId("sidebar-git-branch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-git-branch-rail")).not.toBeInTheDocument();
  });
});

describe("GitBranchWidget / expanded", () => {
  it("renders branch name with the ⎇ glyph", () => {
    render(
      <FocusedPaneProvider value={meta({ branch: "feature/x" })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    const el = screen.getByTestId("sidebar-git-branch");
    expect(el.textContent).toContain("⎇");
    expect(el.textContent).toContain("feature/x");
  });

  it("shows ↑n ↓n counts only when > 0", () => {
    // ahead=2, behind=0 → only up-arrow rendered.
    const { rerender } = render(
      <FocusedPaneProvider value={meta({ branch: "main", ahead: 2, behind: 0 })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    let counts = screen.queryByTestId("sidebar-git-branch-counts");
    expect(counts?.textContent).toBe("↑2");

    // ahead=0, behind=3 → only down-arrow.
    rerender(
      <FocusedPaneProvider value={meta({ branch: "main", ahead: 0, behind: 3 })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    counts = screen.queryByTestId("sidebar-git-branch-counts");
    expect(counts?.textContent).toBe("↓3");

    // both zero → no counts group at all.
    rerender(
      <FocusedPaneProvider value={meta({ branch: "main", ahead: 0, behind: 0 })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    expect(screen.queryByTestId("sidebar-git-branch-counts")).not.toBeInTheDocument();
  });

  it("carries a tooltip with the branch and any counts", () => {
    render(
      <FocusedPaneProvider value={meta({ branch: "trunk", ahead: 4, behind: 1 })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    const el = screen.getByTestId("sidebar-git-branch");
    const tooltip = el.getAttribute("title") ?? "";
    expect(tooltip).toContain("trunk");
    expect(tooltip).toContain("↑4");
    expect(tooltip).toContain("↓1");
  });
});

describe("GitBranchWidget / rail", () => {
  it("renders the ⎇ glyph with a branch-name tooltip", () => {
    render(
      <FocusedPaneProvider value={meta({ branch: "main" })}>
        <GitBranchWidget visible={false} />
      </FocusedPaneProvider>,
    );
    const rail = screen.getByTestId("sidebar-git-branch-rail");
    expect(rail.textContent).toBe("⎇");
    expect(rail.getAttribute("title")).toContain("main");
  });

  it("stays hidden in the rail when branch is null", () => {
    render(
      <FocusedPaneProvider value={meta({ branch: null })}>
        <GitBranchWidget visible={false} />
      </FocusedPaneProvider>,
    );
    expect(screen.queryByTestId("sidebar-git-branch-rail")).not.toBeInTheDocument();
  });
});

describe("GitBranchWidget / updates", () => {
  it("swaps branch when the FocusedPaneContext value changes (focus swap)", () => {
    const { rerender } = render(
      <FocusedPaneProvider value={meta({ branch: "main" })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    expect(screen.getByTestId("sidebar-git-branch").textContent).toContain("main");

    // Simulate a focus swap into a pane sitting on a different branch.
    rerender(
      <FocusedPaneProvider value={meta({ branch: "release-2025" })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    expect(screen.getByTestId("sidebar-git-branch").textContent).toContain("release-2025");
  });
});

describe("GitBranchWidget / working-tree counts", () => {
  it("renders the mockup's +1 ~2 ?1 row from real porcelain output", async () => {
    porcelainMock.mockResolvedValue(MOCKUP_STATE);
    render(
      <FocusedPaneProvider value={meta()}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("sidebar-git-staged")).toHaveTextContent("+1"));
    expect(screen.getByTestId("sidebar-git-modified")).toHaveTextContent("~2");
    expect(screen.getByTestId("sidebar-git-untracked")).toHaveTextContent("?1");
  });

  it("counts a staged-then-edited file in BOTH +n and ~n", () => {
    // `MM` is one file the user staged and then edited again. It is
    // genuinely in both states, and showing it once would misreport
    // whichever half it was dropped from.
    const counts = countFrom(
      porcelain("# branch.head main", "1 MM N... 100644 100644 100644 1111111 2222222 both.ts"),
    );
    expect(counts).toEqual({ staged: 1, modified: 1, untracked: 0 });
  });

  it("omits a zero count rather than printing +0", () => {
    const counts = countFrom(porcelain("# branch.head main", "? only-untracked.ts"));
    expect(counts).toEqual({ staged: 0, modified: 0, untracked: 1 });
  });

  it("hides the whole row on a clean tree with nothing to sync", async () => {
    render(
      <FocusedPaneProvider value={meta()}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => expect(porcelainMock).toHaveBeenCalled());
    expect(screen.queryByTestId("sidebar-git-branch-counts")).not.toBeInTheDocument();
  });

  it("drops the counts when the probe fails rather than leaving stale numbers", async () => {
    porcelainMock.mockResolvedValue(MOCKUP_STATE);
    const { rerender } = render(
      <FocusedPaneProvider value={meta()}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("sidebar-git-staged")).toBeInTheDocument());

    // The repo went away under us (deleted, unmounted, permissions).
    porcelainMock.mockRejectedValue(new Error("not a git repository"));
    rerender(
      <FocusedPaneProvider value={meta({ cwd: "/tmp/other" })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId("sidebar-git-staged")).not.toBeInTheDocument());
  });
});

describe("GitBranchWidget / refresh policy", () => {
  it("re-probes when a command completes in the focused pane", async () => {
    render(
      <FocusedPaneProvider value={meta({ ptyId: "pty-1" })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => expect(porcelainMock).toHaveBeenCalledTimes(1));

    porcelainMock.mockResolvedValue(MOCKUP_STATE);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-complete", {
          detail: { paneId: "pty-1", blockId: "b1", source: "user" },
        }),
      );
    });
    // A command is what changes a working tree in a terminal — this
    // trigger is what lets the widget avoid polling entirely.
    await waitFor(() => expect(screen.getByTestId("sidebar-git-staged")).toHaveTextContent("+1"));
  });

  it("ignores commands completing in a pane it is not describing", async () => {
    render(
      <FocusedPaneProvider value={meta({ ptyId: "pty-1" })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => expect(porcelainMock).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-complete", {
          detail: { paneId: "pty-OTHER", blockId: "b1", source: "user" },
        }),
      );
    });
    expect(porcelainMock).toHaveBeenCalledTimes(1);
  });

  it("never probes for a non-repo cwd", () => {
    render(
      <FocusedPaneProvider value={meta({ branch: null })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    expect(porcelainMock).not.toHaveBeenCalled();
  });
});

describe("GitBranchWidget / sync indicator", () => {
  it("points the arrow up when ahead", async () => {
    render(
      <FocusedPaneProvider value={meta({ ahead: 1, behind: 0 })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("sidebar-git-sync")).toHaveTextContent("↑1"));
  });

  it("points the arrow down when behind", async () => {
    render(
      <FocusedPaneProvider value={meta({ ahead: 0, behind: 3 })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("sidebar-git-sync")).toHaveTextContent("↓3"));
  });

  it("shows both when the branch has diverged", async () => {
    // Hiding half of a diverged state would tell the user they are
    // simply ahead, and `git push` would then surprise them.
    render(
      <FocusedPaneProvider value={meta({ ahead: 2, behind: 5 })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => {
      const sync = screen.getByTestId("sidebar-git-sync");
      expect(sync).toHaveTextContent("↑2");
      expect(sync).toHaveTextContent("↓5");
    });
  });

  it("shows nothing when in sync", async () => {
    render(
      <FocusedPaneProvider value={meta({ ahead: 0, behind: 0 })}>
        <GitBranchWidget visible={true} />
      </FocusedPaneProvider>,
    );
    await waitFor(() => expect(porcelainMock).toHaveBeenCalled());
    expect(screen.queryByTestId("sidebar-git-sync")).not.toBeInTheDocument();
  });
});
