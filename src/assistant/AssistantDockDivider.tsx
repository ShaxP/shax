/**
 * Resize handle for the M7.7a assistant dock.
 *
 * Mirrors the layout-tree divider in `panes/LayoutRender.tsx` — same
 * pointer-capture pattern, same "hit area is 10px, visible line is
 * 1px" treatment — but simpler: single axis (horizontal drag only,
 * because the dock is a right column) and no layout-tree path.
 *
 * The parent owns the persisted width state and passes an `onResize`
 * callback that receives the new pixel width during a drag. Clamping
 * to the parent's client width happens here (so a user can't drag the
 * dock wider than the window). The `onCommit` callback fires once at
 * pointer-up so the caller can persist the final value without
 * spamming the preferences file on every mouse move.
 */

import type { CSSProperties } from "react";
import { useCallback } from "react";

/** Hit-area thickness around the 1px divider line. Matches the M2 layout
 *  divider so both dividers feel identical to grab. */
const DIVIDER_HIT_PX = 10;

/** Minimum + maximum widths clamped during a drag. Keeps the dock from
 *  disappearing under the divider or eating the whole window. */
const MIN_WIDTH_PX = 260;
const MAX_WIDTH_PX_MARGIN = 200;

const HIT: CSSProperties = {
  width: DIVIDER_HIT_PX,
  height: "100%",
  cursor: "ew-resize",
  background: "transparent",
  touchAction: "none",
  flexShrink: 0,
  position: "relative",
};

const LINE: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  left: DIVIDER_HIT_PX / 2 - 0.5,
  width: 1,
  background: "var(--border)",
  pointerEvents: "none",
};

export interface AssistantDockDividerProps {
  /** Current dock width in pixels. Used as the starting point for a drag. */
  width: number;
  /**
   * Parent container the dock lives inside. We measure it once at
   * drag-start to compute the maximum allowed width (parent width
   * minus a small margin so at least some tab area stays visible).
   */
  hostRef: React.RefObject<HTMLElement | null>;
  /** Called continuously during a drag with the new clamped width. */
  onResize: (width: number) => void;
  /**
   * Called once when the pointer is released with the final width.
   * The caller uses this to persist to preferences without churning
   * the file on every mouse move.
   */
  onCommit: (width: number) => void;
}

export function AssistantDockDivider({
  width,
  hostRef,
  onResize,
  onCommit,
}: AssistantDockDividerProps): React.ReactElement {
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const host = hostRef.current;
      if (host === null) return;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const hostRect = host.getBoundingClientRect();
      const startWidth = width;
      const startX = e.clientX;
      const maxWidth = Math.max(MIN_WIDTH_PX, hostRect.width - MAX_WIDTH_PX_MARGIN);
      let latest = startWidth;

      const handleMove = (ev: PointerEvent): void => {
        // Dragging LEFT (negative delta) grows the dock; dragging
        // RIGHT shrinks it. That's because the divider sits on the
        // dock's left edge.
        const delta = startX - ev.clientX;
        const raw = startWidth + delta;
        const clamped = Math.max(MIN_WIDTH_PX, Math.min(maxWidth, raw));
        latest = clamped;
        onResize(clamped);
      };

      const handleUp = (ev: PointerEvent): void => {
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          // Already released.
        }
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleUp);
        target.removeEventListener("pointercancel", handleUp);
        onCommit(latest);
      };

      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleUp);
      target.addEventListener("pointercancel", handleUp);
    },
    [hostRef, onResize, onCommit, width],
  );

  return (
    <div
      data-testid="assistant-dock-divider"
      style={HIT}
      onPointerDown={startDrag}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize assistant panel"
    >
      <div style={LINE} />
    </div>
  );
}
