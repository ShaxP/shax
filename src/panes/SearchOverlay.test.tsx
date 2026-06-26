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

vi.mock("../lib/ipc", () => ({
  searchBlocks: (...args: unknown[]): Promise<unknown[]> =>
    mockSearchBlocks(...args) as Promise<unknown[]>,
  listBranches: (...args: unknown[]): Promise<string[]> =>
    mockListBranches(...args) as Promise<string[]>,
  listCwds: (...args: unknown[]): Promise<string[]> => mockListCwds(...args) as Promise<string[]>,
  gitRootFor: (...args: unknown[]): Promise<string | null> =>
    mockGitRootFor(...args) as Promise<string | null>,
}));

afterEach(() => {
  mockSearchBlocks.mockClear();
  mockListBranches.mockClear();
  mockListCwds.mockClear();
  mockGitRootFor.mockClear();
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
