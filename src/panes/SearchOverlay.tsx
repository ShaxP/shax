/**
 * Block-search overlay (M3 slices 3.1 → 3.6).
 *
 * Centred modal over the pane area. A single FTS5-backed query input
 * drives a debounced search; a row of filter chips above it composes
 * status, time, cwd, and branch filters into the same request.
 * Results are compact block rows with a matched-output snippet
 * underneath when the hit landed in the captured output (vs. the
 * command line), plus inline `<mark>` highlight on the command text.
 *
 * Keyboard nav: `↑` / `↓` moves the highlighted result, `Enter`
 * activates it. Activation hands the hit off to the caller via
 * `onSelect`; App jumps to a still-alive pane (select-block event)
 * or "inspects" the hit in the current active pane (inspect-block).
 *
 * Filter chips are dropdown-driven popovers (portalled). Status and
 * time use static option lists; cwd and branch are *faceted* — their
 * dropdowns reflect only the values that exist in the current result
 * set, refreshed alongside the search on every query / filter change.
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  embeddingProgress,
  gitRootFor,
  listBranches,
  listCwds,
  searchBlocks,
  semanticSearch,
} from "../lib/ipc";
import type { EmbeddingProgress, SearchHit, SearchStatus, SemanticHit } from "../lib/ipc";
import { formatDuration, formatTimestamp } from "./blockFormat";

export interface SearchOverlayProps {
  /** Caller closes the overlay (Esc or backdrop click). */
  onClose: () => void;
  /** Caller routes the chosen hit (jump to pane vs. open viewer modal). */
  onSelect: (hit: SearchHit) => void;
  /**
   * Active pane's working directory at the time the overlay opened.
   * Drives the cwd chip's "Here" option. `null` means the pane never
   * reported a cwd, in which case the chip stays "Any" only.
   */
  currentCwd?: string | null;
  /**
   * Active pane's git branch at the time the overlay opened. Same
   * semantics as `currentCwd` for the branch chip.
   */
  currentBranch?: string | null;
}

const DEBOUNCE_MS = 150;
const RESULT_LIMIT = 50;
const SEMANTIC_LIMIT = 8;
const PROGRESS_POLL_MS = 2000;

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
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const PROGRESS_PILL: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  color: "var(--fg-dim)",
  textTransform: "none",
  letterSpacing: 0,
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "1px 8px",
  whiteSpace: "nowrap",
};

const SECTION_HEADER: CSSProperties = {
  padding: "6px 16px 4px 16px",
  fontFamily: "var(--font-ui)",
  fontSize: 10.5,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "var(--fg-faint)",
  background: "var(--pane2)",
  borderBottom: "1px solid var(--border)",
};

const SEMANTIC_EMPTY: CSSProperties = {
  padding: "10px 16px",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  color: "var(--fg-dim)",
  fontStyle: "italic",
  borderBottom: "1px solid var(--border)",
};

const SIMILARITY_BADGE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--fg-dim)",
  border: "1px solid var(--border-strong)",
  borderRadius: 3,
  padding: "1px 5px",
  flexShrink: 0,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  lineHeight: 1.4,
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

/**
 * Last path segment of a POSIX-ish path. Used to compress the cwd chip's
 * "Here · …" label so a deep nesting doesn't blow out the chip width.
 * Trailing slashes are tolerated. Pure UI helper; the actual filter
 * passed to the backend is the full path.
 */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || "/";
}

/**
 * Resolve the cwd chip's current state into the pair of `SearchOptions`
 * fields the backend understands:
 *
 *   - `"any"`           → no filter.
 *   - `"here"`          → exact match on the active pane's cwd.
 *   - `"repo"`          → prefix match on the resolved git worktree
 *                          root (so any descendant directory matches).
 *   - `<literal path>`  → exact match on that path (faceted history).
 *
 * Picks degrade to "no filter" when the underlying value is missing
 * (e.g. `"here"` but the pane never reported a cwd).
 */
