/**
 * `ls` interactive widget (M5 slice 3).
 *
 * The third and final widget in M5, and the last of the
 * spec §08 sequence. Reuses the silent-reads +
 * sticky-bottom-live + honest-log machinery proven out on
 * git-status:
 *
 *   - Every mutation (`cd`, `cat`) emits a **visible command**
 *     into the shell. No hidden side effects.
 *   - The widget re-probes silently on its own widget-emitted
 *     block completions, updating in place; freezes when the
 *     user runs an unrelated command.
 *   - While live, the widget's row pins to the visual bottom
 *     via `data-widget-live` + CSS `order`.
 *
 * User's scoping decisions for slice 3:
 *
 *   - **Inline detail row** — every row shows icon + name +
 *     size + mtime in one line. No side / bottom panel.
 *   - **Honour `-a`** — dotfiles appear when the user passed
 *     `-a` / `-A` / `--all` / `--almost-all`. Otherwise hidden.
 *   - **Skip `-l`** — the widget is always dense-with-details
 *     regardless of `-l`; the flag is accepted but has no
 *     effect on the render.
 *
 * Actions:
 *
 *   - **Space on a folder** → emit `cd <name>` and freeze
 *     immediately (the widget's dir listing is now stale as
 *     soon as cwd changes; running `ls` again produces a
 *     fresh widget in the new location).
 *   - **Space on a file** → emit `cat <name>` (visible
 *     preview). The dir listing hasn't changed, so the
 *     silent re-probe is a no-op refresh.
 *   - **`l` / →** on a folder → expand in place (silent
 *     read of its contents; children render indented under
 *     the parent).
 *   - **`h` / ←** on an expanded folder → collapse.
 *   - **`h` / ←** on a child inside an expanded folder →
 *     collapse the parent and refocus the parent row.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  applyLsView,
  entryColor,
  entryIcon,
  formatLsMtime,
  humanSize,
  type LsFlags,
} from "../../formatters/ls";
import { readDirEntries, type DirEntry, type PtyId } from "../../lib/ipc";

export interface LsWidgetProps {
  /** Initial directory contents from the formatter's first
   *  probe. Every subsequent widget-emit triggers a silent
   *  re-probe against `dirPath`. */
  initialEntries: readonly DirEntry[];
  /** The absolute directory the widget represents. Used for
   *  the silent re-probe path and for constructing children's
   *  paths on expand. */
  dirPath: string;
  paneId: PtyId;
  /** Parsed argv flags — controls dotfile visibility + sort
   *  order. Sort is applied to every fresh probe (root and
   *  expanded children) so the view stays consistent. */
  flags: LsFlags;
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
  gap: 10,
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
  padding: "4px 0",
};

const ROW: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "0.6em 1.4em 1fr 6em 12em",
  gap: 8,
  alignItems: "baseline",
  padding: "1px 10px",
  cursor: "pointer",
  userSelect: "none",
};

const ROW_FOCUSED: CSSProperties = {
  ...ROW,
  boxShadow: "inset 3px 0 0 var(--accent)",
  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
};

const HINT_STYLE: CSSProperties = {
  color: "var(--fg-faint)",
  fontSize: 10,
  marginLeft: 8,
};

const EMPTY_NOTE: CSSProperties = {
  padding: 20,
  textAlign: "center",
  color: "var(--fg-faint)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
};

/** One row in the flattened tree view. `depth` drives the
 *  indent; `absolutePath` is what we use for cd / cat / probe. */
interface FlatRow {
  entry: DirEntry;
  depth: number;
  parentPath: string;
  absolutePath: string;
}

