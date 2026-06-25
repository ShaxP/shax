/**
 * Block-search overlay (M3 slices 3.1 + 3.2).
 *
 * Centred modal over the pane area. A single FTS5-backed query input
 * drives a debounced search; a row of filter chips above it composes
 * status and time filters into the same request. Results are compact
 * block rows with a matched-output snippet underneath when the hit
 * landed in the captured output (vs. the command line).
 *
 * Keyboard nav: `↑` / `↓` moves the highlighted result, `Enter`
 * activates it. Activation hands the hit off to the caller via
 * `onSelect`; App decides whether to jump to a still-alive pane or
 * fall back to the read-only viewer modal.
 *
 * 3.3 will add cwd + branch text-filters and inline highlight of the
 * matched terms in the command line. Keep the chip row + result row
 * structure stable so those layer in.
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { searchBlocks } from "../lib/ipc";
import type { SearchHit, SearchStatus } from "../lib/ipc";
import { formatDuration } from "./blockFormat";

export interface SearchOverlayProps {
  /** Caller closes the overlay (Esc or backdrop click). */
  onClose: () => void;
  /** Caller routes the chosen hit (jump to pane vs. open viewer modal). */
  onSelect: (hit: SearchHit) => void;
}

const DEBOUNCE_MS = 150;
const RESULT_LIMIT = 50;

// ── time filter ──────────────────────────────────────────────────────────────

type TimeBucket = "any" | "hour" | "day" | "week" | "month";

const TIME_LABELS: Record<TimeBucket, string> = {
  any: "Any time",
  hour: "Last hour",
  day: "Last 24h",
  week: "Last 7d",
  month: "Last 30d",
};

const TIME_ORDER: TimeBucket[] = ["any", "hour", "day", "week", "month"];

function bucketToSinceMs(bucket: TimeBucket, nowMs: number): number | undefined {
  switch (bucket) {
    case "any":
      return undefined;
    case "hour":
      return nowMs - 60 * 60 * 1000;
    case "day":
      return nowMs - 24 * 60 * 60 * 1000;
    case "week":
      return nowMs - 7 * 24 * 60 * 60 * 1000;
    case "month":
      return nowMs - 30 * 24 * 60 * 60 * 1000;
  }
}

// ── status filter ────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<SearchStatus, string> = {
  any: "Any status",
  ok: "✓ Success",
  fail: "✗ Failed",
  aborted: "· Aborted",
};

const STATUS_ORDER: SearchStatus[] = ["any", "ok", "fail", "aborted"];

function cycle<T>(order: T[], current: T): T {
  const i = order.indexOf(current);
  return order[(i + 1) % order.length] ?? current;
}

// ── styles ───────────────────────────────────────────────────────────────────

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.45)",
  zIndex: 1000,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "12vh",
};

const PANEL: CSSProperties = {
  width: "min(720px, 90vw)",
  maxHeight: "76vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--surface)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius)",
  boxShadow: "0 18px 48px rgba(0, 0, 0, 0.45)",
  fontFamily: "var(--font-ui)",
  overflow: "hidden",
};

const QUERY_INPUT: CSSProperties = {
  width: "100%",
  background: "var(--pane)",
  color: "var(--fg)",
  border: "none",
  outline: "none",
  padding: "14px 16px",
  fontFamily: "var(--font-mono)",
  fontSize: 14,
};

const CHIP_ROW: CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "8px 14px",
  borderTop: "1px solid var(--border)",
  borderBottom: "1px solid var(--border)",
  background: "var(--pane2)",
};

const CHIP_BASE: CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: 11.5,
  padding: "4px 9px",
  borderRadius: "999px",
  cursor: "pointer",
  userSelect: "none",
  border: "1px solid var(--border)",
};

const STATUS_ROW: CSSProperties = {
  padding: "8px 16px",
  fontSize: 11,
  color: "var(--fg-faint)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  borderBottom: "1px solid var(--border)",
};

const RESULT_LIST: CSSProperties = {
  overflowY: "auto",
  flex: 1,
};

