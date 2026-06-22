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
import type { BlockSummary, PtyId } from "../lib/ipc";
import { getBlockOutput } from "../lib/ipc";
import { BlockRow } from "./BlockRow";

export interface BlockListProps {
  pty: PtyId | null;
  blocks: BlockSummary[];
  /** Injected for tests; defaults to the real IPC client. */
  getOutput?: (pty: PtyId, blockId: string) => Promise<Uint8Array>;
}

export function BlockList({
  pty,
  blocks,
  getOutput = getBlockOutput,
}: BlockListProps): React.ReactElement {
  // Stick to the bottom of the list so the most recent block is always
  // visible — both when the app starts (the history seed bumps length from
  // 0 to N) and when a new command runs (a new BlockStarted appends a row).
  // `useLayoutEffect` runs after the DOM update but before paint, so the
  // user never sees the list at the wrong scroll position.
  const scrollRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks.length]);

  return (
    <aside
      ref={scrollRef}
      data-testid="block-list"
      style={{
        width: 360,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
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
            <BlockRow key={block.id} pty={pty} block={block} getOutput={getOutput} />
          ),
        )
      )}
    </aside>
  );
}
