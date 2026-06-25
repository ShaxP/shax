/**
 * Geometry-driven renderer for a tab's pane layout tree.
 *
 * Why "geometry-driven": every TerminalPane is rendered in a *fixed*
 * React position (a flat list keyed by paneId) and only its containing
 * `<div>`'s style changes when the layout tree changes. Without this, a
 * split would change the parent element type (leaf wrapper → split
 * wrapper) and React would unmount + remount the surviving pane,
 * killing and re-spawning its PTY.
 *
 * Performance contract (slice 2.2b polish):
 * - The callbacks LayoutRender receives are reference-stable across
 *   parent re-renders (`useCallback([])` in App). LayoutRender wraps
 *   them with `tabId` via `useCallback` to keep them stable per tab.
 * - Each leaf is rendered through a memoised `PaneLeaf` that compares
 *   its rect field-by-field. A divider drag updates the geometry of
 *   exactly two leaves (the panes either side of the drag); every
 *   other leaf's `rect` is structurally equal to the previous render's
 *   and `PaneLeaf` skips it — the (relatively heavy) `TerminalPane`
 *   subtree below it stays untouched.
 */

import type { CSSProperties } from "react";
import { memo, useCallback, useMemo, useRef } from "react";
import { TerminalPane } from "./TerminalPane";
import type { DividerLine, LayoutNode, PaneId, Rect, SplitPath } from "./layout";
import { computeGeometry } from "./layout";

export interface LayoutRenderProps {
  tabId: string;
  node: LayoutNode;
  focusedPaneId: PaneId;
  tabActive: boolean;
  /** Click on a leaf → focus that pane in `tabId`. */
  onPaneFocus: (tabId: string, paneId: PaneId) => void;
  /** Per-pane cwd / branch updates from OSC 133 A. */
  onPaneMeta: (tabId: string, paneId: PaneId, cwd: string | null, branch: string | null) => void;
  /** Per-pane alt-screen toggle. */
  onPaneAltScreen: (tabId: string, paneId: PaneId, active: boolean) => void;
  /**
   * Per-pane PTY id reporting. Bubbles the backend pty id up to App so
   * the search-overlay's jump-to-pane can route to a still-alive pane.
   */
  onPanePtyId: (tabId: string, paneId: PaneId, ptyId: string | null) => void;
  /** Drag-to-resize: caller updates the layout-tree Split at `path` in `tabId`. */
  onSetRatio: (tabId: string, path: SplitPath, ratio: number) => void;
}

/** Hit-area thickness around the 1px divider line so it's easy to grab. */
const DIVIDER_HIT = 10;

const HOST: CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  width: "100%",
  height: "100%",
};

