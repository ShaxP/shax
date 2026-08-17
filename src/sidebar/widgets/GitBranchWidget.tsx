/**
 * GitBranchWidget (M13.2, restyled per design/widget-sidebar.png).
 *
 * Card layout:
 *   - Header row: "REPO" label + branch name (with ⎇ glyph) on the right.
 *   - Below (optional): ahead/behind row with ↑n ↓n counts. Hidden
 *     when both counts are 0 or null.
 *
 * Reads the focused pane's cwd + branch + ahead/behind via
 * `useFocusedPane()`. Updates on pane focus change and on the
 * pane's next OSC 133 A. No polling, no git-command shell-out.
 *
 * Hidden entirely when no pane is focused OR the focused pane's
 * cwd isn't a git repo (branch === null). Widget returns null —
 * no empty card renders in that state.
 */

import type { CSSProperties } from "react";
import { useFocusedPane } from "../../lib/FocusedPaneContext";
import { CARD, CARD_HEADER, CARD_LABEL } from "./styles";

const BRANCH_RIGHT: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 4,
  color: "var(--accent)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const BRANCH_GLYPH: CSSProperties = {
  flexShrink: 0,
};

const AHEAD_BEHIND: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  color: "var(--fg-dim)",
  fontFamily: "var(--font-mono)",
};

const AHEAD: CSSProperties = { color: "var(--green)" };
const BEHIND: CSSProperties = { color: "var(--amber)" };

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
    <div data-testid="sidebar-git-branch" style={CARD} title={tooltip}>
      <div style={CARD_HEADER}>
        <span style={CARD_LABEL}>Repo</span>
        <span style={BRANCH_RIGHT} data-testid="sidebar-git-branch-name">
          <span style={BRANCH_GLYPH}>⎇</span>
          {branch}
        </span>
      </div>
      {(showAhead || showBehind) && (
        <div style={AHEAD_BEHIND} data-testid="sidebar-git-branch-counts">
          {showAhead && <span style={AHEAD}>↑{ahead}</span>}
          {showBehind && <span style={BEHIND}>↓{behind}</span>}
        </div>
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
