/**
 * GitBranchWidget (M13.2, spec §19 D5).
 *
 * Reads the focused pane's cwd + branch + ahead/behind via
 * `useFocusedPane()`. Updates on pane focus change and on the
 * pane's next OSC 133 A (which is what refreshes cwd/branch/ahead/
 * behind up in App state). No polling, no git-command shell-out.
 *
 * Two renders:
 *   - Expanded: ⎇ branch  ↑n ↓n (both ahead/behind hidden when 0 or null)
 *   - Rail:    ⎇ glyph, hover tooltip shows branch + counts
 *
 * Hidden when no pane is focused OR the focused pane's cwd isn't a
 * git repo (branch === null). "Hidden" here means the widget
 * renders `null` — nothing appears in the sidebar. Spec §D5 pins
 * this behaviour ("Hidden when no pane focus / non-repo cwd").
 */

import type { CSSProperties } from "react";
import { useFocusedPane } from "../../lib/FocusedPaneContext";

const EXPANDED_ROOT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  fontSize: 12,
  color: "var(--fg)",
};

const BRANCH_GLYPH: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-dim)",
  flexShrink: 0,
};

const BRANCH_NAME: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
};

const AHEAD_BEHIND: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  color: "var(--fg-dim)",
  flexShrink: 0,
};

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 32,
  fontSize: 14,
  color: "var(--fg-dim)",
  cursor: "default",
};

export interface GitBranchWidgetProps {
  visible: boolean;
}

export function GitBranchWidget({ visible }: GitBranchWidgetProps): React.ReactElement | null {
  const focused = useFocusedPane();

  // Hidden when no pane / non-repo pane. This is not a fallback
  // string ("no branch") because a chip that reads "no branch" on
  // every non-repo pane would be noise — the absence conveys the
  // same information more calmly.
  if (focused === null || focused.branch === null) return null;

  const { branch, ahead, behind } = focused;
  const showAhead = typeof ahead === "number" && ahead > 0;
  const showBehind = typeof behind === "number" && behind > 0;

  const tooltip = buildTooltip(branch, ahead, behind);

  if (!visible) {
    return (
      <div data-testid="sidebar-git-branch-rail" style={RAIL_ROOT} title={tooltip}>
        ⎇
      </div>
    );
  }

  return (
    <div data-testid="sidebar-git-branch" style={EXPANDED_ROOT} title={tooltip}>
      <span style={BRANCH_GLYPH}>⎇</span>
      <span style={BRANCH_NAME}>{branch}</span>
      {(showAhead || showBehind) && (
        <span style={AHEAD_BEHIND} data-testid="sidebar-git-branch-counts">
          {showAhead && <span>↑{ahead}</span>}
          {showBehind && <span>↓{behind}</span>}
        </span>
      )}
    </div>
  );
}

function buildTooltip(branch: string, ahead: number | null, behind: number | null): string {
  const parts: string[] = [`Branch: ${branch}`];
  if (typeof ahead === "number") parts.push(`↑${ahead} ahead of upstream`);
  if (typeof behind === "number") parts.push(`↓${behind} behind upstream`);
  return parts.join(" · ");
}
