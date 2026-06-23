/**
 * BlockList — the per-pane stack of captured command blocks.
 *
 * Pinned to the right of the xterm canvas; the xterm keeps showing the live
 * byte stream (path one) while this column accumulates structured blocks
 * (path two). Replaces the slice-2 DevStatusBar.
 *
 * Layout is a simple vertical scroll. Empty state shows a friendly hint that
 * blocks will appear as commands run. The full block-first layout from the
 * design lands at M4/M5 once formatters exist.
 */

import { useLayoutEffect, useRef } from "react";
import type { BlockId, PtyId } from "../lib/ipc";
import { getBlockOutput } from "../lib/ipc";
import { BlockRow } from "./BlockRow";
import type { UiBlock } from "./blockReducer";

export interface BlockListProps {
  pty: PtyId | null;
  blocks: UiBlock[];
  /**
   * Live-streamed output bytes per block, accumulated from `block_chunk`
   * events. The block row uses this for inline rendering of running and
   * recently-completed blocks; older blocks (seeded from disk) fall back
   * to fetching via `getOutput` on expand.
   *
   * Defaults to an empty map so callers (mostly tests) need not provide it.
   */
  liveOutputs?: Map<BlockId, Uint8Array>;
  /** Injected for tests; defaults to the real IPC client. */
  getOutput?: (pty: PtyId, blockId: string) => Promise<Uint8Array>;
}

export function BlockList({
  pty,
  blocks,
  liveOutputs,
  getOutput = getBlockOutput,
}: BlockListProps): React.ReactElement {
  // Stick to the bottom of the list so the most recent block is always
  // visible. We re-scroll on three signals:
  //  - the block count changes (new BlockStarted appended a row, or the
  //    history seed bumped length from 0 to N on mount),
  //  - the live-output map reference changes (a chunk just streamed into
  //    the currently running block, growing its rendered height).
  // `useLayoutEffect` runs after the DOM update but before paint, so the
  // user never sees the list at the wrong scroll position.
  // Known limitation: this always scrolls, so a user who has scrolled up
  // mid-stream to read earlier output will be pulled back to the bottom on
  // the next chunk. A "scroll-lock" affordance is a polish item for later.
  const scrollRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks.length, liveOutputs]);

  return (
    <aside
      ref={scrollRef}
      data-testid="block-list"
      style={{
        flex: 1,
        minWidth: 0,
        background: "var(--pane2)",
        overflowY: "auto",
        color: "var(--fg)",
      }}
    >
      <header
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--fg-faint)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        blocks · {blocks.length}
      </header>
      {blocks.length === 0 ? (
        <div
          data-testid="block-list-empty"
          style={{
            padding: 16,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--fg-faint)",
          }}
        >
          Run a command to see it captured here.
        </div>
      ) : (
        // pty is set together with the first block; once we have blocks we
        // always have a pty id, so the non-null assertion is sound.
        blocks.map((block) =>
          pty === null ? null : (
            <BlockRow
              key={block.id}
              pty={pty}
              block={block}
              liveOutput={liveOutputs?.get(block.id)}
              getOutput={getOutput}
            />
          ),
        )
      )}
    </aside>
  );
}
