/**
 * TitleBar — the top chrome row of the Shax window.
 *
 * As of M2 slice 2.1 the tab bar is real: the host passes in the live
 * list of tabs plus the active id, and the bar renders them with click-
 * to-switch, hover-to-show-close, and a `+` button on the right of the
 * row to spawn a new tab. The split-screen and search/assistant icons
 * are still visual-only — they light up in later slices.
 *
 * Traffic lights are NOT painted here: Tauri uses native window decorations
 * on every platform. On macOS the Tauri config opts into
 * `titleBarStyle: "Overlay"` so the native traffic lights float over the
 * webview's top-left corner; we keep an extra left gutter on macOS so the
 * first tab does not crowd the close button.
 *
 * Window dragging is wired via an explicit `onMouseDown` handler that
 * calls `getCurrentWindow().startDragging()` from the Tauri API. Tabs and
 * the toolbar opt out of the drag region so clicks on them act as
 * buttons, not window drags.
 *
 * Visuals follow the design at `/design/Shax Main Shell.dc.html` and
 * consume tokens from `src/theme/tokens.css`.
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const IS_MAC = ((): boolean => {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/i.test(navigator.userAgent);
})();

// Reserve space for the native traffic lights on macOS overlay title bars.
const MAC_TRAFFIC_LIGHT_INSET = 78;

export interface TabDescriptor {
  /** Stable id; the host uses this for switch / close callbacks. */
  id: string;
  /** Short display name shown on the tab (e.g., the shell binary). */
  label: string;
  /** Working directory shown after the label, ellipsised on overflow. */
  cwd: string | null;
}

export interface TitleBarProps {
  tabs: TabDescriptor[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  /** Optional: clicking the search pill opens the overlay. ⌘K does the same. */
  onSearch?: () => void;
}

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  height: 38,
  paddingTop: 0,
  paddingBottom: 0,
  paddingLeft: IS_MAC ? MAC_TRAFFIC_LIGHT_INSET : 14,
  paddingRight: 14,
  background: "var(--titlebar)",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
  fontFamily: "var(--font-ui)",
  userSelect: "none",
};

const TABS_ROW: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 2,
  height: "100%",
  flex: 1,
  minWidth: 0,
};

const TAB_BASE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  height: 34,
  padding: "0 10px 0 14px",
  borderRadius: "8px 8px 0 0",
  marginBottom: -1,
  maxWidth: 320,
  cursor: "pointer",
};

const TAB_ACTIVE: CSSProperties = {
  ...TAB_BASE,
  background: "var(--pane)",
  border: "1px solid var(--border)",
  borderBottom: "1px solid var(--pane)",
};

const TAB_INACTIVE: CSSProperties = {
  ...TAB_BASE,
  background: "transparent",
  border: "1px solid transparent",
  opacity: 0.7,
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
  flex: 1,
};

const TAB_CLOSE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  borderRadius: "var(--radius-sm)",
  fontSize: 14,
  color: "var(--fg-faint)",
  cursor: "pointer",
  flexShrink: 0,
};

const NEW_TAB_BTN: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  marginLeft: 2,
  marginBottom: 4,
  borderRadius: "var(--radius-sm)",
  color: "var(--fg-faint)",
  fontSize: 16,
  cursor: "pointer",
  alignSelf: "flex-end",
  flexShrink: 0,
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

function isInsideTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function handleTitleBarMouseDown(e: ReactMouseEvent<HTMLDivElement>): void {
  if (e.button !== 0) return;
  if (e.target instanceof HTMLElement) {
    if (e.target.closest('[data-tauri-drag-region="false"]') !== null) return;
  }
  if (!isInsideTauri()) return;
  void getCurrentWindow().startDragging();
}

export function TitleBar({
  tabs,
  activeId,
  onSwitch,
  onNew,
  onClose,
  onSearch,
}: TitleBarProps): React.ReactElement {
  return (
    <div
      data-testid="title-bar"
      data-tauri-drag-region=""
      style={ROW}
      onMouseDown={handleTitleBarMouseDown}
    >
      <div style={TABS_ROW} data-testid="title-tabs">
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          const allowClose = tabs.length > 1;
          return (
            <div
              key={tab.id}
              data-testid="title-tab"
              data-tab-id={tab.id}
              data-active={isActive ? "true" : "false"}
              data-tauri-drag-region="false"
              style={isActive ? TAB_ACTIVE : TAB_INACTIVE}
              onClick={() => onSwitch(tab.id)}
            >
              <span style={TAB_ACCENT_DOT} />
              <span style={TAB_NAME}>{tab.label}</span>
              <span style={TAB_PATH}>{tab.cwd ?? "—"}</span>
              {allowClose && (
                <span
                  data-testid="title-tab-close"
                  style={TAB_CLOSE}
                  onClick={(e) => {
                    // Don't let the click bubble into the tab and switch
                    // focus to the just-closed tab.
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                  title="Close tab"
                >
                  ×
                </span>
              )}
            </div>
          );
        })}
        <span
          data-testid="title-new-tab"
          data-tauri-drag-region="false"
          style={NEW_TAB_BTN}
          onClick={onNew}
          title="New tab"
        >
          +
        </span>
      </div>

      <div style={TOOLBAR} data-testid="title-toolbar" data-tauri-drag-region="false">
        <span title="split vertical" style={ICON_BTN}>
          ⧉
        </span>
        <span title="split horizontal" style={ICON_BTN}>
          ⧈
        </span>
        <span
          data-testid="title-search"
          title="Search (⌘K)"
          style={{ ...SEARCH_PILL, cursor: onSearch !== undefined ? "pointer" : "default" }}
          onClick={onSearch}
        >
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
