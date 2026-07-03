/**
 * `git diff` static formatter (M4 slice 4.5).
 *
 * Probes the backend with the user's actual diff args
 * (`git diff`, `git diff HEAD`, `git diff --staged path`, …),
 * parses the unified diff format, and renders hunks with
 * +/- coloured lines plus a line-number gutter.
 *
 * The user's command's diff *bytes* would be perfectly
 * parseable too, but the PTY's line discipline can mangle the
 * `\r\n` pairs in long diffs — re-probing via the backend
 * sidesteps that and is fast (git diff is cached internally).
 */

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { gitDiff } from "../lib/ipc";
import { GitDiffWidget } from "../widgets/gitDiff/GitDiffWidget";
import { isWidgetPromotable } from "../widgets/gitDiff/promotionGate";
import { argsAfterSubcommand, findGitDashC, findGitSubcommand } from "./gitArgs";
import { parseGitDiff, type ParsedDiff } from "./parseGitDiff";
import { PASS, type Formatter, type FormatterContext } from "./types";

const STATUS_LINE: CSSProperties = {
  padding: "4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-faint)",
};

interface GitDiffViewProps {
  ctx: FormatterContext;
}

function GitDiffView({ ctx }: GitDiffViewProps): React.ReactElement {
  const args = useMemo(() => argsAfterSubcommand(ctx.argv), [ctx.argv]);
  const effectiveCwd = useMemo(() => findGitDashC(ctx.argv) ?? ctx.cwd, [ctx.argv, ctx.cwd]);
  const [diff, setDiff] = useState<ParsedDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDiff(null);
    setError(null);
    if (effectiveCwd === null) {
      setError("git diff: no cwd available");
      return;
    }
    let cancelled = false;
    void gitDiff(effectiveCwd, args).then(
      (output) => {
        if (cancelled) return;
        setDiff(parseGitDiff(output));
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
  }, [effectiveCwd, args]);

  if (error !== null) {
    return (
      <div data-testid="formatter-git-diff-error" style={STATUS_LINE}>
        git diff formatter: {error}
      </div>
    );
  }
  if (diff === null) {
    return (
      <div data-testid="formatter-git-diff-loading" style={STATUS_LINE}>
        Probing git diff…
      </div>
    );
  }
  // Widget renders every invocation this formatter accepts.
  // Non-widget invocations (`--stat`, `--name-only`, …) are
  // gated out at the top-level `render` and never reach here.
  return <GitDiffWidget parsed={diff} />;
}

function render(ctx: FormatterContext): React.ReactNode | typeof PASS {
  // Same fallback as git status: without any cwd we can't
  // probe the diff.
  if (ctx.cwd === null && findGitDashC(ctx.argv) === null) return PASS;
  // Decline for invocations that reshape git diff's output
  // (`--stat`, `--name-only`, `--numstat`, `--shortstat`,
  // `--summary`, `--dirstat`, `--check`, `--compact-summary`,
  // `--raw`, `--name-status`, `--patch-with-{stat,raw}`).
  // Those don't emit unified-diff, so the parser sees no
  // `diff --git` headers and would fall through to "No
  // changes." — misleading, since git *did* produce output.
  // Returning PASS routes the block to RAW, which preserves
  // git's actual `--stat` / summary text.
  if (!isWidgetPromotable(argsAfterSubcommand(ctx.argv))) return PASS;
  return <GitDiffView ctx={ctx} />;
}

export const gitDiffFormatter: Formatter = {
  name: "git-diff",
  // Predicate matcher: same reason as git-status — `git -C
  // /repo diff` needs to match the same as bare `git diff`.
  matcher: {
    kind: "predicate",
    test: (ctx) => findGitSubcommand(ctx.argv) === "diff",
  },
  render,
};