const RESULT_ROW_BASE: CSSProperties = {
  padding: "10px 16px",
  borderBottom: "1px solid var(--border)",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const COMMAND_LINE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--fg)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const META_LINE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const SNIPPET_LINE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  color: "var(--fg-dim)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const MARK_STYLE: CSSProperties = {
  background: "var(--accent-soft)",
  color: "var(--fg)",
  padding: "0 2px",
  borderRadius: 2,
};

function statusGlyph(b: SearchHit["block"]): string {
  if (b.aborted) return "·";
  if (b.exit_code === null) return "…";
  return b.exit_code === 0 ? "✓" : "✗";
}

function statusColor(b: SearchHit["block"]): string {
  if (b.aborted) return "var(--fg-faint)";
  if (b.exit_code === null) return "var(--accent)";
  return b.exit_code === 0 ? "var(--green)" : "var(--red)";
}

/**
 * Render a backend-provided snippet string (e.g. `before <mark>foo</mark> after`)
 * as a sequence of React nodes with the `<mark>` ranges highlighted. We don't
 * use `dangerouslySetInnerHTML` — the snippet text comes from user-run commands
 * and could contain anything; treat the marker tokens as literal delimiters and
 * render the surrounding text as plain strings.
 */
function renderSnippet(raw: string): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  const OPEN = "<mark>";
  const CLOSE = "</mark>";
  while (cursor < raw.length) {
    const open = raw.indexOf(OPEN, cursor);
    if (open === -1) {
      parts.push(raw.slice(cursor));
      break;
    }
    if (open > cursor) parts.push(raw.slice(cursor, open));
    const close = raw.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) {
      parts.push(raw.slice(open));
      break;
    }
    const inside = raw.slice(open + OPEN.length, close);
    parts.push(
      <mark key={`m-${open}`} style={MARK_STYLE}>
        {inside}
      </mark>,
    );
    cursor = close + CLOSE.length;
  }
  return parts;
}

// ── component ────────────────────────────────────────────────────────────────

