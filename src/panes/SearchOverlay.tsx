/**
 * Block-search overlay (M3 slice 3.1).
 *
 * Centred modal anchored over the pane area. Single text input drives an
 * FTS5 query against the backend store; results are compact block rows.
 * Clicking a result hands the block off to the caller (App opens the
 * read-only `BlockViewerModal` over it).
 *
 * Slice 3.2 adds filter chips (exit code, cwd, branch, time range),
 * matched-snippet highlighting, and keyboard nav inside the result list.
 * Keep the component shape — `onSelect`, `onClose`, `query` — stable so
 * those additions are local.
 */

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { searchBlocks } from "../lib/ipc";
import type { BlockSummary } from "../lib/ipc";
import { formatDuration } from "./blockFormat";

export interface SearchOverlayProps {
  /** Caller closes the overlay (Esc or backdrop click). */
  onClose: () => void;
  /** Caller opens the chosen block in a viewer modal. */
  onSelect: (block: BlockSummary) => void;
}

const DEBOUNCE_MS = 150;
const RESULT_LIMIT = 50;

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
  borderBottom: "1px solid var(--border)",
  outline: "none",
  padding: "14px 16px",
  fontFamily: "var(--font-mono)",
  fontSize: 14,
};

const STATUS_ROW: CSSProperties = {
  padding: "10px 16px",
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

function statusGlyph(b: BlockSummary): string {
  if (b.aborted) return "·";
  if (b.exit_code === null) return "…";
  return b.exit_code === 0 ? "✓" : "✗";
}

function statusColor(b: BlockSummary): string {
  if (b.aborted) return "var(--fg-faint)";
  if (b.exit_code === null) return "var(--accent)";
  return b.exit_code === 0 ? "var(--green)" : "var(--red)";
}

export function SearchOverlay({ onClose, onSelect }: SearchOverlayProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BlockSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the input on mount so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc closes; let other shortcuts (⌘W etc.) pass through.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Debounce the query so the user gets snappy keystrokes without the
  // SQLite mutex thrashing on every letter.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = setTimeout(() => {
      void searchBlocks(trimmed, RESULT_LIMIT, 0).then((hits) => {
        // Guard against a stale resolution after the user keeps typing —
        // the query state will have moved on; only commit if it's still
        // the live query.
        setResults(hits);
        setLoading(false);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // Click on the backdrop (but not inside the panel) closes.
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
          // Search queries are commands, paths, code fragments, error
          // tokens — never natural prose. Suppress the browser's
          // autocorrect / autocapitalize / spell-check / autocomplete
          // chrome that would otherwise overlay the input.
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
        />
        <div style={STATUS_ROW} data-testid="search-status">
          {showHint && "Type to search across commands and output"}
          {!showHint && loading && "Searching…"}
          {!showHint && !loading && results.length > 0 && (
            <>
              {results.length} {results.length === 1 ? "result" : "results"}
            </>
          )}
          {showEmpty && "No matches"}
        </div>
        <div style={RESULT_LIST} data-testid="search-results">
          {results.map((b) => (
            <SearchResultRow key={b.id} block={b} onSelect={() => onSelect(b)} />
          ))}
        </div>
      </div>
    </div>
  );
}

interface SearchResultRowProps {
  block: BlockSummary;
  onSelect: () => void;
}

function SearchResultRow({ block, onSelect }: SearchResultRowProps): React.ReactElement {
  const [hover, setHover] = useState(false);
  const style: CSSProperties = {
    ...RESULT_ROW_BASE,
    background: hover ? "var(--surface-hover)" : "transparent",
  };
  return (
    <div
      data-testid="search-result"
      data-block-id={block.id}
      style={style}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={COMMAND_LINE}>
        <span style={{ color: statusColor(block), marginRight: 8 }}>{statusGlyph(block)}</span>
        {block.command ?? "(no command)"}
      </div>
      <div style={META_LINE}>
        {block.cwd ?? "—"}
        {block.git_branch !== null && (
          <>
            <span style={{ padding: "0 6px" }}>·</span>
            {/* `⎇` matches the PromptStrip and Statusline branch glyph. */}
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
