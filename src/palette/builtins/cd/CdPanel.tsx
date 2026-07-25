/**
 * `cd to directory` panel — the M8.2 built-in file browser
 * (spec §14 "The `cd` file browser").
 *
 * Single-pane MC-flavoured navigation. Behaviour beats layout:
 *
 *   - Header: breadcrumb of the current path (each segment
 *     clickable to jump up).
 *   - Body: dirs first, then files (files are greyed since
 *     selecting one is a no-op — `cd` needs a directory).
 *   - Type-to-filter narrows the list in place.
 *   - `↑` / `↓` / `j` / `k` move the selection; `Enter` on a dir
 *     descends; `Backspace` / `h` goes up.
 *   - `⌘Enter` (Ctrl+Enter elsewhere) or the footer button
 *     picks the current directory without descending.
 *   - `⌘H` toggles hidden files (off by default).
 *   - Symlinks show the link icon and, when followed, descend
 *     into the target.
 *
 * Returns `cd <absolute-path>` to the palette host; the host
 * shows the preview line, `Enter` submits, `Esc` cancels
 * (backs out to the palette list).
 *
 * Uses the existing `read_dir_entries` Rust IPC — the same
 * probe the `ls` formatter runs, so classifications match
 * spec §07 rule 2 ("probe, don't screen-scrape").
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useHomeDir } from "../../../lib/HomeDirContext";
import { readDirEntries, type DirEntry, type DirEntryKind } from "../../../lib/ipc";
import { shellEscape } from "../../../lib/shellEscape";
import type { PaneContext } from "../../registry";

export interface CdPanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

const PANEL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minHeight: 340,
};

const BREADCRUMB: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 2,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-dim)",
};

const SEGMENT: CSSProperties = {
  cursor: "pointer",
  padding: "1px 4px",
  borderRadius: 3,
  color: "var(--accent)",
};

const SEGMENT_SEP: CSSProperties = {
  color: "var(--fg-faint)",
};

const FILTER_INPUT: CSSProperties = {
  padding: "6px 10px",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  outline: "none",
};

const LIST: CSSProperties = {
  flex: 1,
  maxHeight: 320,
  overflowY: "auto",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const ROW_BASE: CSSProperties = {
  padding: "3px 10px",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const ROW_SELECTED: CSSProperties = {
  ...ROW_BASE,
  background: "var(--surface-hover)",
};

const ROW_FILE: CSSProperties = {
  color: "var(--fg-faint)",
  cursor: "default",
};

const FOOTER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  paddingTop: 4,
  fontSize: 11,
  color: "var(--fg-dim)",
};

const FOOTER_HINT: CSSProperties = {
  flex: 1,
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

const USE_BUTTON: CSSProperties = {
  padding: "5px 10px",
  border: "1px solid var(--accent)",
  borderRadius: 4,
  background: "var(--accent)",
  color: "#fff",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const ERROR: CSSProperties = {
  padding: 10,
  color: "var(--red)",
  fontSize: 12,
};

/** Path.dirname equivalent that doesn't depend on Node. Returns
 *  `/` for the root and handles trailing slashes gracefully. */
function parentPath(p: string): string {
  if (p === "/" || p.length === 0) return "/";
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

/** Segments for the breadcrumb, absolute-path form. `[""]` for `/`. */
function breadcrumbSegments(p: string): string[] {
  if (p === "/" || p.length === 0) return ["/"];
  const parts = p.split("/").filter((s) => s.length > 0);
  return ["/", ...parts];
}

/** Rebuild the absolute path from breadcrumb segments up to and including `index`. */
function pathForSegment(segments: string[], index: number): string {
  if (index === 0) return "/";
  return "/" + segments.slice(1, index + 1).join("/");
}

/** Join a parent dir with a child name into an absolute path. */
function join(parent: string, name: string): string {
  if (parent === "/") return "/" + name;
  return parent + "/" + name;
}

const KIND_ICON: Record<DirEntryKind, string> = {
  dir: "▸",
  file: "·",
  symlink: "↳",
  device: "◇",
  socket: "◈",
  fifo: "⤳",
  other: "?",
};

const KIND_COLOR: Record<DirEntryKind, string> = {
  dir: "var(--accent)",
  file: "var(--fg-faint)",
  symlink: "var(--magenta)",
  device: "var(--fg-dim)",
  socket: "var(--fg-dim)",
  fifo: "var(--fg-dim)",
  other: "var(--fg-dim)",
};

/** Rows the panel actually navigates: dirs and (followable)
 *  symlinks are selectable; files are shown but not selectable. */
interface FlatEntry {
  entry: DirEntry;
  selectable: boolean;
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    // Directories (and symlinks — we don't know until follow) first.
    const aDir = a.kind === "dir" || a.kind === "symlink" ? 0 : 1;
    const bDir = b.kind === "dir" || b.kind === "symlink" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });
}

