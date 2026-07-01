/**
 * `git diff` interactive widget (M5 slice 1).
 *
 * The formatter's static render is a flat, always-expanded
 * scroll of every file's hunks. The widget adds the pieces
 * that make a large diff explorable:
 *
 *   - **Per-file collapse**. Files start expanded up to a
 *     threshold; larger diffs collapse everything so the
 *     summary is visible at a glance and the user drills into
 *     what matters.
 *   - **Inline / side-by-side toggle**. Inline is the familiar
 *     `+/-` view; side-by-side pairs deletions on the left
 *     with additions on the right, one row per changed pair.
 *   - **Summary bar**. File count, total +/-, and the toggle.
 *
 * Per spec §08 the widget is *frozen*: it renders from the
 * captured / re-probed diff bytes for its own block only. No
 * live refresh — the next command's block gets a fresh
 * widget.
 *
 * Everything is pure React state; no IPC beyond what the
 * formatter already does to fetch the diff.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DiffFile, DiffHunk, DiffLine, ParsedDiff } from "../../formatters/parseGitDiff";

/** Above this many files, everything starts collapsed —
 *  otherwise a 200-file PR fills the pane before the user can
 *  find the file they came to look at. */
const EXPANDED_BY_DEFAULT_MAX_FILES = 4;

const HOST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  margin: "4px 0 0 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  maxHeight: "var(--formatter-max-height, 480px)",
  flex: "var(--formatter-flex, none)",
  minHeight: 0,
};

const SUMMARY_BAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 10px",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderBottom: "none",
  borderTopLeftRadius: "var(--radius-sm)",
  borderTopRightRadius: "var(--radius-sm)",
  fontFamily: "var(--font-ui)",
  fontSize: 11.5,
  color: "var(--fg-faint)",
};

const SCROLLER: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  border: "1px solid var(--border)",
  borderBottomLeftRadius: "var(--radius-sm)",
  borderBottomRightRadius: "var(--radius-sm)",
  background: "var(--pane)",
};

const FILE_HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 8px",
  background: "var(--surface)",
  borderTop: "1px solid var(--border)",
  cursor: "pointer",
  userSelect: "none",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
};

const FILE_HEADER_CHEVRON: CSSProperties = {
  color: "var(--fg-faint)",
  fontSize: 9,
  width: 8,
  transition: "transform 0.12s ease",
};

const FILE_HEADER_PATH: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "var(--font-mono)",
  color: "var(--fg)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const FILE_STAT_ADD: CSSProperties = {
  color: "var(--green)",
  fontVariantNumeric: "tabular-nums",
};

const FILE_STAT_DEL: CSSProperties = {
  color: "var(--red)",
  fontVariantNumeric: "tabular-nums",
};

const HUNK_HEADER: CSSProperties = {
  padding: "2px 8px",
  color: "var(--cyan)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  background: "color-mix(in srgb, var(--cyan) 6%, transparent)",
};

const ROW_INLINE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "3em 3em 1fr",
  padding: 0,
  lineHeight: 1.5,
  whiteSpace: "pre",
  fontFamily: "var(--font-mono)",
};

const ROW_SIDE_BY_SIDE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "3em 1fr 3em 1fr",
  padding: 0,
  lineHeight: 1.5,
  whiteSpace: "pre",
  fontFamily: "var(--font-mono)",
};

const LN_COL: CSSProperties = {
  textAlign: "right",
  paddingRight: 8,
  color: "var(--fg-faint)",
  userSelect: "none",
  borderRight: "1px solid var(--border)",
};

