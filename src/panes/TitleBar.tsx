/**
 * TitleBar — the top chrome row of the Shax window.
 *
 * Renders the traffic lights, the active tab pill, and the right-side toolbar
 * icons (split, search, assistant, settings). All interactivity here is
 * visual-only at M1.5; behaviour (real tabs, split panes, search overlay,
 * assistant invocation) lands in M2 / M3 / M6 as those milestones come up.
 *
 * The active tab pill draws its label from the live PTY's cwd (passed in by
 * the parent). When no cwd is known yet, the pill renders a neutral fallback
 * so the layout doesn't reflow on first prompt.
 *
 * Visuals follow the design at `/design/Shax Main Shell.dc.html` and consume
 * tokens from `src/theme/tokens.css`.
 */

import type { CSSProperties } from "react";

export interface TitleBarProps {
  /** The current working directory of the active pane, if known. */
  cwd: string | null;
  /** A short display name for the active tab (e.g., the shell binary). */
  tabLabel?: string;
}

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  height: 46,
  padding: "0 14px",
  background: "var(--titlebar)",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
  fontFamily: "var(--font-ui)",
};

const TRAFFIC: CSSProperties = {
  display: "flex",
  gap: 8,
  flexShrink: 0,
};

const DOT = (color: string): CSSProperties => ({
  width: 11,
  height: 11,
  borderRadius: "50%",
  background: color,
});

const TABS_ROW: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 2,
  height: "100%",
  flex: 1,
  minWidth: 0,
};

const ACTIVE_TAB: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  height: 34,
  padding: "0 14px",
  background: "var(--pane)",
  border: "1px solid var(--border)",
  borderBottom: "1px solid var(--pane)",
  borderRadius: "8px 8px 0 0",
  marginBottom: -1,
  maxWidth: 320,
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

const TOOLBAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  flexShrink: 0,
  color: "var(--fg-faint)",
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
      <div style={TRAFFIC}>
        <span style={DOT("#e0635a")} aria-label="close" />
        <span style={DOT("#e0ab4f")} aria-label="minimize" />
        <span style={DOT("#56b770")} aria-label="zoom" />
      </div>

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