export function LsWidget({
  initialEntries,
  dirPath,
  paneId,
  flags,
}: LsWidgetProps): React.ReactElement {
  const [rootEntries, setRootEntries] = useState<readonly DirEntry[]>(initialEntries);
  // `expandedChildren[absolutePath] === DirEntry[]` when the
  // user has expanded that folder. Missing = collapsed.
  const [expandedChildren, setExpandedChildren] = useState<Record<string, DirEntry[]>>({});
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const focusedIndexRef = useRef<number | null>(null);
  focusedIndexRef.current = focusedIndex;

  const [isLive, setIsLive] = useState(true);
  const isLiveRef = useRef(true);
  isLiveRef.current = isLive;

  const hostRef = useRef<HTMLDivElement>(null);

  // Build the flat rendered list by walking the root + any
  // expanded children recursively.
  const flat = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    const walk = (entries: readonly DirEntry[], parentPath: string, depth: number): void => {
      const view = applyLsView(entries, flags);
      for (const entry of view) {
        const absolutePath = joinPath(parentPath, entry.name);
        out.push({ entry, depth, parentPath, absolutePath });
        if (entry.kind === "dir") {
          const children = expandedChildren[absolutePath];
          if (children !== undefined) walk(children, absolutePath, depth + 1);
        }
      }
    };
    walk(rootEntries, dirPath, 0);
    return out;
  }, [rootEntries, expandedChildren, flags, dirPath]);
  const flatRef = useRef(flat);
  flatRef.current = flat;

  // Clamp focused index when the flat list shrinks (e.g. user
  // collapses a subtree the focus was inside).
  useEffect(() => {
    if (focusedIndex === null) return;
    if (focusedIndex >= flat.length) {
      setFocusedIndex(flat.length === 0 ? null : flat.length - 1);
    }
  }, [flat.length, focusedIndex]);

  // Sticky-bottom pinning while live: sets `data-widget-live`
  // on the enclosing block row so BlockRow.css can promote
  // the row to the visual end of the list. Also subscribes to
  // `shax:block-complete` for freeze / silent-refresh.
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const blockEl = el.closest<HTMLElement>("[data-block-id]");
    if (blockEl === null) return;
    if (blockEl.getAttribute("data-is-latest") !== "true") setIsLive(false);
    blockEl.setAttribute("data-widget-live", "true");
    // Capture the widget's own block id so we can distinguish "our
    // block finished streaming" (no-op) from "the user typed a fresh
    // command after us, freeze" (setIsLive(false)). Without this
    // check the widget freezes itself the moment its own OSC 133 D
    // fires, which shows the "historical" badge on every fresh ls.
    const ownBlockId = blockEl.getAttribute("data-block-id");
    const onBlockComplete = (e: Event): void => {
      const detail = (
        e as CustomEvent<{
          paneId: string;
          blockId: string;
          source: "widget" | "ai" | "palette" | "user";
        }>
      ).detail;
      if (detail?.paneId !== paneId) return;
      if (detail.source === "widget") {
        // Widget-emit finished. If we're already frozen (e.g.
        // we emitted `cd` and pre-froze) skip the re-probe.
        if (!isLiveRef.current) return;
        void readDirEntries(dirPath).then(
          (entries) => setRootEntries(entries),
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`ls widget refresh failed: ${msg}`);
          },
        );
        return;
      }
      // Our own block's completion event is not a "user typed a new
      // command" signal — skip it. Only *subsequent* user-typed
      // blocks should freeze this widget.
      if (detail.blockId === ownBlockId) return;
      setIsLive(false);
    };
    window.addEventListener("shax:block-complete", onBlockComplete);
    return () => {
      window.removeEventListener("shax:block-complete", onBlockComplete);
      blockEl.removeAttribute("data-widget-live");
    };
  }, [paneId, dirPath]);

  // Keep `data-widget-live` in sync with the isLive state so
  // freeze also drops the visual pinning.
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const blockEl = el.closest<HTMLElement>("[data-block-id]");
    if (blockEl === null) return;
    if (isLive) blockEl.setAttribute("data-widget-live", "true");
    else blockEl.removeAttribute("data-widget-live");
  }, [isLive]);

  // Widget-nav listener — j/k walk the flat list, l/right
  // expands the focused folder, h/left collapses the focused
  // (or, if the focused row is inside an expanded folder,
  // collapses the parent and refocuses it).
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const blockEl = el.closest<HTMLElement>("[data-block-id]");
    if (blockEl === null) return;
    const blockId = blockEl.getAttribute("data-block-id");
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
        case "right": {
          const target = cur ?? 0;
          const row = items[target];
          if (row === undefined) return;
          if (cur === null) moveFocus(0);
          if (row.entry.kind !== "dir") return;
          // Already expanded → don't claim (falls through so
          // block-focus can advance the block if there's
          // nowhere to go inside the widget).
          if (expandedChildrenRef.current[row.absolutePath] !== undefined) return;
          expandDir(row.absolutePath);
          detail.claimed = true;
          return;
        }
        case "left": {
          const target = cur ?? 0;
          const row = items[target];
          if (row === undefined) return;
          if (cur === null) moveFocus(0);
          if (row.entry.kind === "dir" && expandedChildrenRef.current[row.absolutePath]) {
            // Folder is expanded → collapse it.
            collapseDir(row.absolutePath);
            detail.claimed = true;
            return;
          }
          if (row.depth > 0) {
            // Row is a child inside an expanded folder →
            // collapse the parent + refocus the parent row.
            const parentIdx = findRowIndex(items, row.parentPath);
            if (parentIdx >= 0) moveFocus(parentIdx);
            collapseDir(row.parentPath);
            detail.claimed = true;
            return;
          }
          return;
        }
      }
    };
    window.addEventListener("shax:widget-nav", onNav);
    return () => window.removeEventListener("shax:widget-nav", onNav);
  }, []);

  // Space → primary action. Folder = cd (+ freeze immediately);
  // file = cat (visible preview).
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
      if (!isLiveRef.current) return;
      const cur = focusedIndexRef.current;
      if (cur === null) return;
      const row = flatRef.current[cur];
      if (row === undefined) return;
      if (row.entry.kind === "dir") {
        // `cd` changes cwd → widget's dir listing is stale
        // the moment the shell processes it. Freeze first so
        // the silent-refresh listener above doesn't try to
        // re-probe the old dir after the block completes.
        setIsLive(false);
        isLiveRef.current = false;
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: { paneId, command: `cd ${shellEscape(row.absolutePath)}` },
          }),
        );
        detail.claimed = true;
        return;
      }
      if (row.entry.kind === "file") {
        window.dispatchEvent(
          new CustomEvent("shax:emit-command", {
            detail: { paneId, command: `cat ${shellEscape(row.absolutePath)}` },
          }),
        );
        detail.claimed = true;
        return;
      }
      // Other kinds (symlink, device, socket, fifo, other) —
      // no primary action for slice 3 v1. Don't claim.
    };
    window.addEventListener("shax:widget-primary", onPrimary);
    return () => window.removeEventListener("shax:widget-primary", onPrimary);
  }, [paneId]);

  // Scroll the focused row into view as focus moves.
  useEffect(() => {
    if (focusedIndex === null) return;
    const el = hostRef.current;
    if (el === null) return;
    const rows = el.querySelectorAll<HTMLElement>('[data-testid="widget-ls-row"]');
    const row = rows[focusedIndex];
    if (row === undefined) return;
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusedIndex]);

  // Refs used by the nav closure so it stays stable.
  const expandedChildrenRef = useRef(expandedChildren);
  expandedChildrenRef.current = expandedChildren;

  /** Kick off a silent read of a subdirectory and stash its
   *  entries under `absolutePath` when the read returns. */
  function expandDir(absolutePath: string): void {
    setExpandedChildren((prev) => {
      if (prev[absolutePath] !== undefined) return prev;
      // Optimistic: mark as expanded with `[]` while the probe
      // lands. Empty subtree is a valid steady state anyway.
      return { ...prev, [absolutePath]: [] };
    });
    void readDirEntries(absolutePath).then(
      (entries) => {
        setExpandedChildren((prev) => ({ ...prev, [absolutePath]: entries }));
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`ls widget expand ${absolutePath} failed: ${msg}`);
        // Roll back to collapsed on error rather than leaving
        // an empty-looking folder that isn't really empty.
        setExpandedChildren((prev) => {
          const next = { ...prev };
          delete next[absolutePath];
          return next;
        });
      },
    );
  }

  function collapseDir(absolutePath: string): void {
    setExpandedChildren((prev) => {
      if (prev[absolutePath] === undefined) return prev;
      const next = { ...prev };
      delete next[absolutePath];
      return next;
    });
  }

  return (
    <div
      data-testid="widget-ls"
      ref={hostRef}
      data-is-live={isLive ? "true" : "false"}
      style={HOST}
    >
      <div style={HEADER}>
        <span data-testid="widget-ls-path" style={{ color: "var(--fg)" }}>
          {dirPath}
        </span>
        {!isLive && (
          <span
            data-testid="widget-ls-historical"
            style={{
              fontSize: 10,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: "var(--fg-faint)",
              border: "1px solid var(--border-strong)",
              borderRadius: 3,
              padding: "1px 6px",
            }}
            title="Historical block — re-run `ls` for a live widget"
          >
            historical
          </span>
        )}
        <span
          data-testid="widget-ls-summary"
          style={{ flex: 1, textAlign: "right", color: "var(--fg-faint)" }}
        >
          {flat.length} entr{flat.length === 1 ? "y" : "ies"}
        </span>
      </div>
      <div style={{ ...SCROLLER, opacity: isLive ? 1 : 0.72 }} data-block-scroll-host="ls-widget">
        {flat.length === 0 ? (
          <div style={EMPTY_NOTE}>empty directory</div>
        ) : (
          flat.map((row, index) => (
            <LsRow
              key={row.absolutePath}
              row={row}
              focused={focusedIndex === index}
              expanded={
                row.entry.kind === "dir" ? expandedChildren[row.absolutePath] !== undefined : false
              }
              showHint={focusedIndex === index && isLive}
              onFocus={() => setFocusedIndex(index)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface LsRowProps {
  row: FlatRow;
  focused: boolean;
  expanded: boolean;
  showHint: boolean;
  onFocus: () => void;
}

function LsRow({ row, focused, expanded, showHint, onFocus }: LsRowProps): React.ReactElement {
  const { entry, depth } = row;
  const isDir = entry.kind === "dir";
  const chevron = isDir ? (expanded ? "▾" : "▸") : "";
  const hint = focused && showHint ? actionHint(entry) : null;
  return (
    <div
      data-testid="widget-ls-row"
      data-kind={entry.kind}
      data-focused={focused}
      data-path={row.absolutePath}
      onClick={onFocus}
      style={{
        ...(focused ? ROW_FOCUSED : ROW),
        paddingLeft: 10 + depth * 14,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          color: "var(--fg-faint)",
          fontSize: 9,
          width: 8,
          textAlign: "center",
          userSelect: "none",
        }}
      >
        {chevron}
      </span>
      <span aria-hidden="true" style={{ color: entryColor(entry), textAlign: "center" }}>
        {entryIcon(entry)}
      </span>
      <span
        style={{
          color: entryColor(entry),
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.name}
        {entry.kind === "dir" ? "/" : ""}
        {entry.kind === "symlink" && entry.symlink_target !== null ? (
          <span style={{ color: "var(--fg-faint)" }}> → {entry.symlink_target}</span>
        ) : null}
        {hint !== null && <span style={HINT_STYLE}>{hint}</span>}
      </span>
      <span
        style={{ color: "var(--fg-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}
      >
        {entry.kind === "dir" ? "—" : humanSize(entry.size)}
      </span>
      <span style={{ color: "var(--fg-faint)", fontVariantNumeric: "tabular-nums" }}>
        {formatLsMtime(entry.modified_ms)}
      </span>
    </div>
  );
}

function actionHint(entry: DirEntry): string | null {
  if (entry.kind === "dir") return "Space: cd  ·  l: expand";
  if (entry.kind === "file") return "Space: cat";
  return null;
}

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

/** POSIX-safe path escape — same shape as git-status widget. */
function shellEscape(path: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function findRowIndex(rows: readonly FlatRow[], absolutePath: string): number {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.absolutePath === absolutePath) return i;
  }
  return -1;
}
