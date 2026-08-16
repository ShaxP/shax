/**
 * Sidebar (M13.1, spec §19).
 *
 * The persistent left-column surface. Two states, controlled from
 * App:
 *   - Expanded (280px): full widget content.
 *   - Collapsed (44px): icon rail — one glyph per widget.
 *
 * A chevron button at the bottom toggles between the two states,
 * along with the App-level ⌘B keybind and the "Sidebar: expand /
 * collapse" palette command. All three routes ultimately call
 * `onToggle`.
 *
 * M13.1 ships the chrome only. The widget slot renders a "no widgets
 * yet" placeholder when expanded, and stays empty in the rail. M13.2
 * / M13.3 / M13.4 populate the slot.
 *
 * Focus contract (spec §D4). The sidebar never steals keyboard focus
 * on click. Every mousedown on the sidebar root that lands on a
 * non-focusable target calls `preventDefault()`, which stops the
 * browser's default blur behaviour — so whatever owns focus (prompt
 * strip, assistant textarea) keeps it after the click resolves. Same
 * pattern as BlockList and TitleBar's tab pill.
 *
 * Unlike those two, the sidebar does NOT dispatch `shax:refocus-pane`
 * because doing so would steal focus from the assistant back to the
 * pane on any sidebar click, which is wrong when the user is
 * mid-conversation.
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

const RAIL_WIDTH = 44;
const EXPANDED_WIDTH = 280;

const ROOT_BASE: CSSProperties = {
  height: "100%",
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--pane)",
  borderRight: "1px solid var(--border)",
  transition: "width 150ms ease-out",
  overflow: "hidden",
};

const WIDGET_SLOT: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: 8,
  overflowY: "auto",
};

const EMPTY_HINT: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-faint)",
  padding: "12px 8px",
  textAlign: "center",
};

const TOGGLE_BUTTON: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 28,
  margin: 8,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "transparent",
  color: "var(--fg-dim)",
  cursor: "pointer",
  padding: 0,
};

export interface SidebarProps {
  visible: boolean;
  onToggle: () => void;
}

export function Sidebar({ visible, onToggle }: SidebarProps): React.ReactElement {
  // preventDefault on mousedown for non-focusable targets so clicking
  // sidebar chrome doesn't blur whatever owns focus. Buttons inside
  // (the toggle) still receive their click via mouseup — preventDefault
  // on mousedown only stops the default focus change, not the click
  // event itself. Same shape as BlockList's background handler.
  const onRootMouseDown = (e: ReactMouseEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target === null) return;
    if (
      target.closest(
        "button, a[href], input, textarea, select, [contenteditable=''], [contenteditable='true']",
      ) !== null
    ) {
      return;
    }
    e.preventDefault();
  };

  const root: CSSProperties = {
    ...ROOT_BASE,
    width: visible ? EXPANDED_WIDTH : RAIL_WIDTH,
  };

  return (
    <aside
      data-testid="sidebar"
      data-visible={visible ? "true" : "false"}
      aria-label="Sidebar"
      style={root}
      onMouseDown={onRootMouseDown}
    >
      <div data-testid="sidebar-widgets" style={WIDGET_SLOT}>
        {visible && <div style={EMPTY_HINT}>No widgets yet</div>}
      </div>
      <button
        type="button"
        data-testid="sidebar-toggle"
        aria-label={visible ? "Collapse sidebar" : "Expand sidebar"}
        aria-expanded={visible}
        title={visible ? "Collapse sidebar (⌘B)" : "Expand sidebar (⌘B)"}
        style={TOGGLE_BUTTON}
        onClick={onToggle}
      >
        <ChevronIcon direction={visible ? "left" : "right"} />
      </button>
    </aside>
  );
}

/** Chevron pointing left (collapse) or right (expand). Inline SVG
 *  following the SettingsModal convention (PromptIcon). */
function ChevronIcon({ direction }: { direction: "left" | "right" }): React.ReactElement {
  const d = direction === "right" ? "M 6 4 L 10 8 L 6 12" : "M 10 4 L 6 8 L 10 12";
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
