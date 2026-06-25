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
 *
 * An optional `inspectedBlock` is shown above the live list with a "from
 * history" tag — that's how search results from previous sessions land in
 * the current pane (slice 3.2). `selectedBlockId` drives the per-row
 * selection border that follows a search jump.
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
  /** Drives the per-row selection border (search-jump highlight). */
  selectedBlockId?: BlockId | null;
  /**
   * Historical block surfaced via search when no live pane carries it.
   * Rendered above the live list with a "from history" tag.
   */
  inspectedBlock?: UiBlock | null;
}

export function BlockList({
  pty,
  blocks,
  liveOutputs,
  getOutput = getBlockOutput,
  selectedBlockId = null,
  inspectedBlock = null,
}: BlockListProps): React.ReactElement {
  // Stick to the bottom of the list so the most recent block is always
  // visible. Watching the `blocks` reference catches new blocks, completion
  // updates, and streamed chunks alike — every reducer transition that
  // touches a block returns a fresh array.
  // Known limitation: this always scrolls, so a user who has scrolled up
  // mid-stream to read earlier output will be pulled back to the bottom on
  // the next chunk. A "scroll-lock" affordance is a polish item for later.
  const scrollRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks, liveOutputs]);

  // Whenever the selection moves (search jump), scroll the selected row
  // into view. `block: "center"` keeps the row near the middle so the
  // border-with-rounded-corners highlight reads clearly even for blocks
  // that would otherwise sit at the very top or bottom.
  useLayoutEffect(() => {
    if (selectedBlockId === null) return;
    const list = scrollRef.current;
    if (list === null) return;
    const row = list.querySelector<HTMLElement>(`[data-block-id="${selectedBlockId}"]`);
    if (row === null) return;
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedBlockId]);

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
      {inspectedBlock !== null && (
        <div data-testid="block-list-inspected">
          <div
            style={{
              padding: "6px 12px",
              fontSize: 10,
              color: "var(--fg-faint)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              background: "var(--surface)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            from history
          </div>
          {pty !== null && (
            <BlockRow
              key={`inspected-${inspectedBlock.id}`}
              pty={pty}
              block={inspectedBlock}
              liveOutput={liveOutputs?.get(inspectedBlock.id)}
              getOutput={getOutput}
              selected={inspectedBlock.id === selectedBlockId}
            />
          )}
        </div>
      )}
      {blocks.length === 0
        ? inspectedBlock === null && (
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
          )
        : // pty is set together with the first block; once we have blocks we
          // always have a pty id, so the non-null assertion is sound.
          blocks.map((block) =>
            pty === null ? null : (
              <BlockRow
                key={block.id}
                pty={pty}
                block={block}
                liveOutput={liveOutputs?.get(block.id)}
                getOutput={getOutput}
                selected={block.id === selectedBlockId}
              />
            ),
          )}
    </aside>
  );
}
