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
  return (
    <aside
      data-testid="block-list"
      style={{
        width: 360,
        flexShrink: 0,
        borderLeft: "1px solid #2a2f37",
        background: "#15181d",
        overflowY: "auto",
        color: "#cdd5df",
      }}
    >
      <header
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid #2a2f37",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 11,
          color: "#7a8290",
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
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontSize: 12,
            color: "#7a8290",
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