function paneWrapStyle(rect: Rect): CSSProperties {
  return {
    position: "absolute",
    left: `${rect.left}%`,
    top: `${rect.top}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
    display: "flex",
    flexDirection: "column",
    background: "var(--bg)",
    overflow: "hidden",
  };
}

/**
 * Focus indicator. Drawn as a dedicated overlay rather than the wrapper's
 * `outline` because in alt-screen the xterm canvas sits at z-index 2 and
 * paints over a pane-wrapper outline — but a sibling div at a higher
 * z-index reliably stays visible on top of xterm. `pointerEvents: none`
 * keeps it from intercepting clicks meant for the pane content.
 *
 * Width is sub-pixel (0.5px) so the ring renders as a true hairline on
 * retina displays; non-retina browsers round to 1 px which is fine as
 * a fallback. We only draw the ring when there are multiple panes —
 * with one pane there's nothing to focus *among*, so no indicator.
 */
function focusRingStyle(isFocused: boolean): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    border: isFocused ? "0.5px solid var(--accent)" : "0.5px solid transparent",
    boxSizing: "border-box",
    zIndex: 100,
  };
}

function dividerHitStyle(d: DividerLine): CSSProperties {
  const centerLeft = d.splitRect.left + d.splitRect.width * d.ratio;
  const centerTop = d.splitRect.top + d.splitRect.height * d.ratio;
  if (d.direction === "row") {
    return {
      position: "absolute",
      left: `calc(${centerLeft}% - ${DIVIDER_HIT / 2}px)`,
      top: `${d.splitRect.top}%`,
      width: `${DIVIDER_HIT}px`,
      height: `${d.splitRect.height}%`,
      cursor: "ew-resize",
      zIndex: 6,
      background: "transparent",
      touchAction: "none",
    };
  }
  return {
    position: "absolute",
    left: `${d.splitRect.left}%`,
    top: `calc(${centerTop}% - ${DIVIDER_HIT / 2}px)`,
    width: `${d.splitRect.width}%`,
    height: `${DIVIDER_HIT}px`,
    cursor: "ns-resize",
    zIndex: 6,
    background: "transparent",
    touchAction: "none",
  };
}

function dividerLineStyle(direction: DividerLine["direction"]): CSSProperties {
  if (direction === "row") {
    return {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: "50%",
      width: 1,
      transform: "translateX(-0.5px)",
      background: "var(--border)",
      pointerEvents: "none",
    };
  }
  return {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    height: 1,
    transform: "translateY(-0.5px)",
    background: "var(--border)",
    pointerEvents: "none",
  };
}

// ── PaneLeaf ─────────────────────────────────────────────────────────────────

interface PaneLeafProps {
  paneId: PaneId;
  rect: Rect;
  isFocused: boolean;
  tabActive: boolean;
  /** True when the tab has more than one pane (i.e. the ring matters). */
  showFocusRing: boolean;
  /** Stable; bound with `tabId` by the parent LayoutRender. */
  onFocus: (paneId: PaneId) => void;
  onMeta: (paneId: PaneId, cwd: string | null, branch: string | null) => void;
  onAltScreen: (paneId: PaneId, active: boolean) => void;
  onPtyId: (paneId: PaneId, ptyId: string | null) => void;
}

function PaneLeafInner({
  paneId,
  rect,
  isFocused,
  tabActive,
  showFocusRing,
  onFocus,
  onMeta,
  onAltScreen,
  onPtyId,
}: PaneLeafProps): React.ReactElement {
  // Per-pane bound callbacks. Stable as long as the parent's
  // (tabId-bound) callbacks are stable.
  const handleFocus = useCallback(() => onFocus(paneId), [paneId, onFocus]);
  const handleMeta = useCallback(
    (cwd: string | null, branch: string | null) => onMeta(paneId, cwd, branch),
    [paneId, onMeta],
  );
  const handleAltScreen = useCallback(
    (active: boolean) => onAltScreen(paneId, active),
    [paneId, onAltScreen],
  );
  const handlePtyId = useCallback(
    (ptyId: string | null) => onPtyId(paneId, ptyId),
    [paneId, onPtyId],
  );

  return (
    <div
      data-testid="layout-leaf"
      data-pane-id={paneId}
      data-focused={isFocused ? "true" : "false"}
      style={paneWrapStyle(rect)}
      onPointerDown={handleFocus}
    >
      <TerminalPane
        active={tabActive && isFocused}
        onMetaChange={handleMeta}
        onAltScreenChange={handleAltScreen}
        onPtyIdChange={handlePtyId}
      />
      {showFocusRing && <div data-testid="layout-focus-ring" style={focusRingStyle(isFocused)} />}
    </div>
  );
}

/**
 * Field-by-field comparison on `rect`: the layout tree allocates a
 * fresh Rect on every `computeGeometry` call (so identity always
 * changes), but for panes that aren't adjacent to a dragged divider
 * the *values* are identical and PaneLeaf can skip the render.
 */
function paneLeafEqual(prev: PaneLeafProps, next: PaneLeafProps): boolean {
  return (
    prev.paneId === next.paneId &&
    prev.isFocused === next.isFocused &&
    prev.tabActive === next.tabActive &&
    prev.showFocusRing === next.showFocusRing &&
    prev.onFocus === next.onFocus &&
    prev.onMeta === next.onMeta &&
    prev.onAltScreen === next.onAltScreen &&
    prev.onPtyId === next.onPtyId &&
    prev.rect.left === next.rect.left &&
    prev.rect.top === next.rect.top &&
    prev.rect.width === next.rect.width &&
    prev.rect.height === next.rect.height
  );
}

const PaneLeaf = memo(PaneLeafInner, paneLeafEqual);

// ── Divider ──────────────────────────────────────────────────────────────────

interface DividerProps {
  divider: DividerLine;
  hostRef: React.RefObject<HTMLDivElement | null>;
  onSetRatio: (path: SplitPath, ratio: number) => void;
}

function DividerInner({ divider, hostRef, onSetRatio }: DividerProps): React.ReactElement {
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Don't let pointer-down on the divider bubble into a sibling
      // pane wrapper and steal focus.
      e.stopPropagation();
      const host = hostRef.current;
      if (host === null) return;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const hostRect = host.getBoundingClientRect();
      const { splitRect, direction, path } = divider;

      const computeRatio = (clientX: number, clientY: number): number => {
        if (direction === "row") {
          const xPct = ((clientX - hostRect.left) / hostRect.width) * 100;
          return (xPct - splitRect.left) / splitRect.width;
        }
        const yPct = ((clientY - hostRect.top) / hostRect.height) * 100;
        return (yPct - splitRect.top) / splitRect.height;
      };

      const handleMove = (ev: PointerEvent): void => {
        onSetRatio(path, computeRatio(ev.clientX, ev.clientY));
      };

      const handleUp = (ev: PointerEvent): void => {
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          // already released
        }
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleUp);
        target.removeEventListener("pointercancel", handleUp);
      };

      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleUp);
      target.addEventListener("pointercancel", handleUp);
    },
    [divider, hostRef, onSetRatio],
  );

  return (
    <div
      data-testid="layout-divider"
      data-direction={divider.direction}
      data-path={divider.path.join("")}
      style={dividerHitStyle(divider)}
      onPointerDown={startDrag}
    >
      <div style={dividerLineStyle(divider.direction)} />
    </div>
  );
}

const Divider = memo(DividerInner);

// ── LayoutRender ─────────────────────────────────────────────────────────────

export function LayoutRender({
  tabId,
  node,
  focusedPaneId,
  tabActive,
  onPaneFocus,
  onPaneMeta,
  onPaneAltScreen,
  onPanePtyId,
  onSetRatio,
}: LayoutRenderProps): React.ReactElement {
  const geometry = useMemo(() => computeGeometry(node), [node]);
  const hostRef = useRef<HTMLDivElement>(null);

  // Bind `tabId` once per (tabId, base callback) — stable across every
  // re-render that doesn't change tabId or the base callback.
  const handleFocus = useCallback(
    (paneId: PaneId) => onPaneFocus(tabId, paneId),
    [tabId, onPaneFocus],
  );
  const handleMeta = useCallback(
    (paneId: PaneId, cwd: string | null, branch: string | null) =>
      onPaneMeta(tabId, paneId, cwd, branch),
    [tabId, onPaneMeta],
  );
  const handleAltScreen = useCallback(
    (paneId: PaneId, active: boolean) => onPaneAltScreen(tabId, paneId, active),
    [tabId, onPaneAltScreen],
  );
  const handlePtyId = useCallback(
    (paneId: PaneId, ptyId: string | null) => onPanePtyId(tabId, paneId, ptyId),
    [tabId, onPanePtyId],
  );
  const handleSetRatio = useCallback(
    (path: SplitPath, ratio: number) => onSetRatio(tabId, path, ratio),
    [tabId, onSetRatio],
  );

  return (
    <div data-testid="layout-host" ref={hostRef} style={HOST}>
      {geometry.panes.map((p) => (
        <PaneLeaf
          key={p.paneId}
          paneId={p.paneId}
          rect={p.rect}
          isFocused={p.paneId === focusedPaneId}
          tabActive={tabActive}
          showFocusRing={geometry.panes.length > 1}
          onFocus={handleFocus}
          onMeta={handleMeta}
          onAltScreen={handleAltScreen}
          onPtyId={handlePtyId}
        />
      ))}
      {geometry.dividers.map((d, i) => (
        <Divider key={`d-${i}`} divider={d} hostRef={hostRef} onSetRatio={handleSetRatio} />
      ))}
    </div>
  );
}
