/**
 * Pure reducer for per-pane block state.
 *
 * Keeps the chronological list of block summaries and the current alternate-
 * screen flag. Both are updated by routing IPC events through `blockReducer`.
 * No side effects — safe to test without rendering.
 */

import type { BlockId, BlockSummary } from "../lib/ipc";

export interface BlockState {
  /** Blocks in chronological order. */
  blocks: BlockSummary[];
  /** True while a program holds the alternate screen buffer. */
  altScreen: boolean;
}

export type BlockAction =
  | { type: "seed"; blocks: BlockSummary[] }
  | {
      type: "started";
      id: BlockId;
      command: string | null;
      cwd: string | null;
      git_branch: string | null;
      started_at_ms: number;
    }
  | {
      type: "completed";
      id: BlockId;
      exit_code: number;
      ended_at_ms: number;
      duration_ms: number;
      aborted: boolean;
      /** End-of-command cwd from OSC 133 D; overrides the running block's. */
      cwd: string | null;
      git_branch: string | null;
    }
  | { type: "alt_screen"; active: boolean };

export const initialBlockState: BlockState = {
  blocks: [],
  altScreen: false,
};

/**
 * Reduces a single `BlockAction` into a new `BlockState`.
 *
 * - `seed`: replaces the entire block list (used on mount).
 * - `started`: appends a new running block.
 * - `completed`: fills `ended_at_ms`, `exit_code`, `duration_ms`, and `aborted`
 *   on the matching block; no-ops if the block is not found (event arrived
 *   before frontend mounted).
 * - `alt_screen`: updates the alternate-screen flag.
 */
export function blockReducer(state: BlockState, action: BlockAction): BlockState {
  switch (action.type) {
    case "seed":
      return { ...state, blocks: action.blocks };

    case "started":
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            id: action.id,
            command: action.command,
            cwd: action.cwd,
            git_branch: action.git_branch,
            started_at_ms: action.started_at_ms,
            ended_at_ms: null,
            exit_code: null,
            duration_ms: null,
            aborted: false,
          },
        ],
      };

    case "completed": {
      const index = state.blocks.findIndex((b) => b.id === action.id);
      // Event arrived before the frontend mounted the block — safe to ignore.
      if (index === -1) return state;
      const existing = state.blocks[index];
      // index is guaranteed valid by findIndex above; existing is always defined.
      if (existing === undefined) return state;
      // cwd/branch on the event are authoritative — the backend already
      // decided whether the shell's D was extended (use those values, even
      // if a field is null meaning "explicitly no branch here") or bare
      // (carry the start-time values forward). Don't second-guess it with
      // a fallback or `cd /tmp` from a git repo leaves the stale branch
      // attached.
      const updated: BlockSummary = {
        ...existing,
        ended_at_ms: action.ended_at_ms,
        exit_code: action.exit_code,
        duration_ms: action.duration_ms,
        aborted: action.aborted,
        cwd: action.cwd,
        git_branch: action.git_branch,
      };
      const blocks = [...state.blocks];
      blocks[index] = updated;
      return { ...state, blocks };
    }

    case "alt_screen":
      return { ...state, altScreen: action.active };
  }
}
