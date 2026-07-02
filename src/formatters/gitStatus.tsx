/**
 * `git status` static formatter (M4 slice 4.5).
 *
 * Probes `git status --porcelain=v2 --branch -z` via the
 * backend, parses the stable machine-readable format, renders
 * branch info + sectioned file lists (staged, unstaged,
 * untracked, conflicts). No screen-scraping of the human
 * output, per spec §07 rule 2.
 */

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { gitStatusPorcelain } from "../lib/ipc";
import { GitStatusWidget } from "../widgets/gitStatus/GitStatusWidget";
import { isWidgetPromotable } from "../widgets/gitStatus/promotionGate";
import { parseGitStatus, type GitStatus, type StatusEntry } from "./parseGitStatus";
import { PASS, type Formatter, type FormatterContext } from "./types";

/** Pull the post-`status` portion of the user's argv. */
function statusArgsFromCtx(argv: readonly string[]): string[] {
  const out: string[] = [];
  let pastStatus = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (!pastStatus) {
      if (tok === "status") pastStatus = true;
      continue;
    }
    out.push(tok);
  }
  return out;
}

const HOST: CSSProperties = {
  margin: "4px 0 0 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
};

const STATUS_LINE: CSSProperties = {
  padding: "4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-faint)",
};

const BRANCH_LINE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  padding: "2px 0",
  color: "var(--fg-dim)",
};

const SECTION_HEADER: CSSProperties = {
  marginTop: 8,
  padding: "1px 0",
  fontFamily: "var(--font-ui)",
  fontSize: 11,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--fg-faint)",
};

const ROW: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.8em 1fr",
  gap: 8,
  alignItems: "baseline",
  padding: "1px 0",
};

/** Pretty label for an entry's status. Combines index + worktree
 *  side into a single two-char code rendered as a coloured pair. */
function statusGlyph(entry: StatusEntry): { glyph: string; color: string } {
  if (entry.unmerged) return { glyph: "UU", color: "var(--red)" };
  if (entry.index === "?" || entry.worktree === "?") {
    return { glyph: "??", color: "var(--fg-faint)" };
  }
  if (entry.index === "!" || entry.worktree === "!") {
    return { glyph: "!!", color: "var(--fg-faint)" };
  }
  // Two-char code; pick a colour from the more "interesting"
  // side. Stage-side green (added/modified are good), worktree
  // red (unstaged change). The standard porcelain mapping.
  const xy = `${entry.index}${entry.worktree}`;
  const color =
    entry.index !== "." ? "var(--green)" : entry.worktree !== "." ? "var(--red)" : "var(--fg-dim)";
  return { glyph: xy, color };
}

interface GitStatusViewProps {
  ctx: FormatterContext;
}

function GitStatusView({ ctx }: GitStatusViewProps): React.ReactElement {
  const args = useMemo(() => statusArgsFromCtx(ctx.argv), [ctx.argv]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setStatus(null);
    setError(null);
    if (ctx.cwd === null) {
      setError("git status: no cwd available");
      return;
    }
    let cancelled = false;
    void gitStatusPorcelain(ctx.cwd).then(
      (output) => {
        if (cancelled) return;
        setStatus(parseGitStatus(output));
      },
      (e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ctx.cwd]);

  if (error !== null) {
    return (
      <div data-testid="formatter-git-status-error" style={STATUS_LINE}>
        git status formatter: {error}
      </div>
    );
  }
  if (status === null) {
    return (
      <div data-testid="formatter-git-status-loading" style={STATUS_LINE}>
        Probing git status…
      </div>
    );
  }

  // Widget renders for the promotable invocation set;
  // anything else uses the static grouped view below.
  if (isWidgetPromotable(args)) {
    return <GitStatusWidget status={status} paneId={ctx.paneId} />;
  }

  return (
    <div data-testid="formatter-git-status" style={HOST}>
      <BranchSummary status={status} />
      <Section title="conflicts" entries={status.unmerged} kind="unmerged" />
      <Section title="staged" entries={status.staged} kind="staged" />
      <Section title="unstaged" entries={status.unstaged} kind="unstaged" />
      <Section title="untracked" entries={status.untracked} kind="untracked" />
      {status.staged.length === 0 &&
        status.unstaged.length === 0 &&
        status.untracked.length === 0 &&
        status.unmerged.length === 0 && (
          <div style={{ ...STATUS_LINE, padding: "4px 0" }}>
            nothing to commit, working tree clean
          </div>
        )}
    </div>
  );
}

function BranchSummary({ status }: { status: GitStatus }): React.ReactElement | null {
  const { branch } = status;
  if (branch.head === null) return null;
  return (
    <div style={BRANCH_LINE} data-testid="formatter-git-status-branch">
      <span style={{ color: "var(--amber)" }}>⎇ {branch.head}</span>
      {branch.upstream !== null && (
        <span style={{ color: "var(--fg-faint)" }}>
          → {branch.upstream}
          {(branch.ahead > 0 || branch.behind > 0) && (
            <>
              {" "}
              {branch.ahead > 0 && <span style={{ color: "var(--green)" }}>↑{branch.ahead}</span>}
              {branch.behind > 0 && <span style={{ color: "var(--red)" }}>↓{branch.behind}</span>}
            </>
          )}
        </span>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  entries: StatusEntry[];
  kind: "staged" | "unstaged" | "untracked" | "unmerged";
}

function Section({ title, entries, kind }: SectionProps): React.ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <div data-testid={`formatter-git-status-${kind}`}>
      <div style={SECTION_HEADER}>
        {title} · {entries.length}
      </div>
      {entries.map((e) => {
        const { glyph, color } = statusGlyph(e);
        return (
          <div key={`${kind}-${e.path}-${e.origPath ?? ""}`} style={ROW}>
            <span style={{ color }}>{glyph}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {e.origPath !== null ? `${e.origPath} → ${e.path}` : e.path}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function render(ctx: FormatterContext): React.ReactNode | typeof PASS {
  if (ctx.cwd === null) return PASS;
  return <GitStatusView ctx={ctx} />;
}

export const gitStatusFormatter: Formatter = {
  name: "git-status",
  matcher: { kind: "argv0-subcommand", argv0: "git", subcommand: "status" },
  render,
};