export function CdPanel({ ctx, onSubmit }: CdPanelProps): React.ReactElement {
  const home = useHomeDir();
  const [currentPath, setCurrentPath] = useState<string>(() => ctx.cwd ?? home ?? "/");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    readDirEntries(currentPath)
      .then((results) => {
        if (cancelled) return;
        setEntries(results);
        setSelectedIndex(0);
        setFilter("");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  // Focus the filter input on mount so type-to-filter works
  // without a click.
  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  const flat: FlatEntry[] = useMemo(() => {
    if (entries === null) return [];
    const q = filter.trim().toLowerCase();
    const visible = entries
      .filter((e) => showHidden || !e.name.startsWith("."))
      .filter((e) => q.length === 0 || e.name.toLowerCase().includes(q));
    return sortEntries(visible).map((entry) => ({
      entry,
      // Dirs are always selectable. Symlinks are best-effort
      // selectable; if the target isn't a dir the descend will
      // fail with a directory-read error, which we surface.
      selectable: entry.kind === "dir" || entry.kind === "symlink",
    }));
  }, [entries, filter, showHidden]);

  // Clamp selection when the visible list shrinks.
  useEffect(() => {
    if (selectedIndex >= flat.length) {
      setSelectedIndex(Math.max(0, flat.length - 1));
    }
  }, [flat.length, selectedIndex]);

  const emitCurrent = useCallback((): void => {
    onSubmit(`cd ${shellEscape(currentPath)}`);
  }, [currentPath, onSubmit]);

  const descend = useCallback((): void => {
    const row = flat[selectedIndex];
    if (row === undefined || !row.selectable) return;
    setCurrentPath(join(currentPath, row.entry.name));
  }, [flat, selectedIndex, currentPath]);

  const goUp = useCallback((): void => {
    if (currentPath === "/") return;
    setCurrentPath(parentPath(currentPath));
  }, [currentPath]);

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // ⌘Enter / Ctrl+Enter — pick the current directory outright.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      emitCurrent();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      descend();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "j" && !hasWordMod(e))) {
      // Only intercept `j` when the filter is empty (so typing
      // "jest" into the filter still works). Same for `k`, `h`.
      if (e.key === "j" && filter.length > 0) return;
      e.preventDefault();
      setSelectedIndex((i) => Math.min(flat.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "k" && !hasWordMod(e))) {
      if (e.key === "k" && filter.length > 0) return;
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Backspace" && filter.length === 0) {
      e.preventDefault();
      goUp();
      return;
    }
    if (e.key === "h" && filter.length === 0 && !hasWordMod(e)) {
      e.preventDefault();
      goUp();
      return;
    }
    // ⌘H toggles hidden.
    if ((e.key === "h" || e.key === "H") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      setShowHidden((v) => !v);
      return;
    }
  };

  const segments = breadcrumbSegments(currentPath);

  return (
    <div style={PANEL} data-testid="palette-cd-panel">
      <div style={BREADCRUMB} data-testid="palette-cd-breadcrumb">
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1;
          return (
            <span key={i}>
              <span
                style={isLast ? { ...SEGMENT, color: "var(--fg)" } : SEGMENT}
                onClick={() => {
                  if (isLast) return;
                  setCurrentPath(pathForSegment(segments, i));
                }}
              >
                {seg === "/" ? "/" : seg}
              </span>
              {!isLast && seg !== "/" && <span style={SEGMENT_SEP}>/</span>}
            </span>
          );
        })}
      </div>

      <input
        ref={filterRef}
        style={FILTER_INPUT}
        data-testid="palette-cd-filter"
        placeholder="filter (type to narrow; empty to nav with h/j/k)"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setSelectedIndex(0);
        }}
        onKeyDown={handleKey}
      />

      {error !== null && <div style={ERROR}>{error}</div>}

      {entries === null && error === null && (
        <div style={{ padding: 10, color: "var(--fg-dim)", fontSize: 12 }}>Reading…</div>
      )}

      {entries !== null && (
        <div style={LIST} ref={listRef} data-testid="palette-cd-list">
          {flat.length === 0 && (
            <div style={{ padding: 10, color: "var(--fg-faint)", fontSize: 12 }}>
              {filter.length > 0 ? "No matches." : "(empty)"}
            </div>
          )}
          {flat.map(({ entry, selectable }, i) => {
            const selected = i === selectedIndex;
            const baseStyle = selected ? ROW_SELECTED : ROW_BASE;
            const style = selectable ? baseStyle : { ...baseStyle, ...ROW_FILE };
            return (
              <div
                key={entry.name}
                data-testid="palette-cd-row"
                data-selected={selected ? "true" : "false"}
                data-kind={entry.kind}
                style={style}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => {
                  if (!selectable) return;
                  setSelectedIndex(i);
                  setCurrentPath(join(currentPath, entry.name));
                }}
              >
                <span aria-hidden="true" style={{ color: KIND_COLOR[entry.kind] }}>
                  {KIND_ICON[entry.kind]}
                </span>
                <span style={{ color: KIND_COLOR[entry.kind] }}>{entry.name}</span>
                {entry.kind === "symlink" && entry.symlink_target !== null && (
                  <span style={{ color: "var(--fg-faint)", marginLeft: 4 }}>
                    → {entry.symlink_target}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={FOOTER}>
        <span style={FOOTER_HINT}>
          <kbd style={KBD}>⏎</kbd>enter dir
          <kbd style={KBD}>⌘⏎</kbd>use current
          <kbd style={KBD}>⌫</kbd>up
          <kbd style={KBD}>⌘H</kbd>hidden {showHidden ? "on" : "off"}
        </span>
        <button
          type="button"
          data-testid="palette-cd-use-current"
          style={USE_BUTTON}
          onClick={emitCurrent}
        >
          Use this dir
        </button>
      </div>
    </div>
  );
}

/** True when `e` carries a word-forming modifier that means the
 *  user is typing a letter, not issuing a navigation gesture. */
function hasWordMod(e: React.KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}
