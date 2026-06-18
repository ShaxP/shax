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
  | { type: "started"; id: BlockId; started_at_ms: number }
  | { type: "completed"; id: BlockId; exit_code: number; ended_at_ms: number }
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
 * - `completed`: fills `ended_at_ms` and `exit_code` on the matching block;
 *   no-ops if the block is not found (event arrived before frontend mounted).
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
            started_at_ms: action.started_at_ms,
            ended_at_ms: null,
            exit_code: null,
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
      const updated: BlockSummary = {
        id: existing.id,
        started_at_ms: existing.started_at_ms,
        ended_at_ms: action.ended_at_ms,
        exit_code: action.exit_code,
      };
      const blocks = [...state.blocks];
      blocks[index] = updated;
      return { ...state, blocks };
    }

    case "alt_screen":
      return { ...state, altScreen: action.active };
  }
}