const CODE_COL: CSSProperties = {
  paddingLeft: 8,
  paddingRight: 8,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const TOGGLE_GROUP: CSSProperties = {
  display: "flex",
  border: "1px solid var(--border-strong)",
  borderRadius: 3,
  overflow: "hidden",
};

const TOGGLE_BUTTON: CSSProperties = {
  appearance: "none",
  border: "none",
  background: "transparent",
  padding: "2px 8px",
  fontSize: 10,
  letterSpacing: 0.5,
  color: "var(--fg-faint)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
};

const TOGGLE_BUTTON_ACTIVE: CSSProperties = {
  ...TOGGLE_BUTTON,
  background: "var(--accent-soft)",
  color: "var(--fg)",
};

const EMPTY_NOTE: CSSProperties = {
  padding: 12,
  color: "var(--fg-faint)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  textAlign: "center",
};

type ViewMode = "inline" | "side-by-side";

interface GitDiffWidgetProps {
  parsed: ParsedDiff;
}

export function GitDiffWidget({ parsed }: GitDiffWidgetProps): React.ReactElement {
  const [view, setView] = useState<ViewMode>("inline");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    initialCollapseState(parsed.files),
  );
  const stats = useMemo(() => computeStats(parsed.files), [parsed.files]);
  const hostRef = useRef<HTMLDivElement>(null);

  // Focused-file index for keyboard navigation. `null` when
  // no file is focused yet (initial state); j/k / arrows
  // move it. The focused file gets a subtle accent border
  // and scrolls into view on change.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  // Refs mirror state so the widget-nav event listener (below)
  // can consult the latest values without re-registering on
  // every render — parity with the block-focus pattern in
  // TerminalPane.
  const focusedIndexRef = useRef<number | null>(null);
  focusedIndexRef.current = focusedIndex;
  const filesRef = useRef(parsed.files);
  filesRef.current = parsed.files;

  // Listen for block-focus actions (`toggle-side-by-side` from
  // the `s` key) — filter by the enclosing block's
  // `data-block-id` so pressing `s` while one block is focused
  // doesn't toggle *every* git-diff widget on the page.
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const blockEl = el.closest<HTMLElement>("[data-block-id]");
    const blockId = blockEl?.getAttribute("data-block-id") ?? null;
    if (blockId === null) return;
    const onAction = (e: Event): void => {
      const detail = (e as CustomEvent<{ blockId: string; kind: string }>).detail;
      if (detail?.blockId !== blockId) return;
      if (detail.kind !== "toggle-side-by-side") return;
      setView((v) => (v === "inline" ? "side-by-side" : "inline"));
    };
    window.addEventListener("shax:block-action", onAction);
    return () => window.removeEventListener("shax:block-action", onAction);
  }, []);

  // Listen for widget-nav events (j / k / h / l and their
  // arrow-key aliases). Consume when we can move focus /
  // collapse / expand; leave `claimed` false at the file-list
  // boundaries so nav gracefully falls through to normal
  // block-focus (advance to the next block, etc.).
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const blockEl = el.closest<HTMLElement>("[data-block-id]");
    const blockId = blockEl?.getAttribute("data-block-id") ?? null;
    if (blockId === null) return;
    const onNav = (e: Event): void => {
      const detail = (
        e as CustomEvent<{
          blockId: string;
          direction: "up" | "down" | "left" | "right";
          claimed: boolean;
        }>
      ).detail;
      if (detail?.blockId !== blockId) return;
      const files = filesRef.current;
      if (files.length === 0) return;
      const cur = focusedIndexRef.current;
      // Move focus + update ref together so a second key press
      // in the same event loop tick sees the latest index. React
      // batches state updates from native listeners; without the
      // eager ref update the second nav read the pre-first-press
      // value and h/l always targeted file 0.
      const moveFocus = (next: number): void => {
        focusedIndexRef.current = next;
        setFocusedIndex(next);
      };
      switch (detail.direction) {
        case "down": {
          const next = cur === null ? 0 : cur + 1;
          if (next < files.length) {
            moveFocus(next);
            detail.claimed = true;
          }
          return;
        }
        case "up": {
          // Give the first key press a landing site so the user
          // doesn't have to press `j` before `k`; a `k` at file 0
          // still no-ops (falls through to advance-to-prev-block).
          if (cur === null) {
            moveFocus(0);
            detail.claimed = true;
            return;
          }
          if (cur <= 0) return;
          moveFocus(cur - 1);
          detail.claimed = true;
          return;
        }
        case "left":
        case "right": {
          // First press auto-focuses file 0 so `h` / `l` don't
          // silently no-op when nothing is focused yet.
          const target = cur === null ? 0 : cur;
          const file = files[target];
          if (file === undefined) return;
          if (cur === null) moveFocus(0);
          const collapse = detail.direction === "left";
          setCollapsed((prev) => ({ ...prev, [fileKey(file)]: collapse }));
          detail.claimed = true;
          return;
        }
      }
    };
    window.addEventListener("shax:widget-nav", onNav);
    return () => window.removeEventListener("shax:widget-nav", onNav);
  }, []);

  // Scroll the focused file's card into view as focus moves.
  useEffect(() => {
    if (focusedIndex === null) return;
    const el = hostRef.current;
    if (el === null) return;
    const cards = el.querySelectorAll<HTMLElement>('[data-testid="widget-git-diff-file"]');
    const card = cards[focusedIndex];
    if (card === undefined) return;
    if (typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusedIndex]);

  if (parsed.files.length === 0) {
    return (
      <div data-testid="widget-git-diff" ref={hostRef} style={HOST}>
        <div style={SUMMARY_BAR}>
          <span style={{ flex: 1 }}>No changes.</span>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="widget-git-diff" ref={hostRef} style={HOST}>
      <div style={SUMMARY_BAR}>
        <span style={{ flex: 1 }} data-testid="widget-git-diff-summary">
          {parsed.files.length} file{parsed.files.length === 1 ? "" : "s"} changed
          {stats.added > 0 && (
            <>
              , <span style={FILE_STAT_ADD}>+{stats.added}</span>
            </>
          )}
          {stats.deleted > 0 && (
            <>
              , <span style={FILE_STAT_DEL}>−{stats.deleted}</span>
            </>
          )}
        </span>
        <button
          type="button"
          data-testid="widget-git-diff-expand-toggle"
          style={{
            ...TOGGLE_BUTTON,
            border: "1px solid var(--border-strong)",
            borderRadius: 3,
          }}
          title="Expand or collapse every file (click a header to toggle just one)"
          onClick={() =>
            setCollapsed(bulkCollapseState(parsed.files, anyExpanded(parsed, collapsed)))
          }
        >
          {anyExpanded(parsed, collapsed) ? "COLLAPSE ALL" : "EXPAND ALL"}
        </button>
        <div style={TOGGLE_GROUP} data-testid="widget-git-diff-view-toggle">
          <button
            type="button"
            data-testid="widget-git-diff-view-inline"
            style={view === "inline" ? TOGGLE_BUTTON_ACTIVE : TOGGLE_BUTTON}
            title="Inline diff (Ctrl+J → s)"
            onClick={() => setView("inline")}
          >
            INLINE
          </button>
          <button
            type="button"
            data-testid="widget-git-diff-view-side-by-side"
            style={view === "side-by-side" ? TOGGLE_BUTTON_ACTIVE : TOGGLE_BUTTON}
            title="Side-by-side diff (Ctrl+J → s)"
            onClick={() => setView("side-by-side")}
          >
            SIDE-BY-SIDE
          </button>
        </div>
      </div>
      <div style={SCROLLER} data-block-scroll-host="git-diff-widget">
        {parsed.files.map((file, index) => (
          <FileCard
            key={fileKey(file)}
            file={file}
            view={view}
            collapsed={collapsed[fileKey(file)] === true}
            focused={focusedIndex === index}
            onToggle={() => {
              setFocusedIndex(index);
              setCollapsed((prev) => ({
                ...prev,
                [fileKey(file)]: !(prev[fileKey(file)] === true),
              }));
            }}
          />
        ))}
      </div>
    </div>
  );
}

function fileKey(file: DiffFile): string {
  return `${file.oldPath ?? ""}::${file.path}`;
}

/** Small diffs open by default; large ones collapse so the
 *  file list is a summary the user drills into. */
function initialCollapseState(files: DiffFile[]): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  const collapse = files.length > EXPANDED_BY_DEFAULT_MAX_FILES;
  for (const file of files) state[fileKey(file)] = collapse;
  return state;
}

