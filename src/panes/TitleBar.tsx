/**
 * TitleBar — the top chrome row of the Shax window.
 *
 * Renders the active tab pill and the right-side toolbar icons (split,
 * search, assistant, settings). All interactivity here is visual-only at
 * M1.5; behaviour (real tabs, split panes, search overlay, assistant
 * invocation) lands in M2 / M3 / M6 as those milestones come up.
 *
 * Traffic lights are NOT painted here: Tauri uses native window decorations
 * on every platform, so macOS and Windows already render their own
 * close/minimise/zoom controls. On macOS the Tauri config opts into
 * `titleBarStyle: "Overlay"` (see `src-tauri/tauri.conf.json`), so the
 * native traffic lights float over the webview's top-left corner.
 *
 * The layout follows Chrome's unified-title-bar pattern: the active tab
 * pill is anchored to the top-left of the window with its top-left corner
 * un-rounded, so the traffic-light cluster floats over the tab's left
 * edge. To keep the tab's text and accent dot legible past the cluster,
 * the tab itself carries extra left-padding on macOS. On Windows and Linux
 * the native title bar sits above this row and no inset is needed.
 *
 * The row background is marked `-webkit-app-region: drag` so the user can
 * still drag the window from any empty area of the title bar; the active
 * tab and the toolbar icons opt back out with `no-drag` so they remain
 * clickable when we wire their behaviours up in later milestones.
 *
 * The active tab pill draws its label from the live PTY's cwd (passed in by
 * the parent). When no cwd is known yet, the pill renders a neutral fallback
 * so the layout doesn't reflow on first prompt.
 *
 * Visuals follow the design at `/design/Shax Main Shell.dc.html` and consume
 * tokens from `src/theme/tokens.css`.
 */

import type { CSSProperties } from "react";

// `-webkit-app-region` is a Chromium-only CSS property that the React types
// don't include. Extend CSSProperties locally so the title bar can claim
// drag (and its children can opt out) without an `any` cast.
type DragRegion = "drag" | "no-drag";
interface DraggableStyle extends CSSProperties {
  WebkitAppRegion?: DragRegion;
}

const IS_MAC = ((): boolean => {
  if (typeof navigator === "undefined") return false;
  // jsdom and CI Linux Chromium do not contain "Mac"; real macOS Tauri
  // webviews and Chromium-on-mac both do. This is enough to gate the
  // overlay padding without pulling in a Tauri-only OS plugin.
  return /Mac|iPhone|iPad/i.test(navigator.userAgent);
})();

// Reserve space for the native traffic lights on macOS overlay title bars.
// Default macOS button cluster is ~70px wide once you include the right-side
// breathing room.
const MAC_TRAFFIC_LIGHT_INSET = 78;

export interface TitleBarProps {
  /** The current working directory of the active pane, if known. */
  cwd: string | null;
  /** A short display name for the active tab (e.g., the shell binary). */
  tabLabel?: string;
}

const ROW: DraggableStyle = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  height: 46,
  paddingTop: 0,
  paddingBottom: 0,
  // Small gutter on macOS so the tab sits a touch right of the traffic
  // lights instead of flush against the corner.
  paddingLeft: IS_MAC ? 12 : 14,
  paddingRight: 14,
  background: "var(--titlebar)",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
  fontFamily: "var(--font-ui)",
  // Without `user-select: none` Webkit grabs the cursor for text
  // selection before the drag region takes effect, and the user ends up
  // selecting the tab label instead of moving the window.
  userSelect: "none",
  WebkitAppRegion: "drag",
};

const TABS_ROW: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 2,
  height: "100%",
  flex: 1,
  minWidth: 0,
};

const ACTIVE_TAB: DraggableStyle = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  height: 34,
  // Inside-the-tab padding: on macOS the left side has to clear the
  // floating traffic-light cluster (~78px from the window edge) so the
  // accent dot and tab label are visible. The right side keeps the
  // design's 14px breathing room everywhere.
  paddingTop: 0,
  paddingBottom: 0,
  paddingLeft: IS_MAC ? MAC_TRAFFIC_LIGHT_INSET : 14,
  paddingRight: 14,
  background: "var(--pane)",
  border: "1px solid var(--border)",
  borderBottom: "1px solid var(--pane)",
  // Anchor flush to the top-left corner on macOS (no top-left rounding)
  // so the tab visually extends behind the traffic lights — Chrome's
  // unified-title-bar look. Other platforms keep the symmetric pill.
  borderTopLeftRadius: IS_MAC ? 0 : 8,
  borderTopRightRadius: 8,
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
  // On macOS strip the left border too — there is nothing to separate from.
  borderLeftWidth: IS_MAC ? 0 : 1,
  marginBottom: -1,
  // Account for the traffic-light width when capping the tab. Without
  // this the path text would be truncated visibly earlier on macOS.
  maxWidth: IS_MAC ? 320 + MAC_TRAFFIC_LIGHT_INSET : 320,
  WebkitAppRegion: "no-drag",
};

const TAB_ACCENT_DOT: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--accent)",
  flexShrink: 0,
};

const TAB_NAME: CSSProperties = {
  fontSize: 12.5,
  color: "var(--fg)",
  fontWeight: 600,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const TAB_PATH: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-faint)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

const TOOLBAR: DraggableStyle = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  flexShrink: 0,
  color: "var(--fg-faint)",
  WebkitAppRegion: "no-drag",
};

const ICON_BTN: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "var(--radius-sm)",
  fontSize: 14,
  cursor: "default",
};

const SEARCH_PILL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  height: 28,
  padding: "0 9px",
  borderRadius: "var(--radius-sm)",
  fontSize: 12,
  background: "var(--surface)",
  color: "var(--fg-dim)",
  cursor: "default",
};

export function TitleBar({ cwd, tabLabel = "shax" }: TitleBarProps): React.ReactElement {
  return (
    <div data-testid="title-bar" style={ROW}>
      <div style={TABS_ROW}>
        <div data-testid="active-tab" style={ACTIVE_TAB}>
          <span style={TAB_ACCENT_DOT} />
          <span style={TAB_NAME}>{tabLabel}</span>
          <span style={TAB_PATH}>{cwd ?? "—"}</span>
        </div>
      </div>

      <div style={TOOLBAR} data-testid="title-toolbar">
        <span title="split vertical" style={ICON_BTN}>
          ⧉
        </span>
        <span title="split horizontal" style={ICON_BTN}>
          ⧈
        </span>
        <span title="search" style={SEARCH_PILL}>
          ⌕ <span style={{ fontFamily: "var(--font-ui)", fontSize: 11 }}>⌘K</span>
        </span>
        <span title="assistant" style={{ ...ICON_BTN, color: "var(--accent)", fontSize: 13 }}>
          ✦
        </span>
        <span title="settings" style={{ ...ICON_BTN, fontSize: 15 }}>
          ⚙
        </span>
      </div>
    </div>
  );
}
