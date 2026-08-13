/**
 * `git rebase` palette command (M8.4 spec §14).
 *
 * Branch picker (same data source as `git checkout` — the shared
 * `git_branches` IPC) plus an `-i` toggle for interactive
 * rebase. Emits `git rebase [-i] <target>`.
 *
 * Destructive by design — the safety gate at spec §10 catches
 * `git rebase` and adds a stronger confirmation before the
 * command actually runs. The palette's preview + Enter is the
 * first confirmation; the gate is the second.
 *
 * Matches on `ctx.gitRoot !== null`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { gitBranches, type GitBranch } from "../../../lib/ipc";
import { shellEscape } from "../../../lib/shellEscape";
import { CommandSpans } from "../../../panes/CommandSpans";
import type { PaneContext } from "../../registry";
import {
  ERROR_BOX,
  FOOTER,
  KBD,
  PANEL,
  PREVIEW,
  PREVIEW_LABEL,
  SUBMIT_BUTTON_DESTRUCTIVE,
  TEXT_INPUT,
  TOGGLE_LABEL,
} from "./formStyles";

export interface GitRebasePanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

const LIST: CSSProperties = {
  flex: 1,
  maxHeight: 240,
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

export function buildRebaseCommand(target: string, interactive: boolean): string {
  const parts = ["git", "rebase"];
  if (interactive) parts.push("-i");
  parts.push(shellEscape(target));
  return parts.join(" ");
}

export function GitRebasePanel({ ctx, onSubmit }: GitRebasePanelProps): React.ReactElement {
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [interactive, setInteractive] = useState(false);
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

  // Rebase target can be the current branch too — no reason to
  // filter it out (rebase onto self is a no-op, git handles it).
  const selectable = filtered;

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
    onSubmit(buildRebaseCommand(branch.name, interactive));
  }, [selectable, selectedIndex, interactive, onSubmit]);

  // Refs so the window-layer listener can read the freshest
  // callback without re-registering.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const selectableCountRef = useRef(selectable.length);
  selectableCountRef.current = selectable.length;

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      submit();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(selectable.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
  };

  // Same window-layer safety net as GitCheckoutPanel — the
  // palette overlay's own input can briefly hold focus so we
  // catch arrow / Enter regardless.
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

  const selected = selectable[selectedIndex];
  const preview = selected === undefined ? "" : buildRebaseCommand(selected.name, interactive);

  return (
    <div style={PANEL} data-testid="palette-git-rebase-panel">
      <input
        ref={filterRef}
        style={TEXT_INPUT}
        data-testid="palette-git-rebase-filter"
        placeholder="Filter target branches"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setSelectedIndex(0);
        }}
        onKeyDown={handleKey}
      />

      {error !== null && <div style={ERROR_BOX}>{error}</div>}
      {branches === null && error === null && (
        <div style={{ padding: 10, color: "var(--fg-dim)", fontSize: 12 }}>Reading branches…</div>
      )}

      {branches !== null && (
        <div style={LIST} ref={listRef} data-testid="palette-git-rebase-list">
          {selectable.length === 0 && (
            <div style={{ padding: 10, color: "var(--fg-faint)", fontSize: 12 }}>
              {filter.length > 0 ? "No matching branches." : "(no branches)"}
            </div>
          )}
          {selectable.length > 0 &&
            (() => {
              const local = selectable.filter((b) => b.kind === "local");
              const remote = selectable.filter((b) => b.kind === "remote");
              const groups: Array<{ title: string; branches: GitBranch[] }> = [];
              if (local.length > 0) groups.push({ title: "Local branches", branches: local });
              if (remote.length > 0)
                groups.push({ title: "Remote-tracking branches", branches: remote });
              return groups.map((group) => (
                <div key={group.title}>
                  <div style={GROUP_HEADER}>{group.title}</div>
                  {group.branches.map((b) => {
                    const flatIdx = selectable.indexOf(b);
                    const isSelected = flatIdx === selectedIndex;
                    const rowStyle = b.is_current
                      ? {
                          ...ROW_BASE,
                          ...ROW_DISABLED,
                          ...(isSelected ? { background: "var(--surface-hover)" } : {}),
                        }
                      : isSelected
                        ? ROW_SELECTED
                        : ROW_BASE;
                    return (
                      <div
                        key={`${group.title}:${b.name}`}
                        data-testid="palette-git-rebase-row"
                        data-name={b.name}
                        data-selected={isSelected ? "true" : "false"}
                        style={rowStyle}
                        onMouseEnter={() => setSelectedIndex(flatIdx)}
                        onClick={() => {
                          setSelectedIndex(flatIdx);
                          onSubmit(buildRebaseCommand(b.name, interactive));
                        }}
                      >
                        <span>{b.name}</span>
                        {b.is_current && (
                          <span style={{ color: "var(--fg-faint)", marginLeft: 4 }}>(current)</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
        </div>
      )}

      <label style={TOGGLE_LABEL}>
        <input
          type="checkbox"
          data-testid="palette-git-rebase-interactive"
          checked={interactive}
          onChange={(e) => setInteractive(e.target.checked)}
        />
        <span>
          <code>-i</code> — interactive rebase (opens your editor to reorder / squash).
        </span>
      </label>

      {preview.length > 0 && (
        <div style={PREVIEW}>
          <div style={PREVIEW_LABEL}>Preview — destructive; safety gate confirms again</div>
          {/* M12.6b: syntax-highlight the preview so the panel
              matches other command-rendering surfaces. */}
          <div data-testid="palette-git-rebase-preview">
            <CommandSpans text={preview} />
          </div>
        </div>
      )}

      <div style={FOOTER}>
        <span>
          <kbd style={KBD}>⏎</kbd>rebase
          <kbd style={KBD}>↑↓</kbd>pick
          <kbd style={KBD}>esc</kbd>cancel
        </span>
        <button
          type="button"
          data-testid="palette-git-rebase-submit"
          style={{
            ...SUBMIT_BUTTON_DESTRUCTIVE,
            opacity: preview.length > 0 ? 1 : 0.5,
            cursor: preview.length > 0 ? "pointer" : "not-allowed",
          }}
          disabled={preview.length === 0}
          onClick={() => {
            if (preview.length > 0) onSubmit(preview);
          }}
        >
          Rebase
        </button>
      </div>
    </div>
  );
}