function bulkCollapseState(files: DiffFile[], collapse: boolean): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const file of files) state[fileKey(file)] = collapse;
  return state;
}

/** True iff at least one file is currently expanded — used by
 *  the header button to swap its label between "COLLAPSE ALL"
 *  and "EXPAND ALL". */
function anyExpanded(parsed: ParsedDiff, collapsed: Record<string, boolean>): boolean {
  for (const file of parsed.files) {
    if (collapsed[fileKey(file)] !== true) return true;
  }
  return false;
}

interface FileStats {
  added: number;
  deleted: number;
}

function computeStats(files: DiffFile[]): FileStats {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") added++;
        else if (line.kind === "del") deleted++;
      }
    }
  }
  return { added, deleted };
}

function statsFor(file: DiffFile): FileStats {
  let added = 0;
  let deleted = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added++;
      else if (line.kind === "del") deleted++;
    }
  }
  return { added, deleted };
}

interface FileCardProps {
  file: DiffFile;
  view: ViewMode;
  collapsed: boolean;
  focused: boolean;
  onToggle: () => void;
}

function FileCard({ file, view, collapsed, focused, onToggle }: FileCardProps): React.ReactElement {
  const stats = useMemo(() => statsFor(file), [file]);
  const label = fileHeaderLabel(file);
  const opBadge = opBadgeText(file.op);

  return (
    <div
      data-testid="widget-git-diff-file"
      data-op={file.op ?? "modified"}
      data-collapsed={collapsed}
      data-focused={focused}
    >
      <div
        style={{
          ...FILE_HEADER,
          // Focus cue lives on the header itself so it stays
          // visible even when the file is collapsed. Painted
          // via inset box-shadow (no layout shift) plus a tint
          // on the header background so the accent stripe reads
          // clearly against the surface color.
          ...(focused
            ? {
                boxShadow: "inset 3px 0 0 var(--accent)",
                background: "color-mix(in srgb, var(--accent) 12%, var(--surface))",
              }
            : undefined),
        }}
        onClick={onToggle}
        data-testid="widget-git-diff-file-header"
      >
        <span
          style={{
            ...FILE_HEADER_CHEVRON,
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
          }}
          aria-hidden="true"
        >
          ▾
        </span>
        {opBadge !== null && (
          <span
            style={{
              padding: "0 4px",
              borderRadius: 2,
              fontSize: 9,
              letterSpacing: 0.6,
              background: "var(--pane2)",
              color: "var(--fg-faint)",
            }}
          >
            {opBadge}
          </span>
        )}
        <span style={FILE_HEADER_PATH} title={label}>
          {label}
        </span>
        {stats.added > 0 && (
          <span style={FILE_STAT_ADD} data-testid="widget-git-diff-file-added">
            +{stats.added}
          </span>
        )}
        {stats.deleted > 0 && (
          <span style={FILE_STAT_DEL} data-testid="widget-git-diff-file-deleted">
            −{stats.deleted}
          </span>
        )}
      </div>
      {!collapsed && (
        <>
          {file.binary ? (
            <div style={EMPTY_NOTE}>Binary file — diff omitted.</div>
          ) : file.hunks.length === 0 ? (
            <div style={EMPTY_NOTE}>No content changes (metadata only).</div>
          ) : (
            file.hunks.map((hunk, i) => <HunkBlock key={i} hunk={hunk} view={view} />)
          )}
        </>
      )}
    </div>
  );
}