function resolveCwdFilter(
  cwd: string,
  currentCwd: string | null,
  repoRoot: string | null,
  glob: string,
): { cwd?: string; cwd_prefix?: string; cwd_glob?: string } {
  if (cwd === "any") return {};
  if (cwd === "here") {
    return currentCwd !== null && currentCwd.length > 0 ? { cwd: currentCwd } : {};
  }
  if (cwd === "repo") {
    return repoRoot !== null && repoRoot.length > 0 ? { cwd_prefix: repoRoot } : {};
  }
  if (cwd === "glob") {
    return glob.length > 0 ? { cwd_glob: glob } : {};
  }
  return { cwd };
}

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
 * Highlight every occurrence of every query token inside the command
 * string. We don't get a backend snippet for the command line — the
 * FTS5 `snippet()` call targets the output column — so the frontend
 * does its own pass. Tokens are split on whitespace; trailing `*`
 * (FTS prefix wildcard) and surrounding quotes are stripped so the
 * highlight matches what the index matched. Case-insensitive, with
 * overlapping ranges merged so we never emit nested `<mark>`s. Empty
 * query short-circuits to the raw string.
 */
function highlightCommand(command: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (trimmed.length === 0) return command;
  const tokens = trimmed
    .replace(/"([^"]+)"/g, "$1")
    .split(/\s+/)
    .map((t) => t.replace(/\*+$/, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return command;
  const lower = command.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const tok of tokens) {
    const needle = tok.toLowerCase();
    if (needle.length === 0) continue;
    let from = 0;
    // Scan all matches for this token; bail if `indexOf` returns -1.
    while (true) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      ranges.push([idx, idx + needle.length]);
      from = idx + needle.length;
    }
  }
  if (ranges.length === 0) return command;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([s, e], i) => {
    if (s > cursor) parts.push(command.slice(cursor, s));
    parts.push(
      <mark key={i} style={MARK_STYLE}>
        {command.slice(s, e)}
      </mark>,
    );
    cursor = e;
  });
  if (cursor < command.length) parts.push(command.slice(cursor));
  return parts;
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

