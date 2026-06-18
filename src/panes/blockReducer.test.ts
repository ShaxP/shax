/**
 * Unit tests for blockReducer.
 *
 * The reducer is a pure function so these tests exercise it in isolation —
 * no rendering, no IPC, no React. Each case verifies that the returned state
 * is correct and that the previous state is never mutated.
 */

import { describe, it, expect } from "vitest";
import { blockReducer, initialBlockState } from "./blockReducer";
import type { BlockState } from "./blockReducer";
import type { BlockSummary } from "../lib/ipc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(overrides: Partial<BlockSummary> = {}): BlockSummary {
  return {
    id: "block-1",
    started_at_ms: 1000,
    ended_at_ms: null,
    exit_code: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

describe("blockReducer / seed", () => {
  it("replaces an empty block list with the provided blocks", () => {
    const blocks = [makeBlock({ id: "a" }), makeBlock({ id: "b" })];
    const next = blockReducer(initialBlockState, { type: "seed", blocks });
    expect(next.blocks).toEqual(blocks);
  });

  it("replaces an existing block list entirely", () => {
    const existing: BlockState = {
      blocks: [makeBlock({ id: "old" })],
      altScreen: false,
    };
    const fresh = [makeBlock({ id: "new" })];
    const next = blockReducer(existing, { type: "seed", blocks: fresh });
    expect(next.blocks).toEqual(fresh);
  });

  it("does not mutate the previous state", () => {
    const prev: BlockState = { blocks: [], altScreen: false };
    blockReducer(prev, { type: "seed", blocks: [makeBlock()] });
    expect(prev.blocks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// started
// ---------------------------------------------------------------------------

describe("blockReducer / started", () => {
  it("appends a new running block", () => {
    const next = blockReducer(initialBlockState, {
      type: "started",
      id: "block-abc",
      started_at_ms: 5000,
    });
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0]).toEqual({
      id: "block-abc",
      started_at_ms: 5000,
      ended_at_ms: null,
      exit_code: null,
    });
  });

  it("preserves previously recorded blocks", () => {
    const state: BlockState = {
      blocks: [makeBlock({ id: "first" })],
      altScreen: false,
    };
    const next = blockReducer(state, { type: "started", id: "second", started_at_ms: 2000 });
    expect(next.blocks).toHaveLength(2);
    const [first, second] = next.blocks;
    expect(first?.id).toBe("first");
    expect(second?.id).toBe("second");
  });

  it("does not mutate the previous state", () => {
    const prev = { ...initialBlockState };
    blockReducer(prev, { type: "started", id: "x", started_at_ms: 0 });
    expect(prev.blocks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// completed
// ---------------------------------------------------------------------------

describe("blockReducer / completed", () => {
  it("fills ended_at_ms and exit_code on the matching block", () => {
    const state: BlockState = {
      blocks: [makeBlock({ id: "target" })],
      altScreen: false,
    };
    const next = blockReducer(state, {
      type: "completed",
      id: "target",
      exit_code: 0,
      ended_at_ms: 9999,
    });
    expect(next.blocks[0]).toEqual({
      id: "target",
      started_at_ms: 1000,
      ended_at_ms: 9999,
      exit_code: 0,
    });
  });

  it("is a no-op when the block id is not found", () => {
    const state: BlockState = {
      blocks: [makeBlock({ id: "known" })],
      altScreen: false,
    };
    const next = blockReducer(state, {
      type: "completed",
      id: "unknown",
      exit_code: 1,
      ended_at_ms: 2000,
    });
    // Reference equality: no new state object because nothing changed.
    expect(next).toBe(state);
  });

  it("only updates the matching block when multiple blocks exist", () => {
    const state: BlockState = {
      blocks: [makeBlock({ id: "a" }), makeBlock({ id: "b" })],
      altScreen: false,
    };
    const next = blockReducer(state, {
      type: "completed",
      id: "b",
      exit_code: 42,
      ended_at_ms: 3000,
    });
    const [blockA, blockB] = next.blocks;
    expect(blockA?.exit_code).toBeNull();
    expect(blockB?.exit_code).toBe(42);
  });

  it("does not mutate the previous state", () => {
    const state: BlockState = {
      blocks: [makeBlock({ id: "x" })],
      altScreen: false,
    };
    const blocksBefore = state.blocks;
    blockReducer(state, { type: "completed", id: "x", exit_code: 0, ended_at_ms: 1 });
    expect(state.blocks).toBe(blocksBefore);
    const [firstBlock] = state.blocks;
    expect(firstBlock?.exit_code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// alt_screen
// ---------------------------------------------------------------------------

describe("blockReducer / alt_screen", () => {
  it("sets altScreen to true", () => {
    const next = blockReducer(initialBlockState, { type: "alt_screen", active: true });
    expect(next.altScreen).toBe(true);
  });

  it("sets altScreen to false", () => {
    const state: BlockState = { blocks: [], altScreen: true };
    const next = blockReducer(state, { type: "alt_screen", active: false });
    expect(next.altScreen).toBe(false);
  });

  it("preserves block list when toggling alt screen", () => {
    const state: BlockState = {
      blocks: [makeBlock()],
      altScreen: false,
    };
    const next = blockReducer(state, { type: "alt_screen", active: true });
    expect(next.blocks).toEqual(state.blocks);
  });
});