function fileHeaderLabel(file: DiffFile): string {
  if (file.op === "renamed" || file.op === "copied") {
    return `${file.oldPath} → ${file.path}`;
  }
  return file.path;
}

function opBadgeText(op: DiffFile["op"]): string | null {
  switch (op) {
    case "new":
      return "NEW";
    case "deleted":
      return "DEL";
    case "renamed":
      return "REN";
    case "copied":
      return "CP";
    case "mode-change":
      return "MODE";
    default:
      return null;
  }
}

interface HunkBlockProps {
  hunk: DiffHunk;
  view: ViewMode;
}

function HunkBlock({ hunk, view }: HunkBlockProps): React.ReactElement {
  return (
    <div data-testid="widget-git-diff-hunk">
      <div style={HUNK_HEADER}>{hunk.header}</div>
      {view === "inline"
        ? hunk.lines
            .filter((l) => l.kind !== "meta")
            .map((line, i) => <InlineRow key={i} line={line} />)
        : buildSideBySide(hunk.lines).map((pair, i) => (
            <SideBySideRow key={i} left={pair.left} right={pair.right} />
          ))}
    </div>
  );
}

function InlineRow({ line }: { line: DiffLine }): React.ReactElement {
  const { bg, fg, marker } = inlineRowStyle(line.kind);
  return (
    <div
      data-testid="widget-git-diff-line"
      data-kind={line.kind}
      style={{ ...ROW_INLINE, background: bg, color: fg }}
    >
      <span style={LN_COL}>{line.oldLine ?? ""}</span>
      <span style={LN_COL}>{line.newLine ?? ""}</span>
      <span style={CODE_COL}>
        {marker}
        {line.text}
      </span>
    </div>
  );
}

