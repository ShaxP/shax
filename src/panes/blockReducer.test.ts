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
    command: null,
    cwd: null,
    git_branch: null,
    started_at_ms: 1000,
    ended_at_ms: null,
    exit_code: null,
    duration_ms: null,
    aborted: false,
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

  it("preserves aborted blocks supplied in the seed", () => {
    const blocks = [makeBlock({ id: "x", aborted: true })];
    const next = blockReducer(initialBlockState, { type: "seed", blocks });
    expect(next.blocks[0]?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// started
// ---------------------------------------------------------------------------

describe("blockReducer / started", () => {
  it("appends a new running block with command, cwd, and git_branch", () => {
    const next = blockReducer(initialBlockState, {
      type: "started",
      id: "block-abc",
      command: "echo hi",
      cwd: "/Users/me/repo",
      git_branch: "main",
      started_at_ms: 5000,
    });
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0]).toEqual({
      id: "block-abc",
      command: "echo hi",
      cwd: "/Users/me/repo",
      git_branch: "main",
      started_at_ms: 5000,
      ended_at_ms: null,
      exit_code: null,
      duration_ms: null,
      aborted: false,
    });
  });

  it("accepts a null command, cwd, and git_branch when integration didn't report them", () => {
    const next = blockReducer(initialBlockState, {
      type: "started",
      id: "no-cmd",
      command: null,
      cwd: null,
      git_branch: null,
      started_at_ms: 1,
    });
    expect(next.blocks[0]?.command).toBeNull();
    expect(next.blocks[0]?.cwd).toBeNull();
    expect(next.blocks[0]?.git_branch).toBeNull();
  });

  it("preserves previously recorded blocks", () => {
    const state: BlockState = {
      blocks: [makeBlock({ id: "first" })],
      altScreen: false,
    };
    const next = blockReducer(state, {
      type: "started",
      id: "second",
      command: null,
      cwd: null,
      git_branch: null,
      started_at_ms: 2000,
    });
    expect(next.blocks).toHaveLength(2);
    const [first, second] = next.blocks;
    expect(first?.id).toBe("first");
    expect(second?.id).toBe("second");
  });

  it("does not mutate the previous state", () => {
    const prev = { ...initialBlockState };
    blockReducer(prev, {
      type: "started",
      id: "x",
      command: null,
      cwd: null,
      git_branch: null,
      started_at_ms: 0,
    });
    expect(prev.blocks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// completed
// ---------------------------------------------------------------------------

describe("blockReducer / completed", () => {
  it("fills ended_at_ms, exit_code, duration_ms, and aborted on the matching block", () => {
    const state: BlockState = {
      blocks: [makeBlock({ id: "target", command: "ls" })],
      altScreen: false,
    };
    const next = blockReducer(state, {
      type: "completed",
      id: "target",
      exit_code: 0,
      ended_at_ms: 9999,
      duration_ms: 8999,
      aborted: false,
      cwd: null,
      git_branch: null,
    });
    expect(next.blocks[0]).toEqual({
      id: "target",
      command: "ls",
      cwd: null,
      git_branch: null,
      started_at_ms: 1000,
      ended_at_ms: 9999,
      exit_code: 0,
      duration_ms: 8999,
      aborted: false,
    });
  });

  it("flips aborted to true when the event carries aborted=true", () => {
    // Drives the abort paths end-to-end: shell-died-mid-block (finalize_on_exit
    // on the backend) and double-C both emit BlockCompleted{aborted: true},
    // and the reducer must surface that on the existing block.
    const state: BlockState = {
      blocks: [makeBlock({ id: "running" })],
      altScreen: false,
    };
    const next = blockReducer(state, {
      type: "completed",
      id: "running",
      exit_code: -1,
      ended_at_ms: 5000,
      duration_ms: 4000,
      aborted: true,
      cwd: null,
      git_branch: null,
    });
    const [b] = next.blocks;
    expect(b?.aborted).toBe(true);
    expect(b?.exit_code).toBe(-1);
    expect(b?.ended_at_ms).toBe(5000);
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
      duration_ms: 100,
      aborted: false,
      cwd: null,
      git_branch: null,
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
      duration_ms: 2000,
      aborted: false,
      cwd: null,
      git_branch: null,
    });
    const [blockA, blockB] = next.blocks;
    expect(blockA?.exit_code).toBeNull();
    expect(blockB?.exit_code).toBe(42);
    expect(blockB?.duration_ms).toBe(2000);
  });

  it("does not mutate the previous state", () => {
    const state: BlockState = {
      blocks: [makeBlock({ id: "x" })],
      altScreen: false,
    };
    const blocksBefore = state.blocks;
    blockReducer(state, {
      type: "completed",
      id: "x",
      exit_code: 0,
      ended_at_ms: 1,
      duration_ms: 1,
      aborted: false,
      cwd: null,
      git_branch: null,
    });
    expect(state.blocks).toBe(blocksBefore);
    const [firstBlock] = state.blocks;
    expect(firstBlock?.exit_code).toBeNull();
  });

  it("cwd/branch from the completed event override the start-time values", () => {
    // Models `cd /target && ls` run from /start. The block opened with
    // cwd=/start (from the previous prompt's A), but precmd's D reports
    // the dir the command ended in (/target). The completion should
    // update the row so the user sees /target — the dir they associate
    // with the just-run `ls`.
    const state: BlockState = {
      blocks: [makeBlock({ id: "cd-block", cwd: "/start", git_branch: "main" })],
      altScreen: false,
    };
    const next = blockReducer(state, {
      type: "completed",
      id: "cd-block",
      exit_code: 0,
      ended_at_ms: 2000,
      duration_ms: 500,
      aborted: false,
      cwd: "/target",
      git_branch: "feat/x",
    });
    expect(next.blocks[0]?.cwd).toBe("/target");
    expect(next.blocks[0]?.git_branch).toBe("feat/x");
  });

  it("null cwd on the completed event keeps the start-time value", () => {
    // Defensive: shells without our extended D markers still emit
    // `OSC 133;D;<exit>`. The reducer must not blank out a cwd we already
    // had from the C-time attachment.
    const state: BlockState = {
      blocks: [makeBlock({ id: "x", cwd: "/start", git_branch: "main" })],
      altScreen: false,
    };
    const next = blockReducer(state, {
      type: "completed",
      id: "x",
      exit_code: 0,
      ended_at_ms: 1,
      duration_ms: 1,
      aborted: false,
      cwd: null,
      git_branch: null,
    });
    expect(next.blocks[0]?.cwd).toBe("/start");
    expect(next.blocks[0]?.git_branch).toBe("main");
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
