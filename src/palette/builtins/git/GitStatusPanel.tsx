/**
 * `git status` palette command (M8.3 spec §14).
 *
 * Read-only viewer: rehydrates porcelain-v2 output through the
 * shared `parseGitStatus` and renders the sections (staged,
 * unstaged, untracked, unmerged) with counts. There's no
 * command to emit — spec explicitly carves this out ("read-only
 * commands like `git status` in M8.3 skip the preview + submit
 * gesture: they just show their data and close on Esc").
 *
 * Ships in the same registry as the emit-a-command entries so
 * the user's `⌘⇧P` list stays uniform; the panel calls
 * `onSubmit(null)` on close so the host backs out cleanly.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { gitStatusPorcelain } from "../../../lib/ipc";
import {
  parseGitStatus,
  type GitStatus,
  type StatusEntry,
} from "../../../formatters/parseGitStatus";
import type { PaneContext } from "../../registry";

export interface GitStatusPanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

const PANEL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minHeight: 260,
  fontFamily: "var(--font-ui)",
  fontSize: 12,
};

const BRANCH_ROW: CSSProperties = {
  padding: "6px 10px",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const SECTION: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 4,
  overflow: "hidden",
};

const SECTION_HEADER: CSSProperties = {
  padding: "5px 10px",
  background: "var(--pane2)",
  color: "var(--fg-dim)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const ENTRY: CSSProperties = {
  padding: "3px 10px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  display: "flex",
  gap: 8,
  alignItems: "baseline",
};

const CODE: CSSProperties = {
  color: "var(--fg-dim)",
  minWidth: 24,
};

const PATH: CSSProperties = {
  color: "var(--fg)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const CLEAN_NOTE: CSSProperties = {
  padding: "8px 10px",
  color: "var(--fg-faint)",
  fontStyle: "italic",
};

const ERROR: CSSProperties = {
  padding: 10,
  color: "var(--red)",
};

const FOOTER: CSSProperties = {
  paddingTop: 4,
  fontSize: 11,
  color: "var(--fg-faint)",
};

const KBD: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  padding: "1px 5px",
  border: "1px solid var(--border-strong)",
  borderRadius: 3,
  color: "var(--fg-dim)",
  marginRight: 4,
};

function formatXY(e: StatusEntry): string {
  return `${e.index}${e.worktree}`;
}

interface SectionProps {
  title: string;
  entries: StatusEntry[];
  color: string;
}

function Section({ title, entries, color }: SectionProps): React.ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <div style={SECTION} data-testid={`palette-git-status-section-${title.toLowerCase()}`}>
      <div style={{ ...SECTION_HEADER, color }}>
        <span>{title}</span>
        <span>{entries.length}</span>
      </div>
      {entries.map((e) => (
        <div key={`${title}:${e.path}`} style={ENTRY} data-testid="palette-git-status-entry">
          <span style={CODE}>{formatXY(e)}</span>
          <span style={PATH}>{e.origPath !== null ? `${e.origPath} → ${e.path}` : e.path}</span>
        </div>
      ))}
    </div>
  );
}

export function GitStatusPanel({ ctx, onSubmit }: GitStatusPanelProps): React.ReactElement {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ctx.cwd === null) {
      setError("No cwd for the active pane.");
      return;
    }
    let cancelled = false;
    setStatus(null);
    setError(null);
    gitStatusPorcelain(ctx.cwd)
      .then((raw) => {
        if (cancelled) return;
        setStatus(parseGitStatus(raw));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.cwd]);

  const clean =
    status !== null &&
    status.staged.length === 0 &&
    status.unstaged.length === 0 &&
    status.untracked.length === 0 &&
    status.unmerged.length === 0;

  return (
    <div style={PANEL} data-testid="palette-git-status-panel">
      {status !== null && (
        <div style={BRANCH_ROW} data-testid="palette-git-status-branch">
          <span style={{ color: "var(--accent)" }}>⎇</span>
          <span>{status.branch.head ?? "(detached)"}</span>
          {status.branch.upstream !== null && (
            <>
              <span style={{ color: "var(--fg-faint)" }}>→</span>
              <span style={{ color: "var(--fg-dim)" }}>{status.branch.upstream}</span>
            </>
          )}
          {(status.branch.ahead > 0 || status.branch.behind > 0) && (
            <span style={{ color: "var(--fg-dim)", marginLeft: "auto" }}>
              {status.branch.ahead > 0 && `↑${status.branch.ahead}`}
              {status.branch.behind > 0 && `↓${status.branch.behind}`}
            </span>
          )}
        </div>
      )}

      {error !== null && <div style={ERROR}>{error}</div>}
      {status === null && error === null && (
        <div style={{ padding: 10, color: "var(--fg-dim)" }}>Reading…</div>
      )}

      {status !== null && !clean && (
        <>
          <Section title="Unmerged" entries={status.unmerged} color="var(--red)" />
          <Section title="Staged" entries={status.staged} color="var(--green)" />
          <Section title="Unstaged" entries={status.unstaged} color="var(--amber)" />
          <Section title="Untracked" entries={status.untracked} color="var(--fg-faint)" />
        </>
      )}

      {status !== null && clean && (
        <div style={CLEAN_NOTE}>nothing to commit, working tree clean</div>
      )}

      <div style={FOOTER}>
        Read-only — <kbd style={KBD}>esc</kbd>close{" "}
        <button
          type="button"
          data-testid="palette-git-status-close"
          onClick={() => onSubmit(null)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--accent)",
            cursor: "pointer",
            padding: 0,
            marginLeft: 4,
            font: "inherit",
          }}
        >
          (or click here)
        </button>
      </div>
    </div>
  );
}