export function SearchOverlay({ onClose, onSelect }: SearchOverlayProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("any");
  const [time, setTime] = useState<TimeBucket>("any");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Autofocus the input on mount so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce the query so the user gets snappy keystrokes without the
  // SQLite mutex thrashing on every letter. Filter changes are also
  // deps so toggling a chip refreshes the results.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = setTimeout(() => {
      const since = bucketToSinceMs(time, Date.now());
      void searchBlocks({
        query: trimmed,
        limit: RESULT_LIMIT,
        offset: 0,
        status,
        since_ms: since,
      }).then((hits) => {
        setResults(hits);
        setSelected(0);
        setLoading(false);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, status, time]);

  // Keyboard handling — scoped to the window while the overlay is up.
  // Refs let the listener observe the latest results/selected without
  // re-registering on every state change (which would otherwise tear down
  // and re-add the listener mid-event between ArrowDown and the render).
  // `useLayoutEffect` (not `useEffect`) so the refs are updated
  // synchronously with the commit — otherwise the keydown handler can
  // fire from a queued event between commit and paint and observe a
  // stale view (e.g. results was rendered but the ref hasn't caught up
  // yet, which surfaces as flaky keyboard nav in the tests).
  const resultsRef = useRef(results);
  const selectedRef = useRef(selected);
  useLayoutEffect(() => {
    resultsRef.current = results;
  }, [results]);
  useLayoutEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const hits = resultsRef.current;
      if (hits.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => Math.min(hits.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const hit = hits[selectedRef.current];
        if (hit !== undefined) onSelect(hit);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onSelect]);

  // Keep the selected row scrolled into view when ↑/↓ moves it offscreen.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const row = list.querySelector<HTMLDivElement>(
      `[data-testid="search-result"][data-index="${selected}"]`,
    );
    // `scrollIntoView` is undefined in jsdom (test env). The guard
    // keeps tests from crashing on a method that exists in every real
    // browser.
    if (row !== null && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  const handleBackdropPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const trimmed = query.trim();
  const showEmpty = trimmed !== "" && !loading && results.length === 0;
  const showHint = trimmed === "";

  return (
    <div data-testid="search-overlay" style={BACKDROP} onPointerDown={handleBackdropPointerDown}>
      <div style={PANEL} role="dialog" aria-label="Search history">
        <input
          ref={inputRef}
          data-testid="search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search command history…"
          style={QUERY_INPUT}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
        />
        <div style={CHIP_ROW} data-testid="search-chips">
          <Chip
            testId="search-chip-status"
            label={STATUS_LABELS[status]}
            active={status !== "any"}
            onClick={() => setStatus((cur) => cycle(STATUS_ORDER, cur))}
          />
          <Chip
            testId="search-chip-time"
            label={TIME_LABELS[time]}
            active={time !== "any"}
            onClick={() => setTime((cur) => cycle(TIME_ORDER, cur))}
          />
        </div>
        <div style={STATUS_ROW} data-testid="search-status">
          {showHint && "Type to search across commands and output"}
          {!showHint && loading && "Searching…"}
          {!showHint && !loading && results.length > 0 && (
            <>
              {results.length} {results.length === 1 ? "result" : "results"} ·{" "}
              <span style={{ textTransform: "none" }}>↑↓ navigate · ↵ open</span>
            </>
          )}
          {showEmpty && "No matches"}
        </div>
        <div style={RESULT_LIST} data-testid="search-results" ref={listRef}>
          {results.map((hit, i) => (
            <SearchResultRow
              key={hit.block.id}
              hit={hit}
              index={i}
              selected={i === selected}
              onHover={() => setSelected(i)}
              onSelect={() => onSelect(hit)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface ChipProps {
  testId: string;
  label: string;
  active: boolean;
  onClick: () => void;
}

function Chip({ testId, label, active, onClick }: ChipProps): React.ReactElement {
  const style: CSSProperties = {
    ...CHIP_BASE,
    background: active ? "var(--accent-soft)" : "transparent",
    borderColor: active ? "var(--accent)" : "var(--border)",
    color: active ? "var(--fg)" : "var(--fg-dim)",
  };
  return (
    <span
      data-testid={testId}
      data-active={active ? "true" : "false"}
      style={style}
      onClick={onClick}
    >
      {label}
    </span>
  );
}

interface SearchResultRowProps {
  hit: SearchHit;
  index: number;
  selected: boolean;
  onHover: () => void;
  onSelect: () => void;
}

function SearchResultRow({
  hit,
  index,
  selected,
  onHover,
  onSelect,
}: SearchResultRowProps): React.ReactElement {
  const { block, snippet } = hit;
  const style: CSSProperties = {
    ...RESULT_ROW_BASE,
    background: selected ? "var(--surface-hover)" : "transparent",
    borderLeft: selected ? "2px solid var(--accent)" : "2px solid transparent",
    paddingLeft: 14,
  };
  return (
    <div
      data-testid="search-result"
      data-index={index}
      data-block-id={block.id}
      data-selected={selected ? "true" : "false"}
      style={style}
      onClick={onSelect}
      onMouseEnter={onHover}
    >
      <div style={COMMAND_LINE}>
        <span style={{ color: statusColor(block), marginRight: 8 }}>{statusGlyph(block)}</span>
        {block.command ?? "(no command)"}
      </div>
      {snippet !== null && (
        <div style={SNIPPET_LINE} data-testid="search-result-snippet">
          {renderSnippet(snippet)}
        </div>
      )}
      <div style={META_LINE}>
        {block.cwd ?? "—"}
        {block.git_branch !== null && (
          <>
            <span style={{ padding: "0 6px" }}>·</span>
            <span aria-hidden="true" style={{ marginRight: 4 }}>
              ⎇
            </span>
            {block.git_branch}
          </>
        )}
        {block.duration_ms !== null && (
          <>
            <span style={{ padding: "0 6px" }}>·</span>
            {formatDuration(block.duration_ms)}
          </>
        )}
        {block.interactive && (
          <>
            <span style={{ padding: "0 6px" }}>·</span>
            interactive
          </>
        )}
      </div>
    </div>
  );
}
