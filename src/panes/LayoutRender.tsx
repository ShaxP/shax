/**
 * Geometry-driven renderer for a tab's pane layout tree (M2 slice 2.2a).
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
 * width / height are percentages of the parent. Dividers are rendered
 * the same way — thin lines positioned on the boundary between two
 * children of a split. Click-to-focus fires from a pointer-down on the
 * pane wrapper; the focus ring is drawn as a separate non-interactive
 * overlay so it doesn't steal pointer events from the pane.
 */

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { TerminalPane } from "./TerminalPane";
import type { DividerLine, LayoutNode, PaneId, Placement } from "./layout";
import { computeGeometry } from "./layout";

export interface LayoutRenderProps {
  node: LayoutNode;
  focusedPaneId: PaneId;
  tabActive: boolean;
  onPaneFocus: (paneId: PaneId) => void;
  onPaneMeta: (paneId: PaneId, cwd: string | null, branch: string | null) => void;
  onPaneAltScreen: (paneId: PaneId, active: boolean) => void;
}

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

function dividerStyle(d: DividerLine): CSSProperties {
  return {
    position: "absolute",
    left: `${d.rect.left}%`,
    top: `${d.rect.top}%`,
    width: d.direction === "row" ? "1px" : `${d.rect.width}%`,
    height: d.direction === "column" ? "1px" : `${d.rect.height}%`,
    background: "var(--border)",
    pointerEvents: "none",
    zIndex: 5,
  };
}

export function LayoutRender({
  node,
  focusedPaneId,
  tabActive,
  onPaneFocus,
  onPaneMeta,
  onPaneAltScreen,
}: LayoutRenderProps): React.ReactElement {
  // Memoise the geometry by tree identity — splits / closes change the
  // node reference; cosmetic re-renders (focus, meta updates) don't.
  const geometry = useMemo(() => computeGeometry(node), [node]);

  return (
    <div data-testid="layout-host" style={HOST}>
      {geometry.panes.map((p) => {
        const isFocused = p.paneId === focusedPaneId;
        return (
          <div
            key={p.paneId}
            data-testid="layout-leaf"
            data-pane-id={p.paneId}
            data-focused={isFocused ? "true" : "false"}
            style={paneWrapStyle(p, isFocused)}
            // Pointer-down focuses before the prompt strip's keydown
            // has a chance to fire elsewhere.
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
          style={dividerStyle(d)}
        />
      ))}
    </div>
  );
}
