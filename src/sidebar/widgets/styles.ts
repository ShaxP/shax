/**
 * Shared visual constants for sidebar widgets (M13 design refresh).
 *
 * Every expanded widget lives in a card — rounded, slightly raised
 * against the sidebar pane background. Every card has the same
 * label / value typography language so the sidebar reads as a
 * coherent dashboard rather than a stack of ad-hoc chips.
 *
 * Referenced by ClockWidget, CpuWidget, MemoryWidget, NetworkWidget,
 * GitBranchWidget (M13.2 / M13.3 slices). Extracted here because
 * four widgets already share the constants and M13.4 caffeinate
 * will make it five — three is a pattern to extract, four is
 * overdue.
 */

import type { CSSProperties } from "react";

/** The card container that wraps each expanded widget. Rail-state
 *  widgets do NOT use this — they render directly into the vertical
 *  glyph stack.
 *
 *  Outlined, not filled: in design/widget-sidebar.png every card
 *  except the clock sits at the sidebar's own `--pane` background
 *  and is separated from it only by the 1px border. Filling them
 *  turns the sidebar into a wall of stacked slabs; the outline keeps
 *  the surface calm and lets the clock read as the one raised
 *  element. */
export const CARD: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

/** The one filled card variant, reserved for the clock at the top of
 *  the sidebar. The fill is what makes it the anchor of the column —
 *  see the mockup, where it is the only widget raised off the pane
 *  background. */
export const CARD_RAISED: CSSProperties = {
  ...CARD,
  background: "var(--surface)",
};

/** Small ALL-CAPS label sitting at the top of every card. Matches
 *  the "CPU LOAD" / "MEMORY" / "NETWORK" / "REPO" labels in the
 *  reference mockup. */
export const CARD_LABEL: CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.8,
  textTransform: "uppercase",
  color: "var(--fg-faint)",
  fontWeight: 600,
};

/** The header row of a card — label on the left, value on the right. */
export const CARD_HEADER: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
};

/** Numeric-value styling for the "big number on the right" pattern
 *  ("55%" / "82%" / branch name). Colored per-widget via inline
 *  style overrides (green for CPU%, accent for branch, etc.). */
export const CARD_VALUE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--fg)",
};
