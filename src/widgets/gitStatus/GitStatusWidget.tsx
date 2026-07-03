/**
 * `git status` interactive widget (M5 slice 2).
 *
 * First widget with side effects — per spec §08's load-
 * bearing rule, every mutation emits a **visible command**
 * into the prompt. Staging is not a hidden `git add` call;
 * it is `git add <path>` written to the PTY as if the user
 * typed it, so the scrollback stays a truthful log and every
 * mutation flows through the same block / OSC 133 pipeline
 * as ordinary shell input.
 *
 * Reads: `git status --porcelain=v2 --branch -z` (via the
 * formatter's existing IPC).
 * Writes: `shax:emit-command` window events consumed by
 * TerminalPane's PTY writer.
 *
 * Actions:
 *   - Space on a staged file  → `git reset HEAD -- <path>`
 *   - Space on an unstaged one → `git add -- <path>`
 *   - Space on an untracked one → `git add -- <path>`
 *   - Space on a conflict     → no-op (safety: resolving
 *     conflicts is out of the read-only slice)
 *   - Enter / o on a file     → emit `git diff -- <path>`
 *     (or `git diff --cached -- <path>` for staged) so the
 *     user gets a fresh git-diff widget for that file as its
 *     own block. Keeps the widget itself small.
 *
 * Navigation via block-focus mode (the widget-nav pattern
 * from git-diff): j / k walk entries across sections; h / l
 * collapse / expand sections; Enter opens the diff.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { GitStatus, StatusEntry } from "../../formatters/parseGitStatus";
import type { PtyId } from "../../lib/ipc";

type SectionKind = "unmerged" | "staged" | "unstaged" | "untracked";

interface GitStatusWidgetProps {
  status: GitStatus;
  paneId: PtyId;
}

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

const HEADER: CSSProperties = {
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

const SECTION_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "3px 10px",
  background: "var(--surface)",
  borderTop: "1px solid var(--border)",
  fontFamily: "var(--font-ui)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--fg-faint)",
  cursor: "pointer",
  userSelect: "none",
};

const ENTRY_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "2.5em 1fr auto",
  gap: 8,
  alignItems: "baseline",
  padding: "1px 10px",
  cursor: "pointer",
  userSelect: "none",
};

const ENTRY_FOCUSED: CSSProperties = {
  ...ENTRY_STYLE,
  boxShadow: "inset 3px 0 0 var(--accent)",
  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
};

const HINT_STYLE: CSSProperties = {
  color: "var(--fg-faint)",
  fontSize: 10,
};

const BRANCH_PILL: CSSProperties = {
  color: "var(--amber)",
};

const EMPTY_NOTE: CSSProperties = {
  padding: 20,
  textAlign: "center",
  color: "var(--fg-faint)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
};

type FlatItem =
  | { kind: "section"; section: SectionKind }
  | { kind: "entry"; section: SectionKind; entry: StatusEntry };

export function GitStatusWidget({ status, paneId }: GitStatusWidgetProps): React.ReactElement {
  const [collapsedSections, setCollapsedSections] = useState<Record<SectionKind, boolean>>({
    unmerged: false,
    staged: false,
    unstaged: false,
    untracked: false,
  });
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const focusedIndexRef = useRef<number | null>(null);
  focusedIndexRef.current = focusedIndex;
  const hostRef = useRef<HTMLDivElement>(null);

  // Per spec §08 only the most recent block stays live; older
  // blocks freeze. Read the enclosing block's `data-is-latest`
  // attribute (set by BlockList on the last row) and keep it
  // in sync via a MutationObserver so the widget correctly
  // downgrades to render-only when a newer block arrives.
  const [isLive, setIsLive] = useState(true);
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const blockEl = el.closest<HTMLElement>("[data-block-id]");
    if (blockEl === null) return;
    const sync = (): void => {
      setIsLive(blockEl.getAttribute("data-is-latest") === "true");
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(blockEl, { attributes: true, attributeFilter: ["data-is-latest"] });
    return () => observer.disconnect();
  }, []);

  // Flatten sections + entries into an index-addressable list
  // so widget-nav j/k walk every focusable thing without
  // re-solving section boundaries. Section headers are
  // *always* included when the section has content — that way
  // a collapsed section remains focusable, and pressing `l`
  // on it (or Space in a future revision) re-opens it.
  // Entries only follow when the section is expanded.
  const flat = useMemo<FlatItem[]>(() => {
    const out: FlatItem[] = [];
    for (const kind of ["unmerged", "staged", "unstaged", "untracked"] as const) {
      const entries = status[kind];
      if (entries.length === 0) continue;
      out.push({ kind: "section", section: kind });
      if (collapsedSections[kind]) continue;
      for (const entry of entries) out.push({ kind: "entry", section: kind, entry });
    }
    return out;
  }, [status, collapsedSections]);
  const flatRef = useRef(flat);
  flatRef.current = flat;

  // Reset focus if it points past the current visible list
  // (happens when a section collapses out from under it).
  useEffect(() => {
    if (focusedIndex === null) return;
    if (focusedIndex >= flat.length) {
      setFocusedIndex(flat.length === 0 ? null : flat.length - 1);
    }
  }, [flat.length, focusedIndex]);

  // Widget-nav listener — j / k walk entries, h / l fold /
  // unfold *sections* (h collapses the current entry's
  // section, l re-opens it). At the top / bottom boundaries
  // we don't claim so nav falls through to block-focus.
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const blockEl = el.closest<HTMLElement>("[data-block-id]");
    const blockId = blockEl?.getAttribute("data-block-id") ?? null;
    if (blockId === null) return;
    const moveFocus = (next: number): void => {
      focusedIndexRef.current = next;
      setFocusedIndex(next);
    };
    const onNav = (e: Event): void => {
      const detail = (
        e as CustomEvent<{
          blockId: string;
          direction: "up" | "down" | "left" | "right";
          claimed: boolean;
        }>
      ).detail;
      if (detail?.blockId !== blockId) return;
      const items = flatRef.current;
      if (items.length === 0) return;
      const cur = focusedIndexRef.current;
      switch (detail.direction) {
        case "down": {
          const next = cur === null ? 0 : cur + 1;
          if (next < items.length) {
            moveFocus(next);
            detail.claimed = true;
          }
          return;
        }
        case "up": {
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
          const target = cur ?? 0;
          const item = items[target];
          if (item === undefined) return;
          if (cur === null) moveFocus(0);
          // h / l on either a section header OR an entry
          // affects the containing section. That way a
          // collapsed section is re-openable by focusing its
          // header and pressing `l` (or the arrow key).
          setCollapsedSections((prev) => ({
            ...prev,
            [item.section]: detail.direction === "left",
          }));
          detail.claimed = true;
          return;
        }
      }
    };
    window.addEventListener("shax:widget-nav", onNav);
    return () => window.removeEventListener("shax:widget-nav", onNav);
  }, []);

  // Space → stage / unstage the focused entry. Listens on
  // the widget-primary claim channel: if the widget acts,
  // it sets `detail.claimed = true` so TerminalPane doesn't
  // fall back to page-down.
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const blockEl = el.closest<HTMLElement>("[data-block-id]");
    if (blockEl === null) return;
    const blockId = blockEl.getAttribute("data-block-id");
    if (blockId === null) return;
    const onPrimary = (e: Event): void => {
      const detail = (e as CustomEvent<{ blockId: string; claimed: boolean }>).detail;
      if (detail?.blockId !== blockId) return;
      // Historical (non-latest) widgets are frozen per spec
      // §08. They render, they navigate, they do NOT act — a
      // stage / unstage fired from scrollback would run in
      // whatever cwd the shell has drifted to, mutating the
      // wrong repo. Read `data-is-latest` at emit time (state
      // can change while the widget is mounted).
      if (blockEl.getAttribute("data-is-latest") !== "true") return;
      const cur = focusedIndexRef.current;
      if (cur === null) return;
      const item = flatRef.current[cur];
      if (item === undefined || item.kind !== "entry") return;
      const command = commandForAction(item.section, item.entry);
      if (command === null) return;
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId, command },
        }),
      );
      // Follow the action with a fresh `git status` so the
      // user sees the updated tree in a new block below.
      // Bare form is safe because the live widget's cwd
      // equals the shell's cwd (see the cwd JSDoc). The new
      // status block becomes the live widget; this one is
      // now frozen.
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: { paneId, command: "git status" },
        }),
      );
      detail.claimed = true;
    };
    window.addEventListener("shax:widget-primary", onPrimary);
    return () => window.removeEventListener("shax:widget-primary", onPrimary);
  }, [paneId]);

  // Scroll the focused row (section header OR entry) into
  // view as focus moves. Uses `[data-focused="true"]` so it
  // works for either kind without hard-coding the DOM shape.
  useEffect(() => {
    if (focusedIndex === null) return;
    const el = hostRef.current;
    if (el === null) return;
    const row = el.querySelector<HTMLElement>('[data-focused="true"]');
    if (row === null) return;
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusedIndex]);

  const staged = status.staged.length;
  const unstaged = status.unstaged.length;
  const untracked = status.untracked.length;
  const unmerged = status.unmerged.length;
  const clean = staged === 0 && unstaged === 0 && untracked === 0 && unmerged === 0;

  return (
    <div
      data-testid="widget-git-status"
      ref={hostRef}
      data-is-live={isLive ? "true" : "false"}
      style={{ ...HOST, ...(isLive ? undefined : { opacity: 0.72 }) }}
    >
      <div style={HEADER}>
        {status.branch.head !== null && (
          <span style={BRANCH_PILL} data-testid="widget-git-status-branch">
            ⎇ {status.branch.head}
          </span>
        )}
        {status.branch.upstream !== null && (
          <span>
            → {status.branch.upstream}
            {status.branch.ahead > 0 && (
              <span style={{ color: "var(--green)" }}> ↑{status.branch.ahead}</span>
            )}
            {status.branch.behind > 0 && (
              <span style={{ color: "var(--red)" }}> ↓{status.branch.behind}</span>
            )}
          </span>
        )}
        {!isLive && (
          <span
            data-testid="widget-git-status-historical"
            style={{
              fontSize: 10,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: "var(--fg-faint)",
              border: "1px solid var(--border-strong)",
              borderRadius: 3,
              padding: "1px 6px",
            }}
            title="Historical block — re-run `git status` for a live widget"
          >
            historical
          </span>
        )}
        <span style={{ flex: 1, textAlign: "right" }} data-testid="widget-git-status-summary">
          {clean
            ? "clean"
            : [
                unmerged > 0 && `${unmerged} conflict${unmerged === 1 ? "" : "s"}`,
                staged > 0 && `${staged} staged`,
                unstaged > 0 && `${unstaged} unstaged`,
                untracked > 0 && `${untracked} untracked`,
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
      </div>
      <div style={SCROLLER} data-block-scroll-host="git-status-widget">
        {clean ? (
          <div style={EMPTY_NOTE}>nothing to commit, working tree clean</div>
        ) : (
          (["unmerged", "staged", "unstaged", "untracked"] as const).map((kind) => (
            <Section
              key={kind}
              kind={kind}
              entries={status[kind]}
              collapsed={collapsedSections[kind]}
              isLive={isLive}
              onToggleSection={() =>
                setCollapsedSections((prev) => ({ ...prev, [kind]: !prev[kind] }))
              }
              sectionHeaderIndex={flatIndexOfSectionHeader(flat, kind)}
              indexOfEntry={(entry) => flatIndexOfEntry(flat, kind, entry.path)}
              focusedIndex={focusedIndex}
              onFocusRow={(idx) => setFocusedIndex(idx)}
              onAction={(entry) => {
                // Double-click acts only on the live widget —
                // same rule as the Space handler above. Check
                // the enclosing block's `data-is-latest` at
                // click time (the state can change while the
                // widget is mounted, as new blocks arrive).
                const blockEl = hostRef.current?.closest<HTMLElement>("[data-block-id]");
                if (blockEl?.getAttribute("data-is-latest") !== "true") return;
                const command = commandForAction(kind, entry);
                if (command === null) return;
                window.dispatchEvent(
                  new CustomEvent("shax:emit-command", {
                    detail: { paneId, command },
                  }),
                );
                window.dispatchEvent(
                  new CustomEvent("shax:emit-command", {
                    detail: { paneId, command: "git status" },
                  }),
                );
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Look up the flat-list index of a specific section's header
 *  (or one of its entries) — used to align the section-level
 *  DOM's `data-focused` / focus-follow logic with the flat
 *  index. */