export function SearchOverlay({
  onClose,
  onSelect,
  currentCwd = null,
  currentBranch = null,
}: SearchOverlayProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("any");
  const [time, setTime] = useState<TimeBucket>("any");
  // `cwd` chip: widened in slice 3.4 to four shapes —
  //   "any"            → no filter
  //   "here"           → exact match on `currentCwd`
  //   "repo"           → prefix match on the active pane's git
  //                       worktree root (resolved via `gitRootFor`)
  //   "glob"           → shell-glob match against `cwdGlobInput`
  //                       (slice 3.6 free-form path/glob input)
  //   <literal path>   → exact match on a previously-used cwd from
  //                       the faceted history dropdown
  // Storing the *key* (not the resolved value) keeps the pill label
  // readable as "Here · <basename>" or "Repo · <basename>" without
  // pinning us to a specific string at render time.
  const [cwd, setCwd] = useState<string>("any");
  const [historyCwds, setHistoryCwds] = useState<string[]>([]);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  // Free-form glob the user typed into the cwd dropdown footer. The
  // `cwd` state above is set to "glob" when this commits via Enter,
  // and reset to "any" if the user picks any other option.
  const [cwdGlobInput, setCwdGlobInput] = useState<string>("");
  // `branch` chip: "any" or the literal branch name. The dropdown
  // is populated from history (every branch the user has worked
  // on), not just the active pane's current branch, so the user can
  // filter for activity on branches they aren't currently on.
  const [branch, setBranch] = useState<string>("any");
  const [historyBranches, setHistoryBranches] = useState<string[]>([]);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  // Slice 3: parallel semantic tier. `null` model means we
  // haven't heard back from `embeddingProgress` yet; the
  // section renders a placeholder-free skeleton while we
  // wait rather than committing to a "unavailable" state.
  const [semanticResults, setSemanticResults] = useState<SemanticHit[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [progress, setProgress] = useState<EmbeddingProgress | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Autofocus the input on mount so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Faceted branch list: re-fetch whenever the query / non-branch
  // filters change so the dropdown reflects "branches that exist in
  // the current result set", not "every branch you've ever used".
  // Picking a branch deliberately doesn't refetch — the facet must
  // not collapse to the picked option (that's the standard rule, and
  // the backend mirrors it by ignoring `opts.git_branch`). Same
  // debounce as `searchBlocks` so the two requests fire together.
  useEffect(() => {
    let cancelled = false;
    const trimmed = query.trim();
    const handle = setTimeout(() => {
      const since = bucketToSinceMs(time, Date.now());
      const cwdFilter = resolveCwdFilter(cwd, currentCwd, repoRoot, cwdGlobInput);
      void listBranches({
        query: trimmed,
        limit: RESULT_LIMIT,
        offset: 0,
        status,
        since_ms: since,
        ...cwdFilter,
      }).then((list) => {
        if (!cancelled) setHistoryBranches(list);
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, status, time, cwd, currentCwd, repoRoot, cwdGlobInput]);

  // Faceted cwd list: same shape as the branch facet, narrowed to
  // directories that exist in the current result set. Ignores
  // `opts.cwd` / `opts.cwd_prefix` themselves so picking a directory
  // doesn't collapse the dropdown.
  useEffect(() => {
    let cancelled = false;
    const trimmed = query.trim();
    const handle = setTimeout(() => {
      const since = bucketToSinceMs(time, Date.now());
      void listCwds({
        query: trimmed,
        limit: RESULT_LIMIT,
        offset: 0,
        status,
        since_ms: since,
        git_branch: branch === "any" ? undefined : branch,
      }).then((list) => {
        if (!cancelled) setHistoryCwds(list);
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, status, time, branch]);

  // Resolve the repo root for the active pane once, when the overlay
  // opens or `currentCwd` changes. Cheap fs walk on the backend; we
  // cache the result so the "Repo · …" chip option is available
  // synchronously while the popover is open.
  useEffect(() => {
    if (currentCwd === null || currentCwd.length === 0) {
      setRepoRoot(null);
      return;
    }
    let cancelled = false;
    void gitRootFor(currentCwd).then((root) => {
      if (!cancelled) setRepoRoot(root);
    });
    return () => {
      cancelled = true;
    };
  }, [currentCwd]);

  // cwd dropdown (slice 3.4):
  //   - Any directory
  //   - Here · <basename of currentCwd>           (when a cwd exists)
  //   - Repo · <basename of repo root>            (when in a git worktree
  //                                                and the root differs
  //                                                from `currentCwd`)
  //   - …faceted history entries                  (most-recent first,
  //                                                capped server-side at 30)
  //
  // We dedupe so the same directory doesn't show twice when, e.g., the
  // "Here" cwd is also in the history list. The currently-picked value
  // is preserved even if it's no longer in the facets — same rationale
  // as the branch dropdown: an active filter must remain visible so
  // the user can clear it.
  const cwdSeen = new Set<string>();
  const cwdOptions: FilterOption<string>[] = [{ key: "any", label: "Any directory" }];
  if (currentCwd !== null && currentCwd.length > 0) {
    cwdOptions.push({
      key: "here",
      label: `Here · ${basename(currentCwd)}`,
      color: "var(--cyan)",
    });
    cwdSeen.add(currentCwd);
  }
  if (
    repoRoot !== null &&
    repoRoot.length > 0 &&
    repoRoot !== currentCwd &&
    !cwdSeen.has(repoRoot)
  ) {
    cwdOptions.push({
      key: "repo",
      label: `Repo · ${basename(repoRoot)}`,
      color: "var(--cyan)",
    });
    cwdSeen.add(repoRoot);
  }
  for (const path of historyCwds) {
    if (!cwdSeen.has(path)) {
      cwdOptions.push({ key: path, label: path, color: "var(--cyan)" });
      cwdSeen.add(path);
    }
  }
  // When a free-form glob is the active filter, show it as a
  // top-of-list entry labelled `Path · <glob>`. Lets the user see
  // (and clear) the active pattern from the same popover the
  // history entries live in.
  if (cwd === "glob" && cwdGlobInput.length > 0) {
    cwdOptions.splice(1, 0, {
      key: "glob",
      label: `Path · ${cwdGlobInput}`,
      color: "var(--cyan)",
    });
  }
  // Keep the currently-picked literal path in the list even if the
  // facets dropped it (e.g. the user typed a query with zero hits on
  // that directory). `any`/`here`/`repo`/`glob` are already handled
  // above.
  if (cwd !== "any" && cwd !== "here" && cwd !== "repo" && cwd !== "glob" && !cwdSeen.has(cwd)) {
    cwdOptions.splice(1, 0, { key: cwd, label: cwd, color: "var(--cyan)" });
  }
  // Branch dropdown: trust the faceted backend list verbatim. We
  // used to union the active pane's `currentBranch` in front so the
  // most likely pick was one click away, but with facets in play
  // that's a bug — if the current branch has no blocks matching the
  // active query / cwd / status / time, it isn't a valid pick and
  // shouldn't appear. The backend already orders by
  // most-recently-used so the user's current branch usually lands
  // on top organically. `branchSeq` stays separate from
  // `branchOptions` so the chip-visibility guard below can read
  // `.length` directly.
  // Make sure the currently-picked branch stays in the dropdown
  // even if the new facet result no longer contains it (e.g. the
  // user typed a new query that has zero hits on the picked branch).
  // Otherwise the active filter would still be applied but the
  // pill's only visible option would be "Any branch" — the user
  // couldn't see what they had selected.
  const branchSeq: string[] = historyBranches.slice();
  if (branch !== "any" && !branchSeq.includes(branch)) {
    branchSeq.unshift(branch);
  }
  const branchOptions: FilterOption<string>[] = [
    { key: "any", label: "Any branch" },
    ...branchSeq.map((name) => ({
      key: name,
      label: `⎇ ${name}`,
      color: "var(--amber)",
    })),
  ];

  // Debounce the query so the user gets snappy keystrokes without the
  // SQLite mutex thrashing on every letter. Filter changes are also
  // deps so toggling a chip refreshes the results. An empty query
  // plus an active filter falls through to the backend's filter-only
  // browse path — "show me every failure today" is a valid search
  // without a text query.
  useEffect(() => {
    const trimmed = query.trim();
    const cwdFilter = resolveCwdFilter(cwd, currentCwd, repoRoot, cwdGlobInput);
    // Branch state is "any" or the literal branch name from history.
    const resolvedBranch = branch === "any" ? undefined : branch;
    const hasFilter =
      status !== "any" ||
      time !== "any" ||
      cwdFilter.cwd !== undefined ||
      cwdFilter.cwd_prefix !== undefined ||
      cwdFilter.cwd_glob !== undefined ||
      resolvedBranch !== undefined;
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
        ...cwdFilter,
        git_branch: resolvedBranch,
      }).then((hits) => {
        setResults(hits);
        setSelected(0);
        setLoading(false);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, status, time, cwd, branch, currentCwd, currentBranch, repoRoot, cwdGlobInput]);

  // Semantic tier fires in parallel on the same debounce.
  // Filter chips deliberately don't gate this — vector
  // similarity doesn't compose with SQL filters in a way the
  // user would expect, so semantic hits are always
  // whole-corpus for now.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setSemanticResults([]);
      setSemanticLoading(false);
      return;
    }
    setSemanticLoading(true);
    const handle = setTimeout(() => {
      void semanticSearch(trimmed, SEMANTIC_LIMIT).then((hits) => {
        setSemanticResults(hits);
        setSemanticLoading(false);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // Poll `embedding_progress` while the overlay is open.
  // Cheap: one COUNT(*) per model_id, no vector ops. The
  // status pill needs both the fresh number and the
  // `model_id` to distinguish real / mock embedders.
  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      void embeddingProgress().then((p) => {
        if (!cancelled) setProgress(p);
      });
    };
    tick();
    const handle = window.setInterval(tick, PROGRESS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);

  // Combined nav list — literal hits first, then semantic.
  // Selected index walks this flat sequence so ↑ / ↓ crosses
  // the section boundary transparently. Memoised so the
  // keyboard-handler ref effect below doesn't reallocate on
  // every render.
  const combined: CombinedHit[] = useMemo(
    () => [
      ...results.map((hit) => ({ kind: "literal" as const, hit })),
      ...semanticResults.map((hit) => ({ kind: "semantic" as const, hit })),
    ],
    [results, semanticResults],
  );

  // Keyboard handling — scoped to the window while the overlay is up.
  // Refs let the listener observe the latest results/selected without
  // re-registering on every state change (which would otherwise tear down
  // and re-add the listener mid-event between ArrowDown and the render).
  // `useLayoutEffect` (not `useEffect`) so the refs are updated
  // synchronously with the commit — otherwise the keydown handler can
  // fire from a queued event between commit and paint and observe a
  // stale view (e.g. results was rendered but the ref hasn't caught up
  // yet, which surfaces as flaky keyboard nav in the tests).
  const combinedRef = useRef(combined);
  const selectedRef = useRef(selected);
  useLayoutEffect(() => {
    combinedRef.current = combined;
  }, [combined]);
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
      const hits = combinedRef.current;
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
        const entry = hits[selectedRef.current];
        if (entry === undefined) return;
        onSelect(toSearchHit(entry));
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
  const showEmpty = isActive && !loading && !semanticLoading && combined.length === 0;
  const showHint = !isActive;
  const semanticActive = trimmed !== "";
  const semanticAvailable = progress !== null && !progress.model_id.startsWith("mock-");

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
          {cwdOptions.length > 1 && (
            <FilterDropdown
              testId="search-chip-cwd"
              options={cwdOptions}
              neutralKey="any"
              value={cwd}
              onChange={(next) => {
                // Picking a non-glob option clears the typed glob
                // input so it doesn't reappear when the user toggles
                // back through the dropdown later.
                if (next !== "glob") setCwdGlobInput("");
                setCwd(next);
              }}
              renderFooter={(close) => (
                <CwdGlobInput
                  value={cwdGlobInput}
                  onCommit={(v) => {
                    const trimmed = v.trim();
                    if (trimmed.length === 0) {
                      setCwdGlobInput("");
                      setCwd("any");
                    } else {
                      setCwdGlobInput(trimmed);
                      setCwd("glob");
                    }
                    close();
                  }}
                />
              )}
            />
          )}
          {branchSeq.length > 0 && (
            <FilterDropdown
              testId="search-chip-branch"
              options={branchOptions}
              neutralKey="any"
              value={branch}
              onChange={setBranch}
            />
          )}
        </div>
        <div style={STATUS_ROW} data-testid="search-status">
          <span>
            {showHint && "Type to search across commands and output"}
            {!showHint && loading && "Searching…"}
            {!showHint && !loading && combined.length > 0 && (
              <>
                {combined.length} {combined.length === 1 ? "result" : "results"} ·{" "}
                <span style={{ textTransform: "none" }}>↑↓ navigate · ↵ open</span>
              </>
            )}
            {showEmpty && "No matches"}
          </span>
          {progress !== null && progress.total > 0 && (
            <span data-testid="search-embedding-progress" style={PROGRESS_PILL}>
              {progress.indexed}/{progress.total} indexed
            </span>
          )}
        </div>
        <div style={RESULT_LIST} data-testid="search-results" ref={listRef}>
          {results.length > 0 && (
            <SectionHeader testId="search-section-literal" label={`Literal · ${results.length}`} />
          )}
          {results.map((hit, i) => (
            <SearchResultRow
              key={`literal-${hit.block.id}`}
              hit={hit}
              index={i}
              selected={i === selected}
              query={query}
              onHover={() => setSelected(i)}
              onSelect={() => onSelect(hit)}
            />
          ))}
          {semanticActive && (semanticAvailable || progress === null) && (
            <>
              <SectionHeader
                testId="search-section-semantic"
                label={
                  semanticLoading ? "Semantic · searching…" : `Semantic · ${semanticResults.length}`
                }
              />
              {semanticResults.map((hit, i) => {
                const combinedIdx = results.length + i;
                return (
                  <SemanticResultRow
                    key={`semantic-${hit.block.id}`}
                    hit={hit}
                    index={combinedIdx}
                    selected={combinedIdx === selected}
                    query={query}
                    onHover={() => setSelected(combinedIdx)}
                    onSelect={() =>
                      onSelect({ block: hit.block, pane_id: hit.pane_id, snippet: null })
                    }
                  />
                );
              })}
              {!semanticLoading && semanticResults.length === 0 && (
                <div data-testid="search-semantic-empty" style={SEMANTIC_EMPTY}>
                  No semantically-related history yet.
                </div>
              )}
            </>
          )}
          {semanticActive && progress !== null && !semanticAvailable && (
            <>
              <SectionHeader testId="search-section-semantic" label="Semantic" />
              <div data-testid="search-semantic-unavailable" style={SEMANTIC_EMPTY}>
                Semantic search unavailable — model not loaded.
              </div>
            </>
          )}
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
  /**
   * Optional content rendered at the bottom of the popover, after the
   * regular option list. The cwd chip uses this for its free-form
   * "Path: …" input. Receives a callback to close the popover when
   * the footer commits a value.
   */
  renderFooter?: (close: () => void) => React.ReactNode;
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
  renderFooter,
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
        {renderFooter !== undefined && (
          <div
            data-testid={`${testId}-popover-footer`}
            style={{
              borderTop: "1px solid var(--border)",
              marginTop: 4,
              paddingTop: 4,
            }}
            onClick={(e) => {
              // Don't bubble to the popover root's outside-click
              // logic; the footer is intentionally interactive.
              e.stopPropagation();
            }}
          >
            {renderFooter(() => setOpen(false))}
          </div>
        )}
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

/**
 * Inline glob input rendered at the bottom of the cwd dropdown
 * popover. Commits on Enter (passes the trimmed value up via
 * `onCommit`, which also closes the popover). Esc clears focus
 * but does *not* close the popover or commit — that's `FilterDropdown`'s
 * own Esc handler at the window-capture layer.
 */
interface CwdGlobInputProps {
  value: string;
  onCommit: (value: string) => void;
}

function CwdGlobInput({ value, onCommit }: CwdGlobInputProps): React.ReactElement {
  const [draft, setDraft] = useState(value);
  // Keep the local draft in sync if an external pick (Any / Here / …)
  // resets the parent glob to empty.
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <div style={{ padding: "4px 6px 2px 6px" }}>
      <input
        data-testid="search-chip-cwd-glob-input"
        type="text"
        value={draft}
        placeholder="Path or glob, e.g. ~/dev/*-server"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(draft);
          }
        }}
        style={{
          width: "100%",
          background: "var(--pane)",
          color: "var(--fg)",
          border: "1px solid var(--border-strong)",
          borderRadius: 3,
          padding: "3px 6px",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          outline: "none",
        }}
      />
    </div>
  );
}

interface SearchResultRowProps {
  hit: SearchHit;
  index: number;
  selected: boolean;
  /** Current query text, used to highlight matches in the command line. */
  query: string;
  onHover: () => void;
  onSelect: () => void;
}

function SearchResultRow({
  hit,
  index,
  selected,
  query,
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
      data-fuzzy={hit.fuzzy === true ? "true" : "false"}
      style={style}
      onClick={onSelect}
      onMouseEnter={onHover}
    >
      <div style={COMMAND_LINE}>
        <span style={{ color: statusColor(block), flexShrink: 0 }}>{statusGlyph(block)}</span>
        <span style={COMMAND_TEXT}>
          {block.command !== null ? highlightCommand(block.command, query) : "(no command)"}
        </span>
        {hit.fuzzy === true && (
          <span
            data-testid="search-result-fuzzy-badge"
            title="Fuzzy match — the query appears as a substring, not a whole word."
            style={{
              fontFamily: "var(--font-ui)",
              fontSize: 10,
              color: "var(--fg-dim)",
              border: "1px solid var(--border-strong)",
              borderRadius: 3,
              padding: "1px 5px",
              flexShrink: 0,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              lineHeight: 1.4,
            }}
          >
            fuzzy
          </span>
        )}
        <span
          style={{ ...TIMESTAMP, display: "inline-flex", alignItems: "center", gap: 4 }}
          title={new Date(block.started_at_ms).toLocaleString()}
          data-testid="search-result-time"
        >
          <span aria-hidden="true">{""}</span>
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
            <span aria-hidden="true" style={{ marginRight: 4 }}>
              {"\uF017"}
            </span>
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

/**
 * Combined nav element — the flat sequence of literal-then-semantic
 * hits that keyboard nav walks through. Discriminated on `kind` so
 * `toSearchHit` below can shape either variant into the caller's
 * `SearchHit`-typed `onSelect` handler.
 */
type CombinedHit = { kind: "literal"; hit: SearchHit } | { kind: "semantic"; hit: SemanticHit };

/**
 * Adapt a combined entry to the `SearchHit` shape the parent expects.
 * Semantic hits synthesise a `SearchHit` with `snippet: null` — the
 * caller only reads `block` / `pane_id`, so the missing FTS-specific
 * fields don't matter downstream.
 */
function toSearchHit(entry: CombinedHit): SearchHit {
  if (entry.kind === "literal") return entry.hit;
  return { block: entry.hit.block, pane_id: entry.hit.pane_id, snippet: null };
}

interface SectionHeaderProps {
  testId: string;
  label: string;
}

function SectionHeader({ testId, label }: SectionHeaderProps): React.ReactElement {
  return (
    <div data-testid={testId} style={SECTION_HEADER}>
      {label}
    </div>
  );
}

interface SemanticResultRowProps {
  hit: SemanticHit;
  index: number;
  selected: boolean;
  /** Passed through only for command-text highlighting parity with the literal tier. */
  query: string;
  onHover: () => void;
  onSelect: () => void;
}

/**
 * One semantic-tier row. Same visual language as `SearchResultRow` so
 * the eye reads them as members of the same list, but the fuzzy badge
 * is swapped for a similarity readout (e.g. `~0.62`) and there's no
 * output snippet — semantic hits don't carry one, and inventing an FTS
 * `<mark>` snippet against a cosine ranking would be dishonest.
 */
function SemanticResultRow({
  hit,
  index,
  selected,
  query,
  onHover,
  onSelect,
}: SemanticResultRowProps): React.ReactElement {
  const { block, similarity } = hit;
  const style: CSSProperties = {
    ...RESULT_ROW_BASE,
    background: selected ? "var(--surface-hover)" : "transparent",
    borderLeft: selected ? "2px solid var(--accent)" : "2px solid transparent",
    paddingLeft: 14,
  };
  return (
    <div
      data-testid="search-result-semantic"
      data-index={index}
      data-block-id={block.id}
      data-selected={selected ? "true" : "false"}
      data-similarity={similarity.toFixed(3)}
      style={style}
      onClick={onSelect}
      onMouseEnter={onHover}
    >
      <div style={COMMAND_LINE}>
        <span style={{ color: statusColor(block), flexShrink: 0 }}>{statusGlyph(block)}</span>
        <span style={COMMAND_TEXT}>
          {block.command !== null ? highlightCommand(block.command, query) : "(no command)"}
        </span>
        <span
          data-testid="search-result-similarity"
          title={`Cosine similarity: ${similarity.toFixed(3)}`}
          style={SIMILARITY_BADGE}
        >
          ~{similarity.toFixed(2)}
        </span>
        <span
          style={{ ...TIMESTAMP, display: "inline-flex", alignItems: "center", gap: 4 }}
          title={new Date(block.started_at_ms).toLocaleString()}
        >
          {formatTimestamp(block.started_at_ms)}
        </span>
      </div>
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
            <span aria-hidden="true" style={{ marginRight: 4 }}>
              {""}
            </span>
            {formatDuration(block.duration_ms)}
          </>
        )}
      </div>
    </div>
  );
}
