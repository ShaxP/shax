/**
 * Focused tests for the search overlay's slice-3.6 free-form cwd
 * glob input. The full App-level tests (App.test.tsx) drive the
 * overlay end-to-end but can't easily exercise the cwd chip — the
 * non-Tauri test env reports no cwd, so the chip is omitted there.
 * Here we render `SearchOverlay` directly with a synthetic
 * `currentCwd` so the cwd chip appears.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { SearchOverlay } from "./SearchOverlay";

const mockSearchBlocks = vi.fn().mockResolvedValue([]);
const mockListBranches = vi.fn().mockResolvedValue([]);
const mockListCwds = vi.fn().mockResolvedValue([]);
const mockGitRootFor = vi.fn().mockResolvedValue(null as string | null);
const mockSemanticSearch = vi.fn().mockResolvedValue([]);
const mockEmbeddingProgress = vi
  .fn()
  .mockResolvedValue({ indexed: 0, total: 0, model_id: "unknown" });

vi.mock("../lib/ipc", () => ({
  searchBlocks: (...args: unknown[]): Promise<unknown[]> =>
    mockSearchBlocks(...args) as Promise<unknown[]>,
  listBranches: (...args: unknown[]): Promise<string[]> =>
    mockListBranches(...args) as Promise<string[]>,
  listCwds: (...args: unknown[]): Promise<string[]> => mockListCwds(...args) as Promise<string[]>,
  gitRootFor: (...args: unknown[]): Promise<string | null> =>
    mockGitRootFor(...args) as Promise<string | null>,
  semanticSearch: (...args: unknown[]): Promise<unknown[]> =>
    mockSemanticSearch(...args) as Promise<unknown[]>,
  embeddingProgress: (): Promise<unknown> => mockEmbeddingProgress() as Promise<unknown>,
}));

afterEach(() => {
  mockSearchBlocks.mockClear();
  mockListBranches.mockClear();
  mockListCwds.mockClear();
  mockGitRootFor.mockClear();
  mockSemanticSearch.mockClear();
  mockEmbeddingProgress.mockClear();
});

function openCwdPopover(): void {
  fireEvent.click(screen.getByTestId("search-chip-cwd"));
}

describe("SearchOverlay — cwd glob input (slice 3.6)", () => {
  it("renders the glob input at the bottom of the cwd dropdown", () => {
    render(
      <SearchOverlay
        onClose={() => undefined}
        onSelect={() => undefined}
        currentCwd="/Users/me/dev/shax"
      />,
    );
    openCwdPopover();
    expect(screen.getByTestId("search-chip-cwd-popover-footer")).toBeTruthy();
    expect(screen.getByTestId("search-chip-cwd-glob-input")).toBeTruthy();
  });

  it("commits a glob to searchBlocks on Enter", async () => {
    render(
      <SearchOverlay
        onClose={() => undefined}
        onSelect={() => undefined}
        currentCwd="/Users/me/dev/shax"
      />,
    );
    openCwdPopover();
    const input = screen.getByTestId("search-chip-cwd-glob-input");
    fireEvent.change(input, { target: { value: "~/dev/*-server" } });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    // Searching with an empty query + active filter takes the
    // browse-by-filter path on the backend, but the frontend still
    // dispatches `searchBlocks` with the resolved cwd_glob.
    await vi.waitFor(() => {
      const lastCall = mockSearchBlocks.mock.calls[mockSearchBlocks.mock.calls.length - 1];
      expect(lastCall).toBeDefined();
      const opts = lastCall?.[0] as { cwd_glob?: string };
      expect(opts.cwd_glob).toBe("~/dev/*-server");
    });
  });

  it("shows the active glob as a `Path · …` option in the popover", () => {
    render(
      <SearchOverlay
        onClose={() => undefined}
        onSelect={() => undefined}
        currentCwd="/Users/me/dev/shax"
      />,
    );
    openCwdPopover();
    const input = screen.getByTestId("search-chip-cwd-glob-input");
    fireEvent.change(input, { target: { value: "~/dev/*-server" } });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    // Reopen the popover (the commit closes it).
    openCwdPopover();
    const pathOption = screen.getByTestId("search-chip-cwd-option-glob");
    expect(pathOption.textContent).toContain("Path · ~/dev/*-server");
  });

  it("clearing the glob via empty Enter resets the chip to inactive", async () => {
    render(
      <SearchOverlay
        onClose={() => undefined}
        onSelect={() => undefined}
        currentCwd="/Users/me/dev/shax"
      />,
    );
    openCwdPopover();
    const input = screen.getByTestId("search-chip-cwd-glob-input");
    fireEvent.change(input, { target: { value: "~/dev/*-server" } });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    // Chip now reads as active (key !== neutral).
    expect(screen.getByTestId("search-chip-cwd")).toHaveAttribute("data-active", "true");
    // Reopen, clear the input, commit again with empty value.
    openCwdPopover();
    const reopenedInput = screen.getByTestId("search-chip-cwd-glob-input");
    fireEvent.change(reopenedInput, { target: { value: "" } });
    act(() => {
      fireEvent.keyDown(reopenedInput, { key: "Enter" });
    });
    // Chip is back to neutral (no filter).
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-chip-cwd")).toHaveAttribute("data-active", "false");
    });
  });
});

// ---------------------------------------------------------------------------
// M7 slice 3 — semantic tier + progress pill
// ---------------------------------------------------------------------------

function makeBlock(id: string, command: string): unknown {
  return {
    id,
    command,
    cwd: "/tmp",
    git_branch: null,
    started_at_ms: 1_700_000_000_000,
    ended_at_ms: 1_700_000_001_000,
    exit_code: 0,
    duration_ms: 1000,
    aborted: false,
    interactive: false,
  };
}

function makeSemanticHit(id: string, command: string, similarity: number): unknown {
  return { block: makeBlock(id, command), pane_id: "pane-1", similarity };
}

function makeLiteralHit(id: string, command: string): unknown {
  return { block: makeBlock(id, command), pane_id: "pane-1", snippet: null };
}

async function typeQuery(value: string): Promise<void> {
  const input = screen.getByTestId("search-input");
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    // The overlay debounces at 150 ms; advance real timers by
    // waiting past that plus a small buffer.
    await new Promise((r) => setTimeout(r, 200));
  });
}

describe("SearchOverlay — semantic tier (M7 slice 3)", () => {
  it("renders literal + semantic sections when both fire", async () => {
    mockSearchBlocks.mockResolvedValueOnce([makeLiteralHit("b1", "git status")]);
    mockSemanticSearch.mockResolvedValueOnce([
      makeSemanticHit("b2", "git branch -a", 0.72),
      makeSemanticHit("b3", "git log --oneline", 0.65),
    ]);
    mockEmbeddingProgress.mockResolvedValue({
      indexed: 40,
      total: 100,
      model_id: "all-MiniLM-L6-v2-onnx-q",
    });
    render(<SearchOverlay onClose={() => undefined} onSelect={() => undefined} />);
    await typeQuery("git");
    expect(screen.getByTestId("search-section-literal")).toBeTruthy();
    expect(screen.getByTestId("search-section-semantic")).toBeTruthy();
    expect(screen.getAllByTestId("search-result-semantic")).toHaveLength(2);
    // Similarity readout appears on each semantic row.
    expect(screen.getAllByTestId("search-result-similarity")[0]?.textContent).toContain("~0.72");
  });

  it("shows the indexed progress pill from embedding_progress", async () => {
    mockEmbeddingProgress.mockResolvedValue({
      indexed: 40,
      total: 100,
      model_id: "all-MiniLM-L6-v2-onnx-q",
    });
    render(<SearchOverlay onClose={() => undefined} onSelect={() => undefined} />);
    await vi.waitFor(() => {
      const pill = screen.getByTestId("search-embedding-progress");
      expect(pill.textContent).toContain("40/100 indexed");
    });
  });

  it("renders unavailable copy when the model_id is a mock fallback", async () => {
    mockEmbeddingProgress.mockResolvedValue({
      indexed: 0,
      total: 12,
      model_id: "mock-hash-v1",
    });
    render(<SearchOverlay onClose={() => undefined} onSelect={() => undefined} />);
    await typeQuery("anything");
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-semantic-unavailable")).toBeTruthy();
    });
    // No semantic result rows are rendered when unavailable.
    expect(screen.queryAllByTestId("search-result-semantic")).toHaveLength(0);
  });

  it("arrow keys walk across the section boundary into semantic hits", async () => {
    mockSearchBlocks.mockResolvedValueOnce([makeLiteralHit("b1", "git status")]);
    mockSemanticSearch.mockResolvedValueOnce([makeSemanticHit("b2", "git branch", 0.7)]);
    mockEmbeddingProgress.mockResolvedValue({
      indexed: 10,
      total: 10,
      model_id: "all-MiniLM-L6-v2-onnx-q",
    });
    const captured: string[] = [];
    render(
      <SearchOverlay
        onClose={() => undefined}
        onSelect={(hit) => {
          captured.push(hit.block.id);
        }}
      />,
    );
    await typeQuery("git");
    // Down once → onto the semantic hit (literal was auto-selected as index 0).
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(window, { key: "Enter" });
    });
    expect(captured).toEqual(["b2"]);
  });

  it("skips the semantic call for an empty query", async () => {
    mockEmbeddingProgress.mockResolvedValue({
      indexed: 0,
      total: 0,
      model_id: "all-MiniLM-L6-v2-onnx-q",
    });
    render(<SearchOverlay onClose={() => undefined} onSelect={() => undefined} />);
    // No typing → semanticSearch never gets called.
    await new Promise((r) => setTimeout(r, 250));
    expect(mockSemanticSearch).not.toHaveBeenCalled();
    // And no semantic section shows up.
    expect(screen.queryByTestId("search-section-semantic")).toBeNull();
  });
});
