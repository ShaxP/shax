/**
 * Tests for the block viewer modal (M4 slice 4.1).
 *
 * The CodeMirror editor itself is rendered by `Viewer`. We don't
 * exercise vim navigation or syntax highlighting here — those are
 * CodeMirror's tests, and jsdom doesn't lay out the editor anyway.
 * Coverage targets: the modal lifecycle (open, close, Esc),
 * the bytes-fetch path (live pane vs. historical), and the title.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { shellTokenize } from "../lib/shellTokenize";
import { BlockViewerModal } from "./BlockViewerModal";

const mockGetBlockOutput = vi.fn().mockResolvedValue(new Uint8Array());
const mockBlockGetOutput = vi.fn().mockResolvedValue(new Uint8Array());
const mockReadFileBytes = vi.fn().mockRejectedValue(new Error("ENOENT"));
const mockReadDirEntries = vi.fn().mockResolvedValue([]);
const mockGitStatusPorcelain = vi.fn().mockResolvedValue("");
const mockGitDiff = vi.fn().mockResolvedValue("");

vi.mock("../lib/ipc", () => ({
  getBlockOutput: (...args: unknown[]): Promise<Uint8Array> =>
    mockGetBlockOutput(...args) as Promise<Uint8Array>,
  blockGetOutput: (...args: unknown[]): Promise<Uint8Array> =>
    mockBlockGetOutput(...args) as Promise<Uint8Array>,
  readFileBytes: (...args: unknown[]): Promise<Uint8Array> =>
    mockReadFileBytes(...args) as Promise<Uint8Array>,
  readDirEntries: (...args: unknown[]): Promise<unknown[]> =>
    mockReadDirEntries(...args) as Promise<unknown[]>,
  gitStatusPorcelain: (...args: unknown[]): Promise<string> =>
    mockGitStatusPorcelain(...args) as Promise<string>,
  gitDiff: (...args: unknown[]): Promise<string> => mockGitDiff(...args) as Promise<string>,
}));

afterEach(() => {
  mockGetBlockOutput.mockClear();
  mockBlockGetOutput.mockClear();
  mockReadFileBytes.mockClear();
  mockReadDirEntries.mockClear();
  mockGitStatusPorcelain.mockClear();
  mockGitDiff.mockClear();
});

function makeBlock(overrides: Partial<{ id: string; command: string }> = {}): {
  id: string;
  command: string;
  cwd: null;
  git_branch: null;
  started_at_ms: number;
  ended_at_ms: number;
  exit_code: number;
  duration_ms: number;
  aborted: boolean;
  interactive: boolean;
} {
  return {
    id: overrides.id ?? "blk-1",
    command: overrides.command ?? "cat README.md",
    cwd: null,
    git_branch: null,
    started_at_ms: 1700000000000,
    ended_at_ms: 1700000000100,
    exit_code: 0,
    duration_ms: 100,
    aborted: false,
    interactive: false,
  };
}

describe("BlockViewerModal", () => {
  it("renders the command line in the header", () => {
    render(<BlockViewerModal block={makeBlock()} pty="pty-1" onClose={() => undefined} />);
    expect(screen.getByTestId("block-viewer-title")).toHaveTextContent("cat README.md");
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<BlockViewerModal block={makeBlock()} pty="pty-1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId("block-viewer-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Esc", () => {
    const onClose = vi.fn();
    render(<BlockViewerModal block={makeBlock()} pty="pty-1" onClose={onClose} />);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<BlockViewerModal block={makeBlock()} pty="pty-1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId("block-viewer-modal"));
    expect(onClose).toHaveBeenCalled();
  });

  it("uses getBlockOutput(pty, id) when pty is non-null", () => {
    render(<BlockViewerModal block={makeBlock()} pty="pty-7" onClose={() => undefined} />);
    expect(mockGetBlockOutput).toHaveBeenCalledWith("pty-7", "blk-1");
    expect(mockBlockGetOutput).not.toHaveBeenCalled();
  });

  it("falls back to blockGetOutput(id) when pty is null", () => {
    render(<BlockViewerModal block={makeBlock()} pty={null} onClose={() => undefined} />);
    expect(mockBlockGetOutput).toHaveBeenCalledWith("blk-1");
    expect(mockGetBlockOutput).not.toHaveBeenCalled();
  });

  it("shows a loading state until the bytes arrive", () => {
    // Hold the promise open so the fetch never resolves.
    mockGetBlockOutput.mockReturnValueOnce(new Promise<Uint8Array>(() => undefined));
    render(<BlockViewerModal block={makeBlock()} pty="pty-1" onClose={() => undefined} />);
    expect(screen.getByTestId("block-viewer-loading")).toBeInTheDocument();
  });

  it("does not show a FMT/RAW toggle for blocks without a formatter", async () => {
    // `echo hi` has no formatter; the toggle should not appear.
    mockGetBlockOutput.mockResolvedValueOnce(new TextEncoder().encode("hi\n"));
    render(
      <BlockViewerModal
        block={makeBlock({ command: "echo hi" })}
        pty="pty-1"
        onClose={() => undefined}
      />,
    );
    // Wait a microtask for the bytes-fetch effect to resolve.
    await act(() => Promise.resolve());
    expect(screen.queryByTestId("block-viewer-fmt-raw")).toBeNull();
  });

  it("shows the FMT/RAW toggle for cat blocks (now content-aware in the modal)", async () => {
    // M4.5 slice 1 flipped cat to `useInModal: true` — the
    // formatter now drives the modal's render through the
    // shared ContentView. The user gets FMT/SRC/RAW per the
    // lens system instead of the modal's old hard-coded
    // content-type routing.
    mockGetBlockOutput.mockResolvedValueOnce(new TextEncoder().encode("# title\n"));
    render(
      <BlockViewerModal
        block={makeBlock({ command: "cat README.md" })}
        pty="pty-1"
        onClose={() => undefined}
      />,
    );
    await act(() => Promise.resolve());
    expect(screen.queryByTestId("block-viewer-fmt-raw")).toBeInTheDocument();
  });

  it("shows the FMT/RAW toggle and renders the formatter for ls blocks", async () => {
    mockGetBlockOutput.mockResolvedValueOnce(new TextEncoder().encode("a\nb\n"));
    render(
      <BlockViewerModal
        block={{ ...makeBlock({ command: "ls" }), cwd: "/tmp" }}
        pty="pty-1"
        onClose={() => undefined}
      />,
    );
    // Resolve the bytes fetch.
    await act(() => Promise.resolve());
    // The toggle is visible…
    expect(screen.getByTestId("block-viewer-fmt-raw")).toBeInTheDocument();
    // …and FMT is the default selection.
    expect(screen.getByTestId("block-viewer-fmt-pill")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("block-viewer-raw-pill")).toHaveAttribute("data-active", "false");
  });

  it("swaps to RAW when the user clicks the RAW pill", async () => {
    mockGetBlockOutput.mockResolvedValueOnce(new TextEncoder().encode("a\nb\n"));
    render(
      <BlockViewerModal
        block={{ ...makeBlock({ command: "ls" }), cwd: "/tmp" }}
        pty="pty-1"
        onClose={() => undefined}
      />,
    );
    await act(() => Promise.resolve());
    fireEvent.click(screen.getByTestId("block-viewer-raw-pill"));
    expect(screen.getByTestId("block-viewer-raw-pill")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("block-viewer-fmt-pill")).toHaveAttribute("data-active", "false");
    // The formatter wrapper goes away in RAW mode.
    expect(screen.queryByTestId("block-viewer-formatter")).toBeNull();
  });
});

describe("shellTokenize (used by the modal to extract argv)", () => {
  const tokenize = shellTokenize;

  it("splits on plain whitespace", () => {
    expect(tokenize("cat README.md")).toEqual(["cat", "README.md"]);
    expect(tokenize("bat --paging=never src/lib.rs")).toEqual([
      "bat",
      "--paging=never",
      "src/lib.rs",
    ]);
  });

  it("honours backslash-escaped spaces (the GIF-with-spaces bug)", () => {
    expect(tokenize("cat Chainsaw\\ Man\\ GIF.gif")).toEqual(["cat", "Chainsaw Man GIF.gif"]);
  });

  it("honours single-quoted strings (no escapes inside)", () => {
    expect(tokenize("cat 'foo bar.txt'")).toEqual(["cat", "foo bar.txt"]);
    expect(tokenize("cat 'foo\\nbar.txt'")).toEqual(["cat", "foo\\nbar.txt"]);
  });

  it("honours double-quoted strings (with escape for the closer)", () => {
    expect(tokenize('cat "foo bar.txt"')).toEqual(["cat", "foo bar.txt"]);
    expect(tokenize('cat "say \\"hi\\".txt"')).toEqual(["cat", 'say "hi".txt']);
  });

  it("handles empty / null / whitespace-only inputs", () => {
    expect(tokenize(null)).toEqual([]);
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});
