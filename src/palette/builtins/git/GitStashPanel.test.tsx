import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { buildStashCommand, GitStashPanel } from "./GitStashPanel";
import type { PaneContext } from "../../registry";

const CTX: PaneContext = {
  ptyId: "pty-1",
  cwd: "/tmp/repo",
  branch: "main",
  gitRoot: "/tmp/repo",
};

describe("buildStashCommand", () => {
  it("bare `git stash push` when message empty and no flags", () => {
    expect(buildStashCommand("", false, false)).toBe("git stash push");
  });

  it("adds -m when message is non-empty", () => {
    expect(buildStashCommand("wip: refactor", false, false)).toBe(
      "git stash push -m 'wip: refactor'",
    );
  });

  it("trims whitespace-only message", () => {
    expect(buildStashCommand("   ", false, false)).toBe("git stash push");
  });

  it("appends --keep-index when toggled", () => {
    expect(buildStashCommand("x", true, false)).toBe("git stash push -m x --keep-index");
  });

  it("appends --include-untracked when toggled", () => {
    expect(buildStashCommand("", false, true)).toBe("git stash push --include-untracked");
  });

  it("shell-escapes tricky characters in the message", () => {
    expect(buildStashCommand("it's tricky", false, false)).toBe(
      "git stash push -m 'it'\\''s tricky'",
    );
  });
});

describe("GitStashPanel", () => {
  it("renders with an empty message and default preview", () => {
    render(<GitStashPanel ctx={CTX} onSubmit={() => {}} />);
    expect(screen.getByTestId("palette-git-stash-preview")).toHaveTextContent("git stash push");
  });

  it("live-updates the preview as the user types + toggles", () => {
    render(<GitStashPanel ctx={CTX} onSubmit={() => {}} />);
    fireEvent.change(screen.getByTestId("palette-git-stash-message"), {
      target: { value: "wip" },
    });
    fireEvent.click(screen.getByTestId("palette-git-stash-include-untracked"));
    expect(screen.getByTestId("palette-git-stash-preview")).toHaveTextContent(
      "git stash push -m wip --include-untracked",
    );
  });

  it("Enter in the message field submits the assembled command", () => {
    const onSubmit = vi.fn();
    render(<GitStashPanel ctx={CTX} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId("palette-git-stash-message"), {
      target: { value: "quick save" },
    });
    fireEvent.keyDown(screen.getByTestId("palette-git-stash-message"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("git stash push -m 'quick save'");
  });

  it("clicking Stash submits", () => {
    const onSubmit = vi.fn();
    render(<GitStashPanel ctx={CTX} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId("palette-git-stash-submit"));
    expect(onSubmit).toHaveBeenCalledWith("git stash push");
  });
});
