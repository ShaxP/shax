/**
 * Pure reducer for per-pane block state.
 *
 * Keeps the chronological list of block summaries and the current alternate-
 * screen flag. Both are updated by routing IPC events through `blockReducer`.
 * No side effects — safe to test without rendering.
 */

import type { BlockId, BlockSummary } from "../lib/ipc";
import type { PromptLine } from "./promptRenderer";
import { emptyPromptLine, feed as feedPromptRenderer } from "./promptRenderer";

/**
 * UI-side block summary. Extends the IPC `BlockSummary` with a flag that
 * records whether the alt-screen was ever active during this block —
 * i.e. whether the user ran an interactive program (vim, htop, btop,
 * less, ssh, …) inside it. Output bytes from alt-screen are unusable as
 * a block-list preview (raw cursor + grid manipulation, not flow text),
 * so the UI hides the output expandable for interactive blocks and just
 * shows the command + duration. Frontend-only; not persisted yet.
 */
export interface UiBlock extends BlockSummary {
  interactive: boolean;
}

export interface BlockState {
  /** Blocks in chronological order. */
  blocks: UiBlock[];
  /** True while a program holds the alternate screen buffer. */
  altScreen: boolean;
  /**
   * Captured output bytes per block, accumulated from `block_chunk` events
   * as a command streams. The map is rebuilt on every chunk so the reducer
   * stays pure; entries for unchanged blocks keep their existing Uint8Array
   * reference, so React.memo'd BlockRows that read this map skip re-render
   * when an unrelated block streams.
   *
   * Capped on the backend at OUTPUT_CAP_BYTES, so the per-block size is
   * bounded; total memory is bounded by the number of in-session blocks.
   */
  liveOutputs: Map<BlockId, Uint8Array>;
  /**
   * The current shell prompt line as it last appeared. Updated by feeding
   * `prompt_chunk` bytes through the tiny VT renderer. Cleared whenever a
   * new block starts (the prompt's text becomes the command title from
   * that point onward, not the strip).
   */
  promptLine: PromptLine;
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
      /**
       * Backend-authoritative interactive flag. Latches whatever the in-
       * session alt-screen detection already set (they always agree under
       * the OSC 133 contract), but means a block reopened later from disk
       * still shows the interactive label even before any live event fires.
       */
      interactive: boolean;
    }
  | { type: "alt_screen"; active: boolean }
  | { type: "block_chunk"; id: BlockId; bytes: Uint8Array }
  | { type: "prompt_chunk"; bytes: Uint8Array };

export const initialBlockState: BlockState = {
  blocks: [],
  altScreen: false,
  liveOutputs: new Map(),
  promptLine: emptyPromptLine,
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
      // Persisted blocks now carry the `interactive` flag from the backend
      // (slice 2.3a), so vim / htop blocks from a previous session restore
      // with the right "interactive session" label and no garbled output
      // preview. The spread keeps any future BlockSummary fields working.
      return {
        ...state,
        blocks: action.blocks.map((b) => ({ ...b })),
      };

    case "started":
      // A new command just started — the prompt the user was typing into is
      // no longer "current"; reset the strip so it doesn't show the last
      // command after Enter has been pressed.
      return {
        ...state,
        promptLine: emptyPromptLine,
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
            interactive: false,
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
      const updated: UiBlock = {
        ...existing,
        ended_at_ms: action.ended_at_ms,
        exit_code: action.exit_code,
        duration_ms: action.duration_ms,
        aborted: action.aborted,
        cwd: action.cwd,
        git_branch: action.git_branch,
        // OR with the existing flag: live alt-screen tracking and the
        // backend completion event always agree under the OSC 133
        // contract, but `||` is the safer reduction if either side
        // detected an interactive session.
        interactive: existing.interactive || action.interactive,
      };
      const blocks = [...state.blocks];
      blocks[index] = updated;
      return { ...state, blocks };
    }

    case "alt_screen": {
      if (!action.active) {
        return { ...state, altScreen: false };
      }
      // Alt-screen just turned on. If there's a block in flight (ended_at_ms
      // === null), mark it as an interactive session so the UI knows not to
      // render its output bytes as flow text. The flag is sticky for the
      // life of the block — even after the user quits vim and alt-screen
      // flips off, we still don't want to surface the (now garbled) bytes.
      const runningIdx = state.blocks.findIndex((b) => b.ended_at_ms === null);
      if (runningIdx === -1) {
        return { ...state, altScreen: true };
      }
      const running = state.blocks[runningIdx];
      if (running === undefined || running.interactive) {
        return { ...state, altScreen: true };
      }
      const blocks = [...state.blocks];
      blocks[runningIdx] = { ...running, interactive: true };
      return { ...state, altScreen: true, blocks };
    }

    case "block_chunk": {
      // Defence in depth: TerminalPane already short-circuits chunk
      // events during alt-screen, but if anything ever dispatches
      // directly we still avoid the O(N²) reallocation chain for bytes
      // nobody will ever read (the block list is hidden in alt-screen).
      if (state.altScreen) return state;
      // Append the new bytes to the existing buffer for this block, if any.
      // The map is replaced (new reference), but only the changed slot gets a
      // new Uint8Array; unchanged blocks' arrays keep the same reference, so
      // a React.memo'd BlockRow that reads this map skips re-render unless
      // its own block id was the one that changed.
      const prev = state.liveOutputs.get(action.id);
      let next: Uint8Array;
      if (prev === undefined) {
        next = action.bytes;
      } else {
        next = new Uint8Array(prev.length + action.bytes.length);
        next.set(prev, 0);
        next.set(action.bytes, prev.length);
      }
      const liveOutputs = new Map(state.liveOutputs);
      liveOutputs.set(action.id, next);
      return { ...state, liveOutputs };
    }

    case "prompt_chunk":
      return { ...state, promptLine: feedPromptRenderer(state.promptLine, action.bytes) };
  }
}