function flatIndexOfSectionHeader(flat: FlatItem[], kind: SectionKind): number {
  for (let i = 0; i < flat.length; i++) {
    const item = flat[i];
    if (item?.kind === "section" && item.section === kind) return i;
  }
  return -1;
}

function flatIndexOfEntry(flat: FlatItem[], kind: SectionKind, path: string): number {
  for (let i = 0; i < flat.length; i++) {
    const item = flat[i];
    if (item?.kind === "entry" && item.section === kind && item.entry.path === path) return i;
  }
  return -1;
}

/** Build the visible command a Space press should emit for
 *  the given entry. `null` means "no action" — currently only
 *  the unmerged / conflict case (resolving is out of scope).
 *
 *  Bare form because commands only fire from a *live* widget
 *  (per spec §08 the widget freezes when the next command
 *  runs). A live widget's origin cwd equals the shell cwd,
 *  so no `-C <path>` scope is needed. Historical widgets are
 *  gated out at the caller. */
function commandForAction(section: SectionKind, entry: StatusEntry): string | null {
  const path = shellEscape(entry.path);
  if (section === "staged") return `git reset HEAD -- ${path}`;
  if (section === "unstaged") return `git add -- ${path}`;
  if (section === "untracked") return `git add -- ${path}`;
  return null;
}

