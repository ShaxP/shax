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

import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import shaxIconUrl from "../assets/shax-icon.svg";
import type { BlockId, PtyId } from "../lib/ipc";
import { getBlockOutput } from "../lib/ipc";
import { BlockRow } from "./BlockRow";
import type { UiBlock } from "./blockReducer";

// --- Empty-state styles (M7.5a) ---------------------------------------
//
// The empty state (no blocks, no inspected search hit) is a centered
// hero: mark glyph, status dot + "Ready.", one-sentence description,
// and three shortcut cards. All styles live in this block so they read
// as a unit and don't get scattered through the render body.

const EMPTY_WRAPPER: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "48px 24px",
  fontFamily: "var(--font-ui)",
  color: "var(--fg)",
};

const EMPTY_HEADING_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginTop: 20,
  fontSize: 18,
  fontWeight: 600,
  letterSpacing: 0.1,
};

const EMPTY_READY_DOT: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "var(--green)",
  boxShadow: "0 0 6px color-mix(in srgb, var(--green) 55%, transparent)",
};

const EMPTY_DESCRIPTION: CSSProperties = {
  marginTop: 14,
  maxWidth: 480,
  textAlign: "center",
  fontSize: 13.5,
  lineHeight: 1.55,
  color: "var(--fg-dim)",
};

const EMPTY_CHIP_LIST: CSSProperties = {
  marginTop: 36,
  width: "min(460px, 100%)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const EMPTY_CHIP: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--pane)",
  fontSize: 13,
  color: "var(--fg-dim)",
};

const KBD_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  padding: "3px 8px",
  minWidth: 42,
  textAlign: "center",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm)",
  background: "var(--pane2)",
  color: "var(--fg)",
};

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
      <div
        ref={contentRef}
        style={{
          // Flex column so a live interactive widget can pin
          // itself visually to the bottom via CSS `order`
          // while chronological emissions (git add / reset
          // / status) slot in above it. See
          // `.block-row[data-widget-live="true"]` in
          // BlockRow.css for the rule.
          //
          // `minHeight: 100%` lets the M7.5a empty-state hero
          // centre itself vertically in the visible pane when
          // no blocks are present. When blocks exist the
          // column grows past 100% and this is a no-op.
          display: "flex",
          flexDirection: "column",
          minHeight: "100%",
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
              <div data-testid="block-list-empty" style={EMPTY_WRAPPER}>
                <img
                  src={shaxIconUrl}
                  alt="Shax"
                  width={64}
                  height={64}
                  style={{ display: "block" }}
                />
                <div style={EMPTY_HEADING_ROW}>
                  <span aria-hidden="true" style={EMPTY_READY_DOT} />
                  <span>Ready</span>
                </div>
                <p style={EMPTY_DESCRIPTION}>
                  Run a command in the terminal — it&rsquo;ll show up here as a{" "}
                  <strong style={{ color: "var(--fg)", fontWeight: 600 }}>block</strong> you can
                  select, format, and inspect.
                </p>
                <div style={EMPTY_CHIP_LIST}>
                  <div style={EMPTY_CHIP} data-testid="block-list-empty-hint-search">
                    <kbd style={KBD_STYLE}>⌘F</kbd>
                    <span>search everything you&rsquo;ve run</span>
                  </div>
                  <div style={EMPTY_CHIP} data-testid="block-list-empty-hint-assistant">
                    <kbd style={KBD_STYLE}>⌘K</kbd>
                    <span>ask the assistant</span>
                  </div>
                  <div style={EMPTY_CHIP} data-testid="block-list-empty-hint-settings">
                    <kbd style={KBD_STYLE}>⌘,</kbd>
                    <span>theme &amp; preferences</span>
                  </div>
                </div>
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
