/**
 * GitBranchWidget (M13.2, working-tree counts added in the M13
 * refinement pass to match design/widget-sidebar.png).
 *
 * Card layout:
 *   - Header row: "REPO" label + branch name (with ⎇ glyph) on the
 *     right, in accent colour.
 *   - Status row: `+n` staged (green), `~n` modified-unstaged
 *     (amber), `?n` untracked (faint) on the left; `↑n` ahead or
 *     `↓n` behind on the right.
 *
 * Branch and ahead/behind come from `useFocusedPane()` — the M12.4
 * prompt-header machinery already knows them, so there is no probe
 * for those. The working-tree counts do need `git status`, and the
 * refresh policy is what keeps that honest (spec §19 D5 item 4:
 * "updates on pane focus change and on the pane's next OSC 133 A,
 * never polls"):
 *
 *   - on the focused pane changing, or its cwd / branch changing
 *   - when a command completes in the focused pane, since that is
 *     what changes a working tree in a terminal
 *
 * There is deliberately no timer. A file changed by an editor
 * outside Shax won't be reflected until the next command completes
 * in that pane — the honest trade for not shelling out to `git` on
 * a loop for every open window.
 *
 * Hidden entirely when no pane is focused OR the focused pane's cwd
 * isn't a git repo (branch === null).
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { parseGitStatus } from "../../formatters/parseGitStatus";
import { useFocusedPane } from "../../lib/FocusedPaneContext";
import { gitStatusPorcelain } from "../../lib/ipc";
import { CARD, CARD_HEADER, CARD_LABEL } from "./styles";

/** Working-tree counts behind the `+n ~n ?n` row. */
export interface WorkingTreeCounts {
  staged: number;
  modified: number;
  untracked: number;
}

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

const STATUS_ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 11,
  fontFamily: "var(--font-mono)",
};

const COUNTS: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
};

const STAGED: CSSProperties = { color: "var(--green)" };
const MODIFIED: CSSProperties = { color: "var(--amber)" };
const UNTRACKED: CSSProperties = { color: "var(--fg-faint)" };
const SYNC: CSSProperties = { color: "var(--fg-dim)" };

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 1,
  cursor: "default",
  lineHeight: 1.1,
};

const RAIL_GLYPH: CSSProperties = {
  fontSize: 14,
  color: "var(--fg-dim)",
};

// Rail counts — colour-coded like the expanded card's status row.
// Same green / amber / faint / dim vocabulary so the reader doesn't
// have to relearn what each digit means between states.
//
// One vertical stack: every non-zero value on its own line, so the
// full rail readout is a column of {glyph, +n, ~n, ?n, ↑n, ↓n}
// rendered top-to-bottom. Rail width (~40 px) is too tight to pack
// three counts + two sync values into rows at legible font sizes,
// so the vertical stack trades height for readable digit widths.
const RAIL_STACK: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 1,
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 600,
  lineHeight: 1.1,
};

const RAIL_STAGED: CSSProperties = { color: "var(--green)" };
const RAIL_MODIFIED: CSSProperties = { color: "var(--amber)" };
// Untracked is a fainter tier than staged / modified — same signal
// hierarchy as the expanded card's status row.
const RAIL_UNTRACKED: CSSProperties = { color: "var(--fg-faint)" };
// Ahead / behind sit under the working-tree counts in dim mono,
// same colour language as the expanded card's `syncLabel`.
const RAIL_SYNC: CSSProperties = { color: "var(--fg-dim)" };

export interface GitBranchWidgetProps {
  visible: boolean;
}

