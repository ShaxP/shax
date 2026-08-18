/**
 * Sidebar (M13, spec §19).
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
 * Widget list is hardcoded for Phase 1 (spec §D5 locks the set and
 * order). Each widget accepts a `visible` prop so it can render
 * differently in the expanded and rail states, and consumes its
 * data via a Context (ClockContext, FocusedPaneContext) rather than
 * receiving prop-drilled state through the Sidebar.
 *
 * Focus contract (spec §D4). The sidebar never steals keyboard focus
 * on click. Every mousedown on the sidebar root that lands on a
 * non-text-input target calls `preventDefault()`, which stops the
 * browser's default blur behaviour — so whatever owns focus (prompt
 * strip, assistant textarea) keeps it after the click resolves.
 * Buttons are included in this rule — spec §D4 requires clicks on
 * sidebar buttons to preserve focus too (see the divergence note
 * on `onRootMouseDown` below).
 *
 * Unlike BlockList and TitleBar's tab pill, the sidebar does NOT
 * dispatch `shax:refocus-pane` — doing so would steal focus from
 * the assistant back to the pane on any sidebar click, which is
 * wrong when the user is mid-conversation.
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { CaffeinateWidget } from "./widgets/CaffeinateWidget";
import { ClockWidget } from "./widgets/ClockWidget";
import { CpuWidget } from "./widgets/CpuWidget";
import { GitBranchWidget } from "./widgets/GitBranchWidget";
import { MemoryWidget } from "./widgets/MemoryWidget";
import { NetworkWidget } from "./widgets/NetworkWidget";

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

// Gutter and inter-card gap are measured off design/
// widget-sidebar.png (13px gutter, 11px gap at the mockup's 248px
// render width), scaled to the 280px expanded sidebar. Now that the
// cards are outlined rather than filled, the gutter is what separates
// the column from the pane edge — too tight and the borders read as a
// table.
//
// The rail keeps the original 8px: at 44px wide, a 14px gutter would
// leave 16px of content and clip the two-digit glyphs.
const EXPANDED_GUTTER = 14;
const RAIL_GUTTER = 8;

const WIDGET_SLOT_BASE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflowY: "auto",
};

const TOGGLE_BUTTON_BASE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 28,
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
  // preventDefault on mousedown so clicking sidebar chrome doesn't
  // blur whatever owns focus (prompt strip, assistant textarea).
  // Sidebar clicks — including button clicks — never steal focus per
  // spec §D4. preventDefault on mousedown stops the default focus
  // change but does NOT cancel the click event that fires on
  // mouseup, so the chevron toggle still fires normally.
  //
  // Text inputs are the one opt-out: a user clicking into a text
  // input (e.g. a Phase-2 widget with a label field) genuinely wants
  // to focus it. No text inputs exist in Phase 1, but the rule is
  // future-proof.
  //
  // Divergence from the BlockList pattern (which excludes button /
  // a[href] as well) is deliberate — BlockList's chrome buttons
  // (copy, view) sit inside the pane's focus scope and want focus;
  // sidebar buttons are top-level actions that never do.
  const onRootMouseDown = (e: ReactMouseEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target === null) return;
    if (
      target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !==
      null
    ) {
      return;
    }
    e.preventDefault();
  };

  const gutter = visible ? EXPANDED_GUTTER : RAIL_GUTTER;

  const root: CSSProperties = {
    ...ROOT_BASE,
    width: visible ? EXPANDED_WIDTH : RAIL_WIDTH,
  };

  const widgetSlot: CSSProperties = {
    ...WIDGET_SLOT_BASE,
    padding: gutter,
    gap: visible ? 12 : 8,
  };

  // Horizontal margin tracks the gutter so the chevron's edges line
  // up with the card column above it.
  const toggleButton: CSSProperties = {
    ...TOGGLE_BUTTON_BASE,
    margin: `8px ${gutter}px ${gutter}px`,
  };

  return (
    <aside
      data-testid="sidebar"
      data-visible={visible ? "true" : "false"}
      aria-label="Sidebar"
      style={root}
      onMouseDown={onRootMouseDown}
    >
      <div data-testid="sidebar-widgets" style={widgetSlot}>
        <ClockWidget visible={visible} />
        <CpuWidget visible={visible} />
        <MemoryWidget visible={visible} />
        <NetworkWidget visible={visible} />
        <GitBranchWidget visible={visible} />
        <CaffeinateWidget visible={visible} />
      </div>
      <button
        type="button"
        data-testid="sidebar-toggle"
        aria-label={visible ? "Collapse sidebar" : "Expand sidebar"}
        aria-expanded={visible}
        title={visible ? "Collapse sidebar (⌘B)" : "Expand sidebar (⌘B)"}
        style={toggleButton}
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
