/**
 * Component tests for BlockList.
 *
 * Verifies empty state, count header, and list rendering with mixed states.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BlockList } from "./BlockList";
import { blockReducer, initialBlockState } from "./blockReducer";
import type { UiBlock } from "./blockReducer";

/**
 * jsdom doesn't run layout, so `scrollHeight` is always 0 by default.
 * Override it for the auto-scroll test so the effect's assignment is
 * observable.
 */
function withFakeScrollHeight(value: number): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => value,
  });
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", original);
    } else {
      delete (HTMLElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
    }
  };
}

afterEach(() => cleanup());

function makeBlock(overrides: Partial<UiBlock> = {}): UiBlock {
  return {
    id: "block-1",
    command: "ls",
    cwd: null,
    git_branch: null,
    started_at_ms: 1,
    ended_at_ms: 2,
    exit_code: 0,
    duration_ms: 1,
    aborted: false,
    interactive: false,
    ...overrides,
  };
}

describe("BlockList", () => {
  it("renders the empty-state hint when there are no blocks", () => {
    render(<BlockList pty={null} blocks={[]} />);
    expect(screen.getByTestId("block-list")).toBeInTheDocument();
    expect(screen.getByTestId("block-list-empty")).toBeInTheDocument();
    expect(screen.getByTestId("block-list-empty")).toHaveTextContent(/Run a command/i);
  });

  it("empty state points users at the search, assistant, and settings shortcuts (M7 slice 4)", () => {
    render(<BlockList pty={null} blocks={[]} />);
    expect(screen.getByTestId("block-list-empty-hint-search")).toHaveTextContent(/⌘F/);
    expect(screen.getByTestId("block-list-empty-hint-assistant")).toHaveTextContent(/⌘K/);
    expect(screen.getByTestId("block-list-empty-hint-settings")).toHaveTextContent(/⌘,/);
  });

  it("empty state hero has the mark glyph and a 'Ready.' heading (M7.5a)", () => {
    render(<BlockList pty={null} blocks={[]} />);
    // ShaxMark is inline SVG with role="img" and aria-label="Shax".
    expect(screen.getByRole("img", { name: /shax/i })).toBeInTheDocument();
    expect(screen.getByTestId("block-list-empty")).toHaveTextContent(/Ready\./);
    // The description emphasises "block" as the noun of the product.
    expect(screen.getByTestId("block-list-empty").querySelector("strong")?.textContent).toBe(
      "block",
    );
  });

  it("scrolls to the bottom whenever the block count changes", () => {
    const restore = withFakeScrollHeight(1000);
    try {
      const { rerender } = render(<BlockList pty="p" blocks={[]} />);
      const list = screen.getByTestId("block-list");

      // Initial mount with empty list → effect runs with scrollHeight=1000.
      expect(list.scrollTop).toBe(1000);

      // Simulate the boot-time history seed by bumping length from 0 → 3.
      // The list should snap to the bottom again.
      list.scrollTop = 0;
      rerender(
        <BlockList
          pty="p"
          blocks={[makeBlock({ id: "a" }), makeBlock({ id: "b" }), makeBlock({ id: "c" })]}
        />,
      );
      expect(list.scrollTop).toBe(1000);

      // A new live command appends a row → bottom again.
      list.scrollTop = 0;
      rerender(
        <BlockList
          pty="p"
          blocks={[
            makeBlock({ id: "a" }),
            makeBlock({ id: "b" }),
            makeBlock({ id: "c" }),
            makeBlock({ id: "live" }),
          ]}
        />,
      );
      expect(list.scrollTop).toBe(1000);
    } finally {
      restore();
    }
  });

  it("renders a row per block and shows the count in the header", () => {
    const blocks = [
      makeBlock({ id: "a", command: "ls" }),
      makeBlock({ id: "b", command: "echo no", exit_code: 1, duration_ms: 5 }),
      makeBlock({ id: "c", command: null, aborted: true, exit_code: null }),
    ];
    render(<BlockList pty="pty-1" blocks={blocks} />);
    const rows = screen.getAllByTestId("block-row");
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId("block-list").textContent).toMatch(/blocks · 3/);
  });

  /**
   * Reducer-level invariant that BlockRow's memoization relies on: when one
   * block transitions (e.g. a new running block appended, a completed event
   * filling another), the references of *untouched* BlockSummaries must
   * remain identical. React.memo can then skip re-rendering those rows,
   * which is what keeps the main thread responsive when 200 historical
   * blocks are seeded on app boot. (Regression coverage for #6 follow-up.)
   */
  it("preserves identity of untouched blocks across reducer updates", () => {
    const seed: UiBlock[] = [
      makeBlock({ id: "h1", command: "old-1" }),
      makeBlock({ id: "h2", command: "old-2" }),
      makeBlock({ id: "h3", command: "old-3" }),
    ];
    const state0 = blockReducer(initialBlockState, { type: "seed", blocks: seed });

    // A new block starts — the other three must keep their references.
    const state1 = blockReducer(state0, {
      type: "started",
      id: "live",
      command: "live cmd",
      cwd: null,
      git_branch: null,
      started_at_ms: 9000,
    });
    expect(state1.blocks[0]).toBe(state0.blocks[0]);
    expect(state1.blocks[1]).toBe(state0.blocks[1]);
    expect(state1.blocks[2]).toBe(state0.blocks[2]);

    // The live block completes — only that slot's reference changes.
    const state2 = blockReducer(state1, {
      type: "completed",
      id: "live",
      exit_code: 0,
      ended_at_ms: 9100,
      duration_ms: 100,
      aborted: false,
      cwd: null,
      git_branch: null,
      interactive: false,
    });
    expect(state2.blocks[0]).toBe(state1.blocks[0]);
    expect(state2.blocks[1]).toBe(state1.blocks[1]);
    expect(state2.blocks[2]).toBe(state1.blocks[2]);
    expect(state2.blocks[3]).not.toBe(state1.blocks[3]);
  });
});