function inlineRowStyle(kind: DiffLine["kind"]): { bg: string; fg: string; marker: string } {
  switch (kind) {
    case "add":
      return {
        bg: "color-mix(in srgb, var(--green) 14%, transparent)",
        fg: "var(--green)",
        marker: "+",
      };
    case "del":
      return {
        bg: "color-mix(in srgb, var(--red) 14%, transparent)",
        fg: "var(--red)",
        marker: "−",
      };
    case "meta":
      return { bg: "transparent", fg: "var(--fg-faint)", marker: "·" };
    default:
      return { bg: "transparent", fg: "var(--fg-dim)", marker: " " };
  }
}

interface SideBySidePair {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pair deletions on the left with additions on the right,
 *  one row per pair; contexts render aligned on both sides.
 *  Simple greedy pairing — enough for typical diffs; an LCS
 *  aligner is polish. */
function buildSideBySide(lines: readonly DiffLine[]): SideBySidePair[] {
  const pairs: SideBySidePair[] = [];
  const changes = lines.filter((l) => l.kind !== "meta");
  let i = 0;
  while (i < changes.length) {
    const line = changes[i];
    if (line === undefined) break;
    if (line.kind === "context") {
      pairs.push({ left: line, right: line });
      i++;
      continue;
    }
    // Collect consecutive del + add runs and pair them.
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < changes.length) {
      const c = changes[i];
      if (c === undefined) break;
      if (c.kind === "del") dels.push(c);
      else if (c.kind === "add") adds.push(c);
      else break;
      i++;
    }
    const paired = Math.max(dels.length, adds.length);
    for (let j = 0; j < paired; j++) {
      pairs.push({ left: dels[j] ?? null, right: adds[j] ?? null });
    }
  }
  return pairs;
}

function SideBySideRow({
  left,
  right,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
}): React.ReactElement {
  const leftStyle = sideCellStyle(left);
  const rightStyle = sideCellStyle(right);
  return (
    <div data-testid="widget-git-diff-line-pair" style={ROW_SIDE_BY_SIDE}>
      <span style={LN_COL}>{left?.oldLine ?? ""}</span>
      <span style={{ ...CODE_COL, background: leftStyle.bg, color: leftStyle.fg }}>
        {left?.text ?? ""}
      </span>
      <span style={LN_COL}>{right?.newLine ?? ""}</span>
      <span style={{ ...CODE_COL, background: rightStyle.bg, color: rightStyle.fg }}>
        {right?.text ?? ""}
      </span>
    </div>
  );
}

function sideCellStyle(line: DiffLine | null): { bg: string; fg: string } {
  if (line === null) {
    return {
      bg: "color-mix(in srgb, var(--fg-faint) 8%, transparent)",
      fg: "var(--fg-faint)",
    };
  }
  if (line.kind === "add") {
    return {
      bg: "color-mix(in srgb, var(--green) 14%, transparent)",
      fg: "var(--green)",
    };
  }
  if (line.kind === "del") {
    return {
      bg: "color-mix(in srgb, var(--red) 14%, transparent)",
      fg: "var(--red)",
    };
  }
  return { bg: "transparent", fg: "var(--fg-dim)" };
}
