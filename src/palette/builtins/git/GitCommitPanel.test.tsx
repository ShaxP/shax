import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { bodyParagraphs, buildCommitCommand, GitCommitPanel } from "./GitCommitPanel";
import type { PaneContext } from "../../registry";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return { ...actual, gitUserEmail: vi.fn() };
});

import { gitUserEmail } from "../../../lib/ipc";

const CTX: PaneContext = {
  ptyId: "pty-1",
  cwd: "/tmp/repo",
  branch: "main",
  gitRoot: "/tmp/repo",
};

beforeEach(() => {
  vi.mocked(gitUserEmail).mockReset();
});

describe("bodyParagraphs", () => {
  it("returns empty array for empty body", () => {
    expect(bodyParagraphs("")).toEqual([]);
    expect(bodyParagraphs("   \n\n  ")).toEqual([]);
  });

  it("splits on blank lines and trims", () => {
    expect(bodyParagraphs("first\n\nsecond")).toEqual(["first", "second"]);
    expect(bodyParagraphs("first\n \nsecond")).toEqual(["first", "second"]);
  });

  it("preserves single-line content", () => {
    expect(bodyParagraphs("single paragraph")).toEqual(["single paragraph"]);
  });
});

describe("buildCommitCommand", () => {
  it("subject only", () => {
    expect(buildCommitCommand("subject", "", false)).toBe("git commit -m subject");
  });

  it("adds one -m per body paragraph", () => {
    expect(buildCommitCommand("subject", "para one\n\npara two", false)).toBe(
      "git commit -m subject -m 'para one' -m 'para two'",
    );
  });

  it("appends --signoff when toggled", () => {
    expect(buildCommitCommand("subject", "", true)).toBe("git commit -m subject --signoff");
  });

  it("shell-escapes subjects with tricky chars", () => {
    expect(buildCommitCommand("fix: it's broken", "", false)).toBe(
      "git commit -m 'fix: it'\\''s broken'",
    );
  });
});

describe("GitCommitPanel", () => {
  it("shows a validation note and disables submit when subject is empty", () => {
    vi.mocked(gitUserEmail).mockResolvedValue(null);
    render(<GitCommitPanel ctx={CTX} onSubmit={() => {}} />);
    expect(screen.getByTestId("palette-git-commit-need-subject")).toBeInTheDocument();
    expect(screen.getByTestId("palette-git-commit-submit")).toBeDisabled();
  });

  it("shows the signoff toggle only when git_user_email resolves non-null", async () => {
    vi.mocked(gitUserEmail).mockResolvedValue("me@example.com");
    render(<GitCommitPanel ctx={CTX} onSubmit={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("palette-git-commit-signoff")).toBeInTheDocument(),
    );
  });

  it("hides the signoff toggle when git_user_email resolves null", async () => {
    vi.mocked(gitUserEmail).mockResolvedValue(null);
    render(<GitCommitPanel ctx={CTX} onSubmit={() => {}} />);
    // Give the effect a chance to resolve.
    await waitFor(() =>
      expect(screen.queryByTestId("palette-git-commit-signoff")).not.toBeInTheDocument(),
    );
  });

  it("Enter in the subject field submits the assembled command", () => {
    vi.mocked(gitUserEmail).mockResolvedValue(null);
    const onSubmit = vi.fn();
    render(<GitCommitPanel ctx={CTX} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId("palette-git-commit-subject"), {
      target: { value: "feat: ship it" },
    });
    fireEvent.keyDown(screen.getByTestId("palette-git-commit-subject"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("git commit -m 'feat: ship it'");
  });

  it("body paragraphs become one -m each on submit", () => {
    vi.mocked(gitUserEmail).mockResolvedValue(null);
    const onSubmit = vi.fn();
    render(<GitCommitPanel ctx={CTX} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId("palette-git-commit-subject"), {
      target: { value: "subject" },
    });
    fireEvent.change(screen.getByTestId("palette-git-commit-body"), {
      target: { value: "why\n\nwhat" },
    });
    fireEvent.click(screen.getByTestId("palette-git-commit-submit"));
    expect(onSubmit).toHaveBeenCalledWith("git commit -m subject -m why -m what");
  });
});