/** Minimal POSIX quoting — wrap in single quotes and escape
 *  embedded single quotes with `'\''`. Sufficient for the
 *  paths git status emits (which never contain shell
 *  metacharacters unquoted). */
function shellEscape(path: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

interface SectionProps {
  kind: SectionKind;
  entries: StatusEntry[];
  collapsed: boolean;
  onToggleSection: () => void;
  sectionHeaderIndex: number;
  indexOfEntry: (entry: StatusEntry) => number;
  focusedIndex: number | null;
  onFocusRow: (idx: number) => void;
  onAction: (entry: StatusEntry) => void;
  /** When false, hides the "Space: git add" style hints so
   *  the entry row doesn't lie about being actionable. */
  isLive: boolean;
}

const SECTION_HEADER_FOCUSED: CSSProperties = {
  ...SECTION_HEADER_STYLE,
  boxShadow: "inset 3px 0 0 var(--accent)",
  background: "color-mix(in srgb, var(--accent) 14%, var(--surface))",
};

function Section({
  kind,
  entries,
  collapsed,
  onToggleSection,
  sectionHeaderIndex,
  indexOfEntry,
  focusedIndex,
  onFocusRow,
  onAction,
  isLive,
}: SectionProps): React.ReactElement | null {
  if (entries.length === 0) return null;
  const title = sectionTitle(kind);
  const headerFocused = focusedIndex === sectionHeaderIndex;
  return (
    <div data-testid={`widget-git-status-section-${kind}`} data-collapsed={collapsed}>
      <div
        style={headerFocused ? SECTION_HEADER_FOCUSED : SECTION_HEADER_STYLE}
        onClick={() => {
          onFocusRow(sectionHeaderIndex);
          onToggleSection();
        }}
        data-testid={`widget-git-status-section-${kind}-header`}
        data-focused={headerFocused}
      >
        <span style={{ width: 8, color: "var(--fg-faint)" }} aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span>{title}</span>
        <span style={{ marginLeft: "auto", color: "var(--fg-faint)" }}>
          {entries.length}
          {headerFocused && (
            <span style={{ ...HINT_STYLE, marginLeft: 8 }}>
              {collapsed ? "l: expand" : "h: collapse"}
            </span>
          )}
        </span>
      </div>
      {!collapsed &&
        entries.map((entry) => {
          const flatIndex = indexOfEntry(entry);
          const focused = focusedIndex === flatIndex;
          const { glyph, color } = statusGlyph(entry);
          const hint = actionHint(kind);
          return (
            <div
              key={`${entry.path}::${entry.origPath ?? ""}`}
              data-testid="widget-git-status-entry"
              data-section={kind}
              data-path={entry.path}
              data-focused={focused}
              style={focused ? ENTRY_FOCUSED : ENTRY_STYLE}
              onClick={() => {
                onFocusRow(flatIndex);
              }}
              onDoubleClick={() => onAction(entry)}
            >
              <span style={{ color }}>{glyph}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {entry.origPath !== null ? `${entry.origPath} → ${entry.path}` : entry.path}
              </span>
              {focused && isLive && hint !== null && <span style={HINT_STYLE}>{hint}</span>}
            </div>
          );
        })}
    </div>
  );
}

function sectionTitle(kind: SectionKind): string {
  switch (kind) {
    case "unmerged":
      return "conflicts";
    case "staged":
      return "staged";
    case "unstaged":
      return "unstaged";
    case "untracked":
      return "untracked";
  }
}

function actionHint(kind: SectionKind): string | null {
  switch (kind) {
    case "staged":
      return "Space: git reset";
    case "unstaged":
      return "Space: git add";
    case "untracked":
      return "Space: git add";
    case "unmerged":
      return null;
  }
}

function statusGlyph(entry: StatusEntry): { glyph: string; color: string } {
  if (entry.unmerged) return { glyph: "UU", color: "var(--red)" };
  if (entry.index === "?" || entry.worktree === "?") {
    return { glyph: "??", color: "var(--fg-faint)" };
  }
  const xy = `${entry.index}${entry.worktree}`;
  const color =
    entry.index !== "." ? "var(--green)" : entry.worktree !== "." ? "var(--red)" : "var(--fg-dim)";
  return { glyph: xy, color };
}
