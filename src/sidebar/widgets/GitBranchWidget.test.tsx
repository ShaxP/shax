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
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { FocusedPaneProvider, type FocusedPaneMeta } from "../../lib/FocusedPaneContext";
import { GitBranchWidget } from "./GitBranchWidget";

afterEach(cleanup);

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
