/**
 * Geometry-driven renderer for a tab's pane layout tree.
 *
 * Why "geometry-driven": every TerminalPane is rendered in a *fixed*
 * React position (a flat list keyed by paneId) and only its containing
 * `<div>`'s style changes when the layout tree changes. Without this, a
 * split would change the parent element type (leaf wrapper → split
 * wrapper) and React would unmount + remount the surviving pane,
 * killing and re-spawning its PTY. Computing percentages from the tree
 * and pushing them in via CSS keeps the React tree stable.
 *
 * Each pane sits in an `absolute`-positioned wrapper whose left / top /
 * width / height are percentages of the parent. Dividers (M2 slice 2.2b)
 * are thin lines wrapped in a wider hit-area for easier grabbing —
 * pointer-down on a divider captures the pointer and reports cursor
 * positions as new ratios via `onSetRatio` until pointer-up.
 */

import type { CSSProperties } from "react";
import { useMemo, useRef } from "react";
import { TerminalPane } from "./TerminalPane";
import type { DividerLine, LayoutNode, PaneId, Placement, SplitPath } from "./layout";
import { computeGeometry } from "./layout";

export interface LayoutRenderProps {
  node: LayoutNode;
  focusedPaneId: PaneId;
  tabActive: boolean;
  onPaneFocus: (paneId: PaneId) => void;
  onPaneMeta: (paneId: PaneId, cwd: string | null, branch: string | null) => void;
  onPaneAltScreen: (paneId: PaneId, active: boolean) => void;
  /** Drag-to-resize: caller updates the layout-tree Split at `path`. */
  onSetRatio: (path: SplitPath, ratio: number) => void;
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

function paneWrapStyle(p: Placement, isFocused: boolean): CSSProperties {
  return {
    position: "absolute",
    left: `${p.rect.left}%`,
    top: `${p.rect.top}%`,
    width: `${p.rect.width}%`,
    height: `${p.rect.height}%`,
    display: "flex",
    flexDirection: "column",
    background: "var(--bg)",
    outline: isFocused ? "1px solid var(--accent)" : "1px solid transparent",
    outlineOffset: "-1px",
    overflow: "hidden",
  };
}

/**
 * Hit-area wrapper for a divider. The wrapper is the wide grab region
 * (so the user doesn't have to land on the 1px line); the visible line
 * is a child centred inside it.
 */
function dividerHitStyle(d: DividerLine): CSSProperties {
  const centerLeft = d.splitRect.left + d.splitRect.width * d.ratio;
  const centerTop = d.splitRect.top + d.splitRect.height * d.ratio;
  if (d.direction === "row") {
    // Vertical line: left at centerLeft (in %), width = hit-area px, full height.
    return {
      position: "absolute",
      left: `calc(${centerLeft}% - ${DIVIDER_HIT / 2}px)`,
      top: `${d.splitRect.top}%`,
      width: `${DIVIDER_HIT}px`,
      height: `${d.splitRect.height}%`,
      cursor: "ew-resize",
      zIndex: 6,
      // Keep the hit-area transparent — only the inner line is visible.
      background: "transparent",
      touchAction: "none",
    };
  }
  // Column split → horizontal line: top at centerTop, height = hit-area px.
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

export function LayoutRender({
  node,
  focusedPaneId,
  tabActive,
  onPaneFocus,
  onPaneMeta,
  onPaneAltScreen,
  onSetRatio,
}: LayoutRenderProps): React.ReactElement {
  const geometry = useMemo(() => computeGeometry(node), [node]);
  const hostRef = useRef<HTMLDivElement>(null);

  const startDrag =
    (divider: DividerLine) =>
    (e: React.PointerEvent<HTMLDivElement>): void => {
      // Left-button only.
      if (e.button !== 0) return;
      e.preventDefault();
      // Avoid the divider's pointerdown bubbling into a pane wrapper
      // (which would steal focus from the user's actual pane).
      e.stopPropagation();
      const host = hostRef.current;
      if (host === null) return;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const hostRect = host.getBoundingClientRect();
      const { splitRect, direction, path } = divider;

      const computeRatio = (clientX: number, clientY: number): number => {
        if (direction === "row") {
          // Cursor x as percent of the host, minus the split's left edge.
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
          // pointer was already released
        }
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleUp);
        target.removeEventListener("pointercancel", handleUp);
      };

      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleUp);
      target.addEventListener("pointercancel", handleUp);
    };

  return (
    <div data-testid="layout-host" ref={hostRef} style={HOST}>
      {geometry.panes.map((p) => {
        const isFocused = p.paneId === focusedPaneId;
        return (
          <div
            key={p.paneId}
            data-testid="layout-leaf"
            data-pane-id={p.paneId}
            data-focused={isFocused ? "true" : "false"}
            style={paneWrapStyle(p, isFocused)}
            onPointerDown={() => onPaneFocus(p.paneId)}
          >
            <TerminalPane
              active={tabActive && isFocused}
              onMetaChange={(cwd, branch) => onPaneMeta(p.paneId, cwd, branch)}
              onAltScreenChange={(altScreen) => onPaneAltScreen(p.paneId, altScreen)}
            />
          </div>
        );
      })}
      {geometry.dividers.map((d, i) => (
        <div
          key={`d-${i}`}
          data-testid="layout-divider"
          data-direction={d.direction}
          data-path={d.path.join("")}
          style={dividerHitStyle(d)}
          onPointerDown={startDrag(d)}
        >
          <div style={dividerLineStyle(d.direction)} />
        </div>
      ))}
    </div>
  );
}
