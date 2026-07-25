/**
 * `git checkout` palette command (M8.3 spec §14).
 *
 * Branch picker driven by the `git_branches` IPC — machine-
 * readable `for-each-ref` output, never scraped from
 * `git branch -a`. Local heads first, then remote-tracking.
 * The current branch is shown but disabled (selecting it would
 * be a no-op).
 *
 * Behaviour:
 *   - Type to filter on branch name.
 *   - ↑ / ↓ or j / k move the selection.
 *   - Enter emits the checkout command:
 *     - Local branch → `git checkout <name>`.
 *     - Remote-tracking branch (e.g. `origin/feat/foo`) →
 *       `git checkout -b feat/foo origin/feat/foo`. That's the
 *       common "new local branch from remote" pattern the spec
 *       calls out explicitly.
 *   - Esc backs out to the palette list.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { gitBranches, type GitBranch } from "../../../lib/ipc";
import { shellEscape } from "../../../lib/shellEscape";
import type { PaneContext } from "../../registry";

export interface GitCheckoutPanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

const PANEL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minHeight: 320,
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

const GROUP_HEADER: CSSProperties = {
  padding: "6px 10px 2px",
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--fg-faint)",
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

const ROW_DISABLED: CSSProperties = {
  color: "var(--fg-faint)",
  cursor: "default",
};

const CURRENT_MARK: CSSProperties = {
  color: "var(--accent)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
};

const ERROR: CSSProperties = {
  padding: 10,
  color: "var(--red)",
};

const FOOTER: CSSProperties = {
  paddingTop: 4,
  fontSize: 11,
  color: "var(--fg-dim)",
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

/** Turn a `refs/remotes/*` short name into the pair the shell
 *  needs for a "new local from remote" checkout. Given
 *  `origin/feat/foo` returns `feat/foo` (the local name). */
function localNameForRemote(remote: string): string {
  const slash = remote.indexOf("/");
  return slash < 0 ? remote : remote.slice(slash + 1);
}

export function buildCheckoutCommand(branch: GitBranch): string {
  if (branch.kind === "local") {
    return `git checkout ${shellEscape(branch.name)}`;
  }
  const local = localNameForRemote(branch.name);
  return `git checkout -b ${shellEscape(local)} ${shellEscape(branch.name)}`;
}

interface Group {
  kind: "local" | "remote";
  title: string;
  branches: GitBranch[];
}

