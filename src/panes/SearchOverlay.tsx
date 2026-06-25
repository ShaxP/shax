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
import { createPortal } from "react-dom";
import { searchBlocks } from "../lib/ipc";
import type { SearchHit, SearchStatus } from "../lib/ipc";
import { formatDuration, formatTimestamp } from "./blockFormat";

export interface SearchOverlayProps {
  /** Caller closes the overlay (Esc or backdrop click). */
  onClose: () => void;
  /** Caller routes the chosen hit (jump to pane vs. open viewer modal). */
  onSelect: (hit: SearchHit) => void;
}

const DEBOUNCE_MS = 150;
const RESULT_LIMIT = 50;

/** One entry in a filter dropdown's option list. */
interface FilterOption<T extends string> {
  key: T;
  label: string;
  /**
   * Optional accent for the pill while this option is active —
   * matches the block-row status iconography so the user reads the
   * filter state at a glance (green for Ok, red for Fail, …). Omit
   * to fall back to the generic `--accent` (used by the time chip).
   */
  color?: string;
}

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

const TIME_OPTIONS: FilterOption<TimeBucket>[] = TIME_ORDER.map((k) => ({
  key: k,
  label: TIME_LABELS[k],
}));

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

// Per-status accent colours mirror the block-row iconography (see
// `BlockRow.statusEdgeColor`) — green for success, red for failure,
// faint for aborted. `any` stays uncoloured.
const STATUS_OPTIONS: FilterOption<SearchStatus>[] = [
  { key: "any", label: STATUS_LABELS.any },
  { key: "ok", label: STATUS_LABELS.ok, color: "var(--green)" },
  { key: "fail", label: STATUS_LABELS.fail, color: "var(--red)" },
  { key: "aborted", label: STATUS_LABELS.aborted, color: "var(--fg-faint)" },
];

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
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "var(--font-ui)",
  fontSize: 11.5,
  padding: "4px 9px",
  borderRadius: "999px",
  cursor: "pointer",
  userSelect: "none",
  border: "1px solid var(--border)",
};

const POPOVER_BASE: CSSProperties = {
  position: "fixed",
  minWidth: 160,
  background: "var(--surface)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm)",
  boxShadow: "0 10px 28px rgba(0, 0, 0, 0.4)",
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  // Higher than the search backdrop (1000) so the popover always
  // floats above it, but the popover is portalled to the document body
  // so it isn't clipped by the search panel's `overflow: hidden`.
  zIndex: 1100,
};

const POPOVER_ITEM_BASE: CSSProperties = {
  padding: "5px 10px",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  borderRadius: 3,
  cursor: "pointer",
  color: "var(--fg)",
  whiteSpace: "nowrap",
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
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--fg)",
  minWidth: 0,
};

