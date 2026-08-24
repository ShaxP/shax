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

import { Fragment, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import "./Sidebar.css";
import { BatteryWidget } from "./widgets/BatteryWidget";
import { CaffeinateWidget } from "./widgets/CaffeinateWidget";
import { CalendarWidget } from "./widgets/CalendarWidget";
import { ClockWidget } from "./widgets/ClockWidget";
import { CpuWidget } from "./widgets/CpuWidget";
import { DiskWidget } from "./widgets/DiskWidget";
import { GitBranchWidget } from "./widgets/GitBranchWidget";
import { MemoryWidget } from "./widgets/MemoryWidget";
import { NetworkWidget } from "./widgets/NetworkWidget";

// Rail bumped from the M13.1 44 px to 56 px for M13.5.5 (§D11):
// the mini data cards — sparkline, donut, throughput arrows, battery
// bar — need more horizontal room than a single glyph did, and §D11
// caps the growth at 56 so we're not sliding toward "small expanded
// state." At 56 px with an 8 px gutter, the content area is 40 px —
// enough for a 32-pixel donut, a 40-column sparkline, or a two-digit
// number in the biggest mono weight.
const RAIL_WIDTH = 56;
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

// 1px rule at `--border`, spans the content column between the rail's
// side gutters. Rail-only per §D11 amendment — expanded uses each
// widget's card border to separate. `flexShrink: 0` keeps the rule
// from being squeezed to zero-height if the sidebar overflow-scrolls.
//
// The `sidebar-rail-divider` className carries the dedup rules that
// hide adjacent / leading / trailing dividers when a widget between
// them returns null (Battery on no-battery hosts, GitBranch outside
// a repo, and so on). See `Sidebar.css` for the rules and rationale.
const RAIL_DIVIDER: CSSProperties = {
  height: 1,
  background: "var(--border)",
  flexShrink: 0,
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
        {/* Widget order is the M13.5 target per §D5 / D8 / D9 —
         *  Calendar sits under Clock, Network above CPU/Memory,
         *  Battery under Memory, Repo and Caffeinate at the tail.
         *  Fixed for M13.5; drag-to-reorder is Phase 2.
         *
         *  In the collapsed rail (§D11 amendment) each widget is
         *  followed by a 1px rule at `--border` — the mini-cards
         *  are dense enough that the flex-gap alone doesn't read
         *  as "one card per widget", and a divider gives each row
         *  a clear top/bottom edge so the eye scans the rail as a
         *  stack, not a run-on column. Expanded state doesn't need
         *  this — each card owns its own border. */}
        {renderWidgets(visible)}
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

/** The widget stack. In expanded state each widget renders back-to-back
 *  and gap-separated; in the rail we interleave a 1px `--border` divider
 *  between them per §D11 amendment. The rule sits between rows, not
 *  above the first or below the last — the outer sidebar border and
 *  the toggle chrome handle those edges.
 *
 *  Split out from `Sidebar` so the interleave logic reads as a single
 *  intent and the render tree stays declarative. */
function renderWidgets(visible: boolean): React.ReactElement[] {
  const widgets: Array<[string, React.ReactElement]> = [
    ["clock", <ClockWidget visible={visible} />],
    ["calendar", <CalendarWidget visible={visible} />],
    ["network", <NetworkWidget visible={visible} />],
    ["cpu", <CpuWidget visible={visible} />],
    ["memory", <MemoryWidget visible={visible} />],
    ["disk", <DiskWidget visible={visible} />],
    ["battery", <BatteryWidget visible={visible} />],
    ["git", <GitBranchWidget visible={visible} />],
    ["caffeinate", <CaffeinateWidget visible={visible} />],
  ];

  // Fragment (not a wrapping <span> / <div>) so each widget's own
  // root element becomes the direct flex child of `widgetSlot` —
  // its intrinsic block layout survives the interleave.
  if (visible) {
    return widgets.map(([key, node]) => <Fragment key={key}>{node}</Fragment>);
  }

  const rendered: React.ReactElement[] = [];
  widgets.forEach(([key, node], index) => {
    if (index > 0) {
      rendered.push(
        <div
          key={`divider-${key}`}
          className="sidebar-rail-divider"
          style={RAIL_DIVIDER}
          data-testid="sidebar-rail-divider"
          aria-hidden="true"
        />,
      );
    }
    rendered.push(<Fragment key={key}>{node}</Fragment>);
  });
  return rendered;
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
