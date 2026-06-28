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
import { BlockViewerModal, __testing } from "./BlockViewerModal";

const mockGetBlockOutput = vi.fn().mockResolvedValue(new Uint8Array());
const mockBlockGetOutput = vi.fn().mockResolvedValue(new Uint8Array());

vi.mock("../lib/ipc", () => ({
  getBlockOutput: (...args: unknown[]): Promise<Uint8Array> =>
    mockGetBlockOutput(...args) as Promise<Uint8Array>,
  blockGetOutput: (...args: unknown[]): Promise<Uint8Array> =>
    mockBlockGetOutput(...args) as Promise<Uint8Array>,
}));

afterEach(() => {
  mockGetBlockOutput.mockClear();
  mockBlockGetOutput.mockClear();
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
});

describe("BlockViewerModal · tokenizeCommand", () => {
  const tokenize = __testing.tokenizeCommand;

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