const COMMAND_TEXT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const TIMESTAMP: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
  flexShrink: 0,
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
  // deps so toggling a chip refreshes the results. An empty query
  // plus an active filter falls through to the backend's filter-only
  // browse path — "show me every failure today" is a valid search
  // without a text query.
  useEffect(() => {
    const trimmed = query.trim();
    const hasFilter = status !== "any" || time !== "any";
    if (trimmed === "" && !hasFilter) {
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
  const hasFilter = status !== "any" || time !== "any";
  // Empty state changes depending on whether a filter is active. With
  // no query and no filter the overlay invites the user to type;
  // with no query but an active filter we're in browse-by-filter mode
  // and the empty-results case should read like "nothing matches your
  // filter" instead.
  const isActive = trimmed !== "" || hasFilter;
  const showEmpty = isActive && !loading && results.length === 0;
  const showHint = !isActive;

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
          <FilterDropdown
            testId="search-chip-status"
            options={STATUS_OPTIONS}
            neutralKey="any"
            value={status}
            onChange={setStatus}
          />
          <FilterDropdown
            testId="search-chip-time"
            options={TIME_OPTIONS}
            neutralKey="any"
            value={time}
            onChange={setTime}
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

interface FilterDropdownProps<T extends string> {
  testId: string;
  options: FilterOption<T>[];
  /** The "neutral" / no-filter key — value === neutralKey renders inactive. */
  neutralKey: T;
  value: T;
  onChange: (key: T) => void;
}

/**
 * Pill that, when clicked, opens a popover with the full option list.
 * Selecting an option closes the popover and applies the filter; the
 * pill stays in the same visual language as the slice-3.2 cycle chip
 * (rounded, accent-tinted when active) but adds a small `⌄` caret to
 * signal that there's a menu behind it.
 *
 * Open-state lifecycle:
 * - Clicking the pill toggles it.
 * - Clicking an option closes it (the change is committed).
 * - Clicking anywhere outside the pill+popover closes it.
 * - Pressing `Escape` while open closes only the dropdown — the
 *   handler is registered in the *capture* phase so it preempts
 *   `SearchOverlay`'s bubble-phase Esc handler (which would otherwise
 *   close the entire overlay).
 */
function FilterDropdown<T extends string>({
  testId,
  options,
  neutralKey,
  value,
  onChange,
}: FilterDropdownProps<T>): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.key === value) ?? options[0];
  const active = value !== neutralKey;

  // Anchor the popover to the pill's bottom-left in viewport coords.
  // Recomputed on open and on scroll / resize so a parent scroll
  // doesn't leave the popover floating in the wrong place.
  useLayoutEffect(() => {
    if (!open || pillRef.current === null) return;
    const place = (): void => {
      const rect = pillRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      setPos({ top: rect.bottom + 4, left: rect.left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Close on outside click. The popover lives in a portal so the
  // outside-check has to consider both the pill *and* the popover.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (pillRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  // Esc closes the dropdown — registered in capture so it fires
  // *before* the overlay-level Esc handler and can `stopImmediate-
  // Propagation` to prevent that one from also seeing the event and
  // closing the whole overlay underneath.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [open]);

  // When active, take the option's per-status colour if any; otherwise
  // fall back to the generic accent (used by chips with no per-value
  // colouring, e.g. the time chip). The soft background is derived
  // via `color-mix` so we don't need a `--green-soft` token per hue.
  const activeColor = current?.color ?? "var(--accent)";
  const activeBg = `color-mix(in srgb, ${activeColor} 14%, transparent)`;
  const pillStyle: CSSProperties = {
    ...CHIP_BASE,
    background: active ? activeBg : "transparent",
    borderColor: active ? activeColor : "var(--border)",
    color: active ? "var(--fg)" : "var(--fg-dim)",
  };

  const popover =
    open && pos !== null ? (
      <div
        ref={popoverRef}
        data-testid={`${testId}-popover`}
        style={{ ...POPOVER_BASE, top: pos.top, left: pos.left }}
      >
        {options.map((opt) => {
          const selected = opt.key === value;
          const itemStyle: CSSProperties = {
            ...POPOVER_ITEM_BASE,
            background: selected ? "var(--accent-soft)" : "transparent",
            fontWeight: selected ? 600 : 400,
          };
          return (
            <div
              key={opt.key}
              data-testid={`${testId}-option-${opt.key}`}
              data-selected={selected ? "true" : "false"}
              style={itemStyle}
              onMouseEnter={(e) => {
                if (!selected) e.currentTarget.style.background = "var(--surface-hover)";
              }}
              onMouseLeave={(e) => {
                if (!selected) e.currentTarget.style.background = "transparent";
              }}
              onClick={() => {
                onChange(opt.key);
                setOpen(false);
              }}
            >
              {opt.label}
            </div>
          );
        })}
      </div>
    ) : null;

  return (
    <>
      <span
        ref={pillRef}
        data-testid={testId}
        data-active={active ? "true" : "false"}
        data-open={open ? "true" : "false"}
        style={pillStyle}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.label ?? ""}
        <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.7 }}>
          ⌄
        </span>
      </span>
      {popover !== null && createPortal(popover, document.body)}
    </>
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
        <span style={{ color: statusColor(block), flexShrink: 0 }}>{statusGlyph(block)}</span>
        <span style={COMMAND_TEXT}>{block.command ?? "(no command)"}</span>
        <span
          style={TIMESTAMP}
          title={new Date(block.started_at_ms).toLocaleString()}
          data-testid="search-result-time"
        >
          {formatTimestamp(block.started_at_ms)}
        </span>
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