export function GitCheckoutPanel({ ctx, onSubmit }: GitCheckoutPanelProps): React.ReactElement {
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ctx.cwd === null) {
      setError("No cwd for the active pane.");
      return;
    }
    let cancelled = false;
    setBranches(null);
    setError(null);
    gitBranches(ctx.cwd)
      .then((results) => {
        if (cancelled) return;
        setBranches(results);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.cwd]);

  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  const filtered: GitBranch[] = useMemo(() => {
    if (branches === null) return [];
    const q = filter.trim().toLowerCase();
    return branches.filter((b) => q.length === 0 || b.name.toLowerCase().includes(q));
  }, [branches, filter]);

  const groups: Group[] = useMemo(() => {
    const local = filtered.filter((b) => b.kind === "local");
    const remote = filtered.filter((b) => b.kind === "remote");
    const g: Group[] = [];
    if (local.length > 0) g.push({ kind: "local", title: "Local branches", branches: local });
    if (remote.length > 0)
      g.push({ kind: "remote", title: "Remote-tracking branches", branches: remote });
    return g;
  }, [filtered]);

  // Flat indexable list of selectable rows (skips the current
  // branch since selecting it is a no-op).
  const selectable: GitBranch[] = useMemo(() => filtered.filter((b) => !b.is_current), [filtered]);

  useEffect(() => {
    if (selectedIndex >= selectable.length) {
      setSelectedIndex(Math.max(0, selectable.length - 1));
    }
  }, [selectable.length, selectedIndex]);

  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const row = list.querySelector<HTMLElement>('[data-selected="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const submit = useCallback((): void => {
    const branch = selectable[selectedIndex];
    if (branch === undefined) return;
    onSubmit(buildCheckoutCommand(branch));
  }, [selectable, selectedIndex, onSubmit]);

  // Refs so the window keydown listener below always reads the
  // latest closure state without needing to re-register on every
  // render. The `[]` dep on that effect avoids a churn of
  // listener registrations while branches load / filter changes.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const selectableCountRef = useRef(selectable.length);
  selectableCountRef.current = selectable.length;

  // Backup navigation: bind arrow / Enter at the window layer
  // while the panel is mounted. Redundant with the filter-input's
  // onKeyDown handler in the common case, but a safety net if
  // focus is somewhere else in the DOM (a browser caret-hop, an
  // event capture race, the palette's own input reclaiming focus).
  // Skipped when a non-panel text input owns focus so we don't
  // hijack an unrelated caret.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== filterRef.current) {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable) return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        submitRef.current();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(selectableCountRef.current - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      submit();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "j" && !hasWordMod(e) && filter.length === 0)) {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(selectable.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "k" && !hasWordMod(e) && filter.length === 0)) {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
  };

  // Compute the flat index of a given branch among `selectable`
  // rows so the row's `data-selected` reflects the keyboard cursor.
  function selectableIndexOf(b: GitBranch): number {
    return selectable.indexOf(b);
  }

  return (
    <div style={PANEL} data-testid="palette-git-checkout-panel">
      <input
        ref={filterRef}
        style={FILTER_INPUT}
        data-testid="palette-git-checkout-filter"
        placeholder="Filter branches"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setSelectedIndex(0);
        }}
        onKeyDown={handleKey}
      />

      {error !== null && <div style={ERROR}>{error}</div>}
      {branches === null && error === null && (
        <div style={{ padding: 10, color: "var(--fg-dim)", fontSize: 12 }}>Reading…</div>
      )}

      {branches !== null && (
        <div style={LIST} ref={listRef} data-testid="palette-git-checkout-list">
          {filtered.length === 0 && (
            <div style={{ padding: 10, color: "var(--fg-faint)", fontSize: 12 }}>
              {filter.length > 0 ? "No matching branches." : "(no branches)"}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.kind}>
              <div style={GROUP_HEADER}>{group.title}</div>
              {group.branches.map((b) => {
                const flatIdx = selectableIndexOf(b);
                const isSelected = flatIdx === selectedIndex && flatIdx >= 0;
                const rowStyle = b.is_current
                  ? { ...ROW_BASE, ...ROW_DISABLED }
                  : isSelected
                    ? ROW_SELECTED
                    : ROW_BASE;
                return (
                  <div
                    key={`${group.kind}:${b.name}`}
                    data-testid="palette-git-checkout-row"
                    data-name={b.name}
                    data-kind={group.kind}
                    data-current={b.is_current ? "true" : "false"}
                    data-selected={isSelected ? "true" : "false"}
                    style={rowStyle}
                    onMouseEnter={() => {
                      if (!b.is_current) setSelectedIndex(flatIdx);
                    }}
                    onClick={() => {
                      if (b.is_current) return;
                      setSelectedIndex(flatIdx);
                      onSubmit(buildCheckoutCommand(b));
                    }}
                  >
                    {b.is_current ? (
                      <span aria-hidden="true" style={CURRENT_MARK}>
                        ★
                      </span>
                    ) : (
                      <span
                        aria-hidden="true"
                        style={{ ...CURRENT_MARK, color: "var(--fg-faint)" }}
                      >
                        ·
                      </span>
                    )}
                    <span>{b.name}</span>
                    {b.is_current && (
                      <span style={{ color: "var(--fg-faint)", marginLeft: 4 }}>(current)</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div style={FOOTER}>
        <kbd style={KBD}>⏎</kbd>checkout
        <kbd style={KBD}>↑↓</kbd>pick
        <kbd style={KBD}>esc</kbd>cancel
      </div>
    </div>
  );
}

function hasWordMod(e: React.KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}
