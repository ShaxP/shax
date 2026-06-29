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
import {
  parseGitDiff,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type ParsedDiff,
} from "./parseGitDiff";
import { PASS, type Formatter, type FormatterContext } from "./types";

const HOST: CSSProperties = {
  margin: "4px 0 0 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  // Inline blocks cap so a 5k-line diff doesn't take over the
  // pane. The modal overrides `--formatter-max-height` so the
  // diff fills the panel — the eye icon's whole point is to
  // show the diff at full size.
  maxHeight: "var(--formatter-max-height, 480px)",
  overflowY: "auto",
};

const STATUS_LINE: CSSProperties = {
  padding: "4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-faint)",
};

const FILE_HEADER: CSSProperties = {
  marginTop: 8,
  padding: "2px 6px",
  background: "var(--pane2)",
  borderLeft: "2px solid var(--accent)",
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
};

const HUNK_HEADER: CSSProperties = {
  marginTop: 4,
  padding: "1px 6px",
  color: "var(--cyan)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  background: "var(--surface)",
};

const ROW_BASE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "3em 3em 1fr",
  gap: 0,
  padding: 0,
  lineHeight: 1.5,
  whiteSpace: "pre",
};

const LN_COL: CSSProperties = {
  textAlign: "right",
  paddingRight: 8,
  color: "var(--fg-faint)",
  userSelect: "none",
};

const TEXT_COL: CSSProperties = {
  paddingLeft: 8,
};

interface GitDiffViewProps {
  ctx: FormatterContext;
}

/** Pull the post-`diff` portion of the user's argv. We skip the
 *  program name (`git`) and the subcommand (`diff`), then pass
 *  whatever remains to the backend. */
function diffArgsFromCtx(argv: readonly string[]): string[] {
  const out: string[] = [];
  let pastDiff = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (!pastDiff) {
      if (tok === "diff") pastDiff = true;
      continue;
    }
    out.push(tok);
  }
  return out;
}

function GitDiffView({ ctx }: GitDiffViewProps): React.ReactElement {
  const args = useMemo(() => diffArgsFromCtx(ctx.argv), [ctx.argv]);
  const [diff, setDiff] = useState<ParsedDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDiff(null);
    setError(null);
    if (ctx.cwd === null) {
      setError("git diff: no cwd available");
      return;
    }
    let cancelled = false;
    void gitDiff(ctx.cwd, args).then(
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
  }, [ctx.cwd, args]);

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
  if (diff.files.length === 0) {
    return (
      <div data-testid="formatter-git-diff-empty" style={STATUS_LINE}>
        No changes.
      </div>
    );
  }
  return (
    <div data-testid="formatter-git-diff" style={HOST}>
      {diff.files.map((file) => (
        <FileBlock key={`${file.oldPath}::${file.path}`} file={file} />
      ))}
    </div>
  );
}

function FileBlock({ file }: { file: DiffFile }): React.ReactElement {
  return (
    <div data-testid="formatter-git-diff-file" data-op={file.op ?? "modified"}>
      <div style={FILE_HEADER}>{fileHeaderLabel(file)}</div>
      {file.binary ? (
        <div style={{ ...STATUS_LINE, padding: "4px 6px" }}>Binary file — diff omitted.</div>
      ) : (
        file.hunks.map((h, i) => <HunkBlock key={i} hunk={h} />)
      )}
    </div>
  );
}

function fileHeaderLabel(file: DiffFile): string {
  if (file.op === "new") return `+ ${file.path}`;
  if (file.op === "deleted") return `− ${file.oldPath}`;
  if (file.op === "renamed") return `${file.oldPath} → ${file.path}`;
  if (file.op === "copied") return `${file.oldPath} ⇒ ${file.path}`;
  if (file.op === "mode-change") return `${file.path} (mode)`;
  return file.path;
}

function HunkBlock({ hunk }: { hunk: DiffHunk }): React.ReactElement {
  return (
    <div data-testid="formatter-git-diff-hunk">
      <div style={HUNK_HEADER}>{hunk.header}</div>
      {hunk.lines.map((line, i) => (
        <DiffLineRow key={i} line={line} />
      ))}
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }): React.ReactElement {
  const bg =
    line.kind === "add"
      ? "color-mix(in srgb, var(--green) 14%, transparent)"
      : line.kind === "del"
        ? "color-mix(in srgb, var(--red) 14%, transparent)"
        : line.kind === "meta"
          ? "transparent"
          : "transparent";
  const fg =
    line.kind === "add"
      ? "var(--green)"
      : line.kind === "del"
        ? "var(--red)"
        : line.kind === "meta"
          ? "var(--fg-faint)"
          : "var(--fg-dim)";
  const marker =
    line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "meta" ? "·" : " ";
  return (
    <div
      data-testid="formatter-git-diff-line"
      data-kind={line.kind}
      style={{ ...ROW_BASE, background: bg, color: fg }}
    >
      <span style={LN_COL}>{line.oldLine ?? ""}</span>
      <span style={LN_COL}>{line.newLine ?? ""}</span>
      <span style={TEXT_COL}>
        {marker}
        {line.text}
      </span>
    </div>
  );
}

function render(ctx: FormatterContext): React.ReactNode | typeof PASS {
  if (ctx.cwd === null) return PASS;
  return <GitDiffView ctx={ctx} />;
}

export const gitDiffFormatter: Formatter = {
  name: "git-diff",
  matcher: { kind: "argv0-subcommand", argv0: "git", subcommand: "diff" },
  render,
};

// Exported for the unit test.
export const __testing = { diffArgsFromCtx };
