import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { buildCheckoutCommand, GitCheckoutPanel } from "./GitCheckoutPanel";
import type { PaneContext } from "../../registry";
import type { GitBranch } from "../../../lib/ipc";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return { ...actual, gitBranches: vi.fn() };
});

import { gitBranches } from "../../../lib/ipc";

const CTX: PaneContext = {
  ptyId: "pty-1",
  cwd: "/tmp/repo",
  branch: "main",
  gitRoot: "/tmp/repo",
};

function branch(name: string, kind: GitBranch["kind"], is_current = false): GitBranch {
  return { name, kind, is_current };
}

beforeEach(() => {
  vi.mocked(gitBranches).mockReset();
});
afterEach(() => {
  vi.mocked(gitBranches).mockReset();
});

describe("buildCheckoutCommand", () => {
  it("local branch → `git checkout <name>`", () => {
    expect(buildCheckoutCommand(branch("main", "local"))).toBe("git checkout main");
  });

  it("remote-tracking branch → `git checkout -b <local> <remote>`", () => {
    expect(buildCheckoutCommand(branch("origin/feat/foo", "remote"))).toBe(
      "git checkout -b feat/foo origin/feat/foo",
    );
  });

  it("shell-escapes tricky branch names", () => {
    expect(buildCheckoutCommand(branch("with space", "local"))).toBe("git checkout 'with space'");
  });
});

describe("GitCheckoutPanel", () => {
  it("groups branches into Local + Remote sections", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("main", "local", true),
      branch("feat/foo", "local"),
      branch("origin/main", "remote"),
      branch("origin/feat/foo", "remote"),
    ]);
    render(<GitCheckoutPanel ctx={CTX} onSubmit={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("palette-git-checkout-row")).toHaveLength(4));
    expect(screen.getByText(/Local branches/i)).toBeInTheDocument();
    expect(screen.getByText(/Remote-tracking branches/i)).toBeInTheDocument();
  });

  it("marks the current branch and skips it in the selection cursor", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("main", "local", true),
      branch("feat/foo", "local"),
    ]);
    render(<GitCheckoutPanel ctx={CTX} onSubmit={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("palette-git-checkout-row")).toHaveLength(2));
    const rows = screen.getAllByTestId("palette-git-checkout-row");
    // main is current → data-current true.
    expect(rows[0]).toHaveAttribute("data-current", "true");
    // feat/foo starts as data-selected because current is skipped.
    expect(rows[1]).toHaveAttribute("data-selected", "true");
  });

  it("ArrowDown / ArrowUp moves the selection cursor across selectable rows", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("main", "local", true),
      branch("feat/bar", "local"),
      branch("feat/foo", "local"),
    ]);
    // jsdom doesn't ship scrollIntoView; stub it so the effect doesn't throw.
    const scrollSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollSpy;
    try {
      const onSubmit = vi.fn();
      render(<GitCheckoutPanel ctx={CTX} onSubmit={onSubmit} />);
      await waitFor(() =>
        expect(screen.getAllByTestId("palette-git-checkout-row")).toHaveLength(3),
      );
      const filter = screen.getByTestId("palette-git-checkout-filter");
      // Initial selection is the first *selectable* row (feat/bar).
      let rows = screen.getAllByTestId("palette-git-checkout-row");
      expect(rows[1]).toHaveAttribute("data-selected", "true");
      // Down → feat/foo (2nd selectable).
      fireEvent.keyDown(filter, { key: "ArrowDown" });
      rows = screen.getAllByTestId("palette-git-checkout-row");
      expect(rows[2]).toHaveAttribute("data-selected", "true");
      expect(rows[1]).toHaveAttribute("data-selected", "false");
      // Up → back to feat/bar.
      fireEvent.keyDown(filter, { key: "ArrowUp" });
      rows = screen.getAllByTestId("palette-git-checkout-row");
      expect(rows[1]).toHaveAttribute("data-selected", "true");
      // Enter now emits the selected branch.
      fireEvent.keyDown(filter, { key: "Enter" });
      expect(onSubmit).toHaveBeenCalledWith("git checkout feat/bar");
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("typing narrows the list", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("main", "local"),
      branch("feat/bar", "local"),
      branch("feat/foo", "local"),
    ]);
    render(<GitCheckoutPanel ctx={CTX} onSubmit={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("palette-git-checkout-row")).toHaveLength(3));
    const filter = screen.getByTestId("palette-git-checkout-filter");
    fireEvent.change(filter, { target: { value: "foo" } });
    await waitFor(() => {
      const rows = screen.getAllByTestId("palette-git-checkout-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-name", "feat/foo");
    });
  });

  it("Enter on a local branch emits `git checkout <name>`", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("feat/foo", "local")]);
    const onSubmit = vi.fn();
    render(<GitCheckoutPanel ctx={CTX} onSubmit={onSubmit} />);
    await waitFor(() =>
      expect(screen.getByTestId("palette-git-checkout-filter")).toBeInTheDocument(),
    );
    fireEvent.keyDown(screen.getByTestId("palette-git-checkout-filter"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("git checkout feat/foo");
  });

  it("Enter on a remote branch emits the -b variant", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("origin/hotfix", "remote")]);
    const onSubmit = vi.fn();
    render(<GitCheckoutPanel ctx={CTX} onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getAllByTestId("palette-git-checkout-row")).toHaveLength(1));
    fireEvent.keyDown(screen.getByTestId("palette-git-checkout-filter"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("git checkout -b hotfix origin/hotfix");
  });

  it("clicking the current branch is a no-op", async () => {
    vi.mocked(gitBranches).mockResolvedValue([branch("main", "local", true)]);
    const onSubmit = vi.fn();
    render(<GitCheckoutPanel ctx={CTX} onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getAllByTestId("palette-git-checkout-row")).toHaveLength(1));
    const [row] = screen.getAllByTestId("palette-git-checkout-row");
    if (row !== undefined) fireEvent.click(row);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("surfaces IPC errors gracefully", async () => {
    vi.mocked(gitBranches).mockRejectedValue(new Error("not a git repo"));
    render(<GitCheckoutPanel ctx={CTX} onSubmit={() => {}} />);
    await waitFor(() => expect(screen.getByText(/not a git repo/i)).toBeInTheDocument());
  });
});
