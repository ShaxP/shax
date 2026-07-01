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

  it("expand-all / collapse-all button flips every file", () => {
    // 5 files → all collapsed by default.
    const files = Array.from({ length: 5 }, (_, i) => mkFile({ path: `f${i}.ts`, hunks: [] }));
    render(<GitDiffWidget parsed={mkDiff(files)} />);
    // Label reads EXPAND ALL when everything is collapsed.
    expect(screen.getByTestId("widget-git-diff-expand-toggle")).toHaveTextContent("EXPAND ALL");
    fireEvent.click(screen.getByTestId("widget-git-diff-expand-toggle"));
    for (const el of screen.getAllByTestId("widget-git-diff-file")) {
      expect(el).toHaveAttribute("data-collapsed", "false");
    }
    // Now reads COLLAPSE ALL.
    expect(screen.getByTestId("widget-git-diff-expand-toggle")).toHaveTextContent("COLLAPSE ALL");
    fireEvent.click(screen.getByTestId("widget-git-diff-expand-toggle"));
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

  it("widget-nav down / up walks the file focus", () => {
    const parsed = mkDiff([
      mkFile({ path: "a.ts", hunks: [] }),
      mkFile({ path: "b.ts", hunks: [] }),
      mkFile({ path: "c.ts", hunks: [] }),
    ]);
    render(
      <div data-block-id="block-42">
        <GitDiffWidget parsed={parsed} />
      </div>,
    );
    const send = (direction: "up" | "down" | "left" | "right") => {
      const detail: { blockId: string; direction: typeof direction; claimed: boolean } = {
        blockId: "block-42",
        direction,
        claimed: false,
      };
      act(() => {
        window.dispatchEvent(new CustomEvent("shax:widget-nav", { detail }));
      });
      return detail.claimed;
    };
    // Initial: no focus.
    for (const f of screen.getAllByTestId("widget-git-diff-file"))
      expect(f).toHaveAttribute("data-focused", "false");
    // First down claims + moves to file 0.
    expect(send("down")).toBe(true);
    let files = screen.getAllByTestId("widget-git-diff-file");
    expect(files[0]).toHaveAttribute("data-focused", "true");
    expect(send("down")).toBe(true);
    files = screen.getAllByTestId("widget-git-diff-file");
    expect(files[1]).toHaveAttribute("data-focused", "true");
    expect(send("down")).toBe(true);
    files = screen.getAllByTestId("widget-git-diff-file");
    expect(files[2]).toHaveAttribute("data-focused", "true");
    // Past the last file — don't claim so the shell can advance to
    // the next block.
    expect(send("down")).toBe(false);
    files = screen.getAllByTestId("widget-git-diff-file");
    expect(files[2]).toHaveAttribute("data-focused", "true");
    // Up walks back.
    expect(send("up")).toBe(true);
    files = screen.getAllByTestId("widget-git-diff-file");
    expect(files[1]).toHaveAttribute("data-focused", "true");
    expect(send("up")).toBe(true);
    files = screen.getAllByTestId("widget-git-diff-file");
    expect(files[0]).toHaveAttribute("data-focused", "true");
    // Up past the first — don't claim.
    expect(send("up")).toBe(false);
  });

  it("widget-nav left / right collapses and expands the focused file", () => {
    const parsed = mkDiff([mkFile({ path: "a.ts", hunks: [] })]);
    render(
      <div data-block-id="block-42">
        <GitDiffWidget parsed={parsed} />
      </div>,
    );
    const send = (direction: "up" | "down" | "left" | "right") => {
      const detail: { blockId: string; direction: typeof direction; claimed: boolean } = {
        blockId: "block-42",
        direction,
        claimed: false,
      };
      act(() => {
        window.dispatchEvent(new CustomEvent("shax:widget-nav", { detail }));
      });
      return detail.claimed;
    };
    // No focus yet → left / right don't claim.
    expect(send("left")).toBe(false);
    expect(send("right")).toBe(false);
    // Give focus to file 0.
    send("down");
    // Left collapses.
    expect(send("left")).toBe(true);
    expect(screen.getByTestId("widget-git-diff-file")).toHaveAttribute("data-collapsed", "true");
    // Right expands.
    expect(send("right")).toBe(true);
    expect(screen.getByTestId("widget-git-diff-file")).toHaveAttribute("data-collapsed", "false");
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
