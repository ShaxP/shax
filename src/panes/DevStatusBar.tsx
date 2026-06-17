/**
 * DevStatusBar — a temporary dev-mode overlay that surfaces block state.
 *
 * Pinned to the bottom of its containing pane. Slice 3 will replace this with
 * the real block list UI; this component exists solely to make the slice 2
 * acceptance surface visible.
 *
 * `pointerEvents: none` keeps it non-interactive so it never steals clicks or
 * key events from the terminal below.
 */

interface Props {
  blockCount: number;
  altScreen: boolean;
  lastExit: number | null;
}

export function DevStatusBar({ blockCount, altScreen, lastExit }: Props): React.ReactElement {
  return (
    <div
      data-testid="dev-status-bar"
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        padding: "2px 8px",
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 11,
        opacity: 0.6,
        background: "rgba(0,0,0,0.4)",
        color: "#9ab",
        pointerEvents: "none",
      }}
    >
      blocks: {blockCount} · alt-screen: {altScreen ? "yes" : "no"} · last exit: {lastExit ?? "-"}
    </div>
  );
}
