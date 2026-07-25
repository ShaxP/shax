import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { buildRebaseCommand, GitRebasePanel } from "./GitRebasePanel";
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
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("buildRebaseCommand", () => {
  it("plain rebase onto target", () => {
    expect(buildRebaseCommand("main", false)).toBe("git rebase main");
  });

  it("interactive when toggle on", () => {
    expect(buildRebaseCommand("main", true)).toBe("git rebase -i main");
  });

  it("shell-escapes target names with slashes / special chars", () => {
    expect(buildRebaseCommand("origin/feat/foo", false)).toBe("git rebase origin/feat/foo");
    expect(buildRebaseCommand("with space", true)).toBe("git rebase -i 'with space'");
  });
});

describe("GitRebasePanel", () => {
  it("lists both local and remote branches (rebase target can be either)", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("main", "local", true),
      branch("feat/foo", "local"),
      branch("origin/main", "remote"),
    ]);
    render(<GitRebasePanel ctx={CTX} onSubmit={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("palette-git-rebase-row")).toHaveLength(3));
  });

  it("Enter emits `git rebase <target>` with the -i variant toggled", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("main", "local", true),
      branch("feat/foo", "local"),
    ]);
    const onSubmit = vi.fn();
    render(<GitRebasePanel ctx={CTX} onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getAllByTestId("palette-git-rebase-row")).toHaveLength(2));
    // Initial selection is index 0 = main. Enter → git rebase main.
    fireEvent.keyDown(screen.getByTestId("palette-git-rebase-filter"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("git rebase main");
    onSubmit.mockClear();
    // Toggle -i then Enter → git rebase -i main.
    fireEvent.click(screen.getByTestId("palette-git-rebase-interactive"));
    fireEvent.keyDown(screen.getByTestId("palette-git-rebase-filter"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("git rebase -i main");
  });

  it("preview updates live as selection + -i toggle change", async () => {
    vi.mocked(gitBranches).mockResolvedValue([
      branch("main", "local"),
      branch("feat/foo", "local"),
    ]);
    render(<GitRebasePanel ctx={CTX} onSubmit={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("palette-git-rebase-row")).toHaveLength(2));
    expect(screen.getByTestId("palette-git-rebase-preview")).toHaveTextContent("git rebase main");
    fireEvent.keyDown(screen.getByTestId("palette-git-rebase-filter"), { key: "ArrowDown" });
    expect(screen.getByTestId("palette-git-rebase-preview")).toHaveTextContent(
      "git rebase feat/foo",
    );
    fireEvent.click(screen.getByTestId("palette-git-rebase-interactive"));
    expect(screen.getByTestId("palette-git-rebase-preview")).toHaveTextContent(
      "git rebase -i feat/foo",
    );
  });

  it("surfaces IPC errors gracefully", async () => {
    vi.mocked(gitBranches).mockRejectedValue(new Error("not a git repo"));
    render(<GitRebasePanel ctx={CTX} onSubmit={() => {}} />);
    await waitFor(() => expect(screen.getByText(/not a git repo/i)).toBeInTheDocument());
  });
});
