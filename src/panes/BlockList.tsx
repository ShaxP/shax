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

import { useEffect, useLayoutEffect, useRef } from "react";
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
  /** Click-to-select on any row. */
  onSelectBlock?: (id: BlockId) => void;
  /** When non-null, the named block fills the pane and every
   *  other row is hidden. Driven by TerminalPane's
   *  `maximizedBlockId` state — toggled by `f` or by clicking
   *  the maximise icon. */
  maximizedBlockId?: BlockId | null;
  /** Click handler for the per-row maximise icon. */
  onToggleMaximize?: (id: BlockId) => void;
}

export function BlockList({
  pty,
  blocks,
  liveOutputs,
  getOutput = getBlockOutput,
  selectedBlockId = null,
  inspectedBlock = null,
  onSelectBlock,
  maximizedBlockId = null,
  onToggleMaximize,
}: BlockListProps): React.ReactElement {
  // Stick to the bottom of the list so the most recent block is always
  // visible. Watching the `blocks` reference catches new blocks, completion
  // updates, and streamed chunks alike — every reducer transition that
  // touches a block returns a fresh array.
  // Known limitation: this always scrolls, so a user who has scrolled up
  // mid-stream to read earlier output will be pulled back to the bottom on
  // the next chunk. A "scroll-lock" affordance is a polish item for later.
  const scrollRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks, liveOutputs]);

  // "Sticky bottom" — when the inner content grows (formatter
  // async-loaded a probe result, an image finished decoding, a
  // live block streamed more bytes), snap back to the bottom
  // *if* the user was already there. If they'd scrolled up to
  // read earlier output we leave them alone.
  //
  // ResizeObserver fires on layout changes the React deps array
  // can't see — particularly the `ls` formatter, which paints
  // a small "Probing…" placeholder first and then a 300-px
  // entry list a tick later. The dep-driven scroll above only
  // snaps on `blocks` / `liveOutputs` changes, so without this
  // the user would land mid-block.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;
    // jsdom (vitest env) doesn't ship ResizeObserver; the
    // dep-driven scroll above is enough for tests.
    if (typeof ResizeObserver === "undefined") return;
    let stickToBottom = true;
    let lastScrollHeight = scroller.scrollHeight;
    const NEAR_BOTTOM_PX = 40;
    const onScroll = (): void => {
      const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      stickToBottom = dist < NEAR_BOTTOM_PX;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // Only auto-scroll when content *grew*. Shrinks (block collapse)
    // already let the browser clamp `scrollTop` if needed; re-running
    // `scrollTop = scrollHeight` on shrink would yank the viewport up
    // and put a different block under the user's cursor — leading to
    // a follow-up click landing on the wrong row.
    const ro = new ResizeObserver(() => {
      const grew = scroller.scrollHeight > lastScrollHeight;
      lastScrollHeight = scroller.scrollHeight;
      if (stickToBottom && grew) scroller.scrollTop = scroller.scrollHeight;
    });
    ro.observe(content);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  // Whenever the selection moves, make sure the selected row is
  // *at least* visible. Search-jump lands on an out-of-view row
  // and needs the scroll; click-selection lands on a row that's
  // already visible (the user's cursor is on it) and must NOT
  // scroll — a smooth scroll between mousedown and click shifts
  // the DOM under the cursor and any tool-button click that
  // follows lands on empty space instead of the button. `nearest`
  // is the semantic we want: scroll only far enough to reveal
  // the row, otherwise leave the viewport alone.
  useLayoutEffect(() => {
    if (selectedBlockId === null) return;
    const list = scrollRef.current;
    if (list === null) return;
    const row = list.querySelector<HTMLElement>(`[data-block-id="${selectedBlockId}"]`);
    if (row === null) return;
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
      <div ref={contentRef}>
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
        {inspectedBlock !== null && !blocks.some((b) => b.id === inspectedBlock.id) && (
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
                onSelect={() => onSelectBlock?.(inspectedBlock.id)}
                isMaximized={inspectedBlock.id === maximizedBlockId}
                hidden={maximizedBlockId !== null && inspectedBlock.id !== maximizedBlockId}
                onToggleMaximize={
                  onToggleMaximize === undefined
                    ? undefined
                    : () => onToggleMaximize(inspectedBlock.id)
                }
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
            blocks.map((block, index) =>
              pty === null ? null : (
                <BlockRow
                  key={block.id}
                  pty={pty}
                  block={block}
                  liveOutput={liveOutputs?.get(block.id)}
                  getOutput={getOutput}
                  selected={block.id === selectedBlockId}
                  onSelect={() => onSelectBlock?.(block.id)}
                  isMaximized={block.id === maximizedBlockId}
                  hidden={maximizedBlockId !== null && block.id !== maximizedBlockId}
                  isLatest={index === blocks.length - 1}
                  onToggleMaximize={
                    onToggleMaximize === undefined ? undefined : () => onToggleMaximize(block.id)
                  }
                />
              ),
            )}
      </div>
    </aside>
  );
}