export function GitBranchWidget({ visible }: GitBranchWidgetProps): React.ReactElement | null {
  const focused = useFocusedPane();
  const cwd = focused?.cwd ?? null;
  const branch = focused?.branch ?? null;
  const paneId = focused?.ptyId ?? null;

  const [counts, setCounts] = useState<WorkingTreeCounts | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback((): void => {
    if (cwd === null || branch === null) {
      setCounts(null);
      return;
    }
    void gitStatusPorcelain(cwd)
      .then((output) => {
        if (mountedRef.current) setCounts(countFrom(output));
      })
      .catch(() => {
        // A repo that vanished, a permission error, a git that isn't
        // there. Drop the counts rather than leaving stale numbers
        // on screen claiming to describe the current tree.
        if (mountedRef.current) setCounts(null);
      });
  }, [cwd, branch]);

  // Focus moved, or the focused pane's cwd / branch changed.
  useEffect(refresh, [refresh]);

  // A command finished in the pane we're describing. In a terminal
  // that is what changes a working tree, so it's the trigger that
  // replaces polling.
  useEffect(() => {
    if (paneId === null) return;
    const onBlockComplete = (e: Event): void => {
      const detail = (e as CustomEvent<{ paneId: string }>).detail;
      if (detail?.paneId === paneId) refresh();
    };
    window.addEventListener("shax:block-complete", onBlockComplete);
    return () => window.removeEventListener("shax:block-complete", onBlockComplete);
  }, [paneId, refresh]);

  if (focused === null || branch === null) return null;

  const { ahead, behind } = focused;
  const sync = syncLabel(ahead, behind);
  const tooltip = buildTooltip(branch, ahead, behind, counts);
  const showCounts = counts !== null && hasAny(counts);

  if (!visible) {
    // Rail: `⎇` glyph over a single vertical stack of every
    // non-zero value the widget tracks — `+staged`, `~modified`,
    // `?untracked`, `↑ahead`, `↓behind`, each on its own line. A
    // clean, in-sync tree shows just the branch glyph; zeros elide
    // the same way the expanded card elides them. The stack goes
    // working-tree first, then sync, matching the expanded card's
    // reading order.
    const stagedOn = counts !== null && counts.staged > 0;
    const modifiedOn = counts !== null && counts.modified > 0;
    const untrackedOn = counts !== null && counts.untracked > 0;
    const aheadOn = typeof ahead === "number" && ahead > 0;
    const behindOn = typeof behind === "number" && behind > 0;
    const anyOn = stagedOn || modifiedOn || untrackedOn || aheadOn || behindOn;
    return (
      <div data-testid="sidebar-git-branch-rail" style={RAIL_ROOT} title={tooltip}>
        <span style={RAIL_GLYPH}>⎇</span>
        {anyOn && (
          <span style={RAIL_STACK} data-testid="sidebar-git-branch-rail-stack">
            {stagedOn && counts !== null && (
              <span style={RAIL_STAGED} data-testid="sidebar-git-branch-rail-staged">
                +{counts.staged}
              </span>
            )}
            {modifiedOn && counts !== null && (
              <span style={RAIL_MODIFIED} data-testid="sidebar-git-branch-rail-modified">
                ~{counts.modified}
              </span>
            )}
            {untrackedOn && counts !== null && (
              <span style={RAIL_UNTRACKED} data-testid="sidebar-git-branch-rail-untracked">
                ?{counts.untracked}
              </span>
            )}
            {aheadOn && (
              <span style={RAIL_SYNC} data-testid="sidebar-git-branch-rail-ahead">
                ↑{ahead}
              </span>
            )}
            {behindOn && (
              <span style={RAIL_SYNC} data-testid="sidebar-git-branch-rail-behind">
                ↓{behind}
              </span>
            )}
          </span>
        )}
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
      {(showCounts || sync !== null) && (
        <div style={STATUS_ROW} data-testid="sidebar-git-branch-counts">
          <span style={COUNTS}>
            {showCounts && counts.staged > 0 && (
              <span style={STAGED} data-testid="sidebar-git-staged">
                +{counts.staged}
              </span>
            )}
            {showCounts && counts.modified > 0 && (
              <span style={MODIFIED} data-testid="sidebar-git-modified">
                ~{counts.modified}
              </span>
            )}
            {showCounts && counts.untracked > 0 && (
              <span style={UNTRACKED} data-testid="sidebar-git-untracked">
                ?{counts.untracked}
              </span>
            )}
          </span>
          {sync !== null && (
            <span style={SYNC} data-testid="sidebar-git-sync">
              {sync}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Counts from porcelain v2. Reuses the M4 parser rather than
 *  re-reading the format — note it already buckets a file that is
 *  both staged and further edited into *both* lists, which is what
 *  makes `+1 ~1` for one file correct rather than double-counting. */
export function countFrom(porcelainOutput: string): WorkingTreeCounts {
  const status = parseGitStatus(porcelainOutput);
  return {
    staged: status.staged.length,
    modified: status.unstaged.length,
    untracked: status.untracked.length,
  };
}

function hasAny(counts: WorkingTreeCounts): boolean {
  return counts.staged > 0 || counts.modified > 0 || counts.untracked > 0;
}

/** `↑n` when ahead, `↓n` when behind, `↑n ↓n` when both (a diverged
 *  branch is a real state and hiding half of it would mislead), and
 *  null when in sync or unknown. */
function syncLabel(ahead: number | null, behind: number | null): string | null {
  const up = typeof ahead === "number" && ahead > 0 ? `↑${ahead}` : null;
  const down = typeof behind === "number" && behind > 0 ? `↓${behind}` : null;
  if (up === null && down === null) return null;
  return [up, down].filter((part) => part !== null).join(" ");
}

function buildTooltip(
  branch: string,
  ahead: number | null,
  behind: number | null,
  counts: WorkingTreeCounts | null,
): string {
  const parts: string[] = [`Branch: ${branch}`];
  if (typeof ahead === "number" && ahead > 0) parts.push(`↑${ahead} ahead of upstream`);
  if (typeof behind === "number" && behind > 0) parts.push(`↓${behind} behind upstream`);
  if (counts !== null) {
    if (counts.staged > 0) parts.push(`${counts.staged} staged`);
    if (counts.modified > 0) parts.push(`${counts.modified} modified`);
    if (counts.untracked > 0) parts.push(`${counts.untracked} untracked`);
    if (!hasAny(counts)) parts.push("working tree clean");
  }
  return parts.join(" · ");
}
