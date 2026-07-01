import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import { GitDiffWidget } from "./GitDiffWidget";
import type { ParsedDiff } from "../../formatters/parseGitDiff";

function mkDiff(files: ParsedDiff["files"]): ParsedDiff {
  return { files };
}

function mkFile(overrides: Partial<ParsedDiff["files"][number]>): ParsedDiff["files"][number] {
  return {
    path: "a.ts",
    oldPath: "a.ts",
    binary: false,
    op: null,
    hunks: [],
    ...overrides,
  };
}

function mkLine(
  overrides: Partial<ParsedDiff["files"][number]["hunks"][number]["lines"][number]>,
): ParsedDiff["files"][number]["hunks"][number]["lines"][number] {
  return {
    kind: "context",
    oldLine: 1,
    newLine: 1,
    text: "",
    ...overrides,
  };
}

describe("GitDiffWidget", () => {
  it("renders an empty state when the diff has no files", () => {
    render(<GitDiffWidget parsed={mkDiff([])} />);
    expect(screen.getByTestId("widget-git-diff")).toHaveTextContent("No changes.");
  });

  it("renders one card per file with add/del stats in the header", () => {
    const parsed = mkDiff([
      mkFile({
        path: "src/a.ts",
        hunks: [
          {
            header: "@@ -1,3 +1,3 @@",
            oldStart: 1,
            newStart: 1,
            lines: [
              mkLine({ kind: "context", text: " ok" }),
              mkLine({ kind: "del", text: "old", newLine: null }),
              mkLine({ kind: "add", text: "new", oldLine: null }),
            ],
          },
        ],
      }),
    ]);
    render(<GitDiffWidget parsed={parsed} />);
    const files = screen.getAllByTestId("widget-git-diff-file");
    expect(files).toHaveLength(1);
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error("expected a file to render");
    expect(within(firstFile).getByTestId("widget-git-diff-file-added")).toHaveTextContent("+1");
    expect(within(firstFile).getByTestId("widget-git-diff-file-deleted")).toHaveTextContent("−1");
  });

  it("expands small diffs by default (<=4 files)", () => {
    const parsed = mkDiff([
      mkFile({ path: "a.ts", hunks: [] }),
      mkFile({ path: "b.ts", hunks: [] }),
    ]);
    render(<GitDiffWidget parsed={parsed} />);
    for (const el of screen.getAllByTestId("widget-git-diff-file")) {
      expect(el).toHaveAttribute("data-collapsed", "false");
    }
  });

  it("collapses larger diffs by default (>4 files)", () => {
    const files = Array.from({ length: 5 }, (_, i) => mkFile({ path: `f${i}.ts`, hunks: [] }));
    render(<GitDiffWidget parsed={mkDiff(files)} />);
    for (const el of screen.getAllByTestId("widget-git-diff-file")) {
      expect(el).toHaveAttribute("data-collapsed", "true");
    }
  });

  it("clicking a file header toggles collapse", () => {
    const parsed = mkDiff([mkFile({ path: "a.ts", hunks: [] })]);
    render(<GitDiffWidget parsed={parsed} />);
    const file = screen.getByTestId("widget-git-diff-file");
    expect(file).toHaveAttribute("data-collapsed", "false");
    fireEvent.click(screen.getByTestId("widget-git-diff-file-header"));
    expect(file).toHaveAttribute("data-collapsed", "true");
    fireEvent.click(screen.getByTestId("widget-git-diff-file-header"));
    expect(file).toHaveAttribute("data-collapsed", "false");
  });

  it("view toggle switches between inline and side-by-side rendering", () => {
    const parsed = mkDiff([
      mkFile({
        path: "a.ts",
        hunks: [
          {
            header: "@@ -1,2 +1,2 @@",
            oldStart: 1,
            newStart: 1,
            lines: [
              mkLine({ kind: "del", text: "x", newLine: null }),
              mkLine({ kind: "add", text: "X", oldLine: null }),
            ],
          },
        ],
      }),
    ]);
    render(<GitDiffWidget parsed={parsed} />);
    // Default is inline.
    expect(screen.queryByTestId("widget-git-diff-line-pair")).toBeNull();
    expect(screen.getAllByTestId("widget-git-diff-line")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("widget-git-diff-view-side-by-side"));
    expect(screen.queryAllByTestId("widget-git-diff-line-pair")).toHaveLength(1);
  });

  it("toggles side-by-side when the block-action event fires for its enclosing block", () => {
    const parsed = mkDiff([
      mkFile({
        path: "a.ts",
        hunks: [
          {
            header: "@@ -1,1 +1,1 @@",
            oldStart: 1,
            newStart: 1,
            lines: [
              mkLine({ kind: "del", text: "x", newLine: null }),
              mkLine({ kind: "add", text: "X", oldLine: null }),
            ],
          },
        ],
      }),
    ]);
    // Wrap the widget in a mock BlockRow with data-block-id so
    // the event filter has a target to match.
    render(
      <div data-block-id="block-42">
        <GitDiffWidget parsed={parsed} />
      </div>,
    );
    expect(screen.queryByTestId("widget-git-diff-line-pair")).toBeNull();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-action", {
          detail: { pty: "pty-1", blockId: "block-42", kind: "toggle-side-by-side" },
        }),
      );
    });
    expect(screen.queryAllByTestId("widget-git-diff-line-pair")).toHaveLength(1);
    // Second dispatch toggles back.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-action", {
          detail: { pty: "pty-1", blockId: "block-42", kind: "toggle-side-by-side" },
        }),
      );
    });
    expect(screen.queryByTestId("widget-git-diff-line-pair")).toBeNull();
  });

  it("ignores side-by-side events targeted at a different block", () => {
    const parsed = mkDiff([mkFile({ path: "a.ts", hunks: [] })]);
    render(
      <div data-block-id="block-42">
        <GitDiffWidget parsed={parsed} />
      </div>,
    );
    window.dispatchEvent(
      new CustomEvent("shax:block-action", {
        detail: { pty: "pty-1", blockId: "block-99", kind: "toggle-side-by-side" },
      }),
    );
    // Still inline (default).
    expect(screen.getByTestId("widget-git-diff-view-inline").getAttribute("data-testid")).toBe(
      "widget-git-diff-view-inline",
    );
  });

  it("shows a note on binary files instead of hunks", () => {
    const parsed = mkDiff([mkFile({ path: "logo.png", binary: true, hunks: [] })]);
    render(<GitDiffWidget parsed={parsed} />);
    expect(screen.getByTestId("widget-git-diff")).toHaveTextContent("Binary file");
  });

  it("labels the op with a badge (NEW / DEL / REN / …)", () => {
    const parsed = mkDiff([
      mkFile({ path: "new.ts", op: "new", hunks: [] }),
      mkFile({ path: "gone.ts", oldPath: "gone.ts", op: "deleted", hunks: [] }),
      mkFile({ path: "to.ts", oldPath: "from.ts", op: "renamed", hunks: [] }),
    ]);
    render(<GitDiffWidget parsed={parsed} />);
    const files = screen.getAllByTestId("widget-git-diff-file");
    expect(files[0]).toHaveTextContent("NEW");
    expect(files[1]).toHaveTextContent("DEL");
    expect(files[2]).toHaveTextContent("REN");
    // Rename shows `oldPath → newPath` in the label.
    expect(files[2]).toHaveTextContent("from.ts → to.ts");
  });
});
