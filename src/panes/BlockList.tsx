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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  // visible. We re-scroll on any block-state change:
  //  - new block appended (length grows),
  //  - running block completes (status / duration / "interactive session"
  //    label appears → row height changes),
  //  - chunk streamed into a block (liveOutputs identity bumped).
  // Watching the `blocks` reference (not just `length`) catches the
  // completion case — including the one where an interactive block
  // finishes and the `liveOutputs` map didn't change during alt-screen,
  // so the old `[length, liveOutputs]` deps would have missed it.
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
  }, [blocks, liveOutputs]);

  // Jump-to-block flash. Dispatched by App when a search result is
  // routed to a still-alive pane: scroll the matching row into view
  // and pulse it briefly so the user sees *which* block matched
  // instead of landing in a long list and scanning. Every BlockList
  // across the app listens; only the one with that block id reacts.
  const [flashedBlockId, setFlashedBlockId] = useState<BlockId | null>(null);
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ blockId: BlockId }>).detail;
      const id = detail?.blockId;
      if (id === undefined) return;
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
      if (el === undefined || el === null) return;
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      setFlashedBlockId(id);
    };
    window.addEventListener("shax:flash-block", handler);
    return () => window.removeEventListener("shax:flash-block", handler);
  }, []);

  // Self-clearing pulse: hold the flash for 1.5 s then reset, which
  // lets the BlockRow's `transition` animate the highlight back to
  // its resting state.
  useEffect(() => {
    if (flashedBlockId === null) return;
    const t = setTimeout(() => setFlashedBlockId(null), 1500);
    return () => clearTimeout(t);
  }, [flashedBlockId]);

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
              flashed={block.id === flashedBlockId}
            />
          ),
        )
      )}
    </aside>
  );
}
