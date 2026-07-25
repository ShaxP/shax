/**
 * The `Cmd+Shift+P` command palette overlay (M8.1 framework).
 *
 * Chrome only — commands come from the registry. Layout:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ > filter query                              │  ← input
 *   ├─────────────────────────────────────────────┤
 *   │ Navigation                                  │  ← group header
 *   │   cd to directory                           │
 *   │   ↳ Browse the filesystem and switch…       │
 *   │ Git                                         │
 *   │   git status                                │
 *   │   git checkout                              │
 *   │ Debug                                       │
 *   │   Echo hello   ← selected                   │
 *   ├─────────────────────────────────────────────┤
 *   │ ⏎ echo hello from shax palette              │  ← preview
 *   └─────────────────────────────────────────────┘
 *
 * State machine:
 *
 *   list  ──Enter (preview kind)──►  preview  ──Enter──► submit
 *      │                                │
 *      ├──Enter (panel kind)──►  panel  │
 *      │                          │     │
 *      │                          └Esc──┤
 *      │                                │
 *      └────────────────Esc─────────────┴─────► closed
 *
 * Submit = dispatch `shax:emit-command` with `source: "palette"`
 * on the target pane's id. The existing safety gate intercepts;
 * destructive commands still get the second confirmation.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PaneCommand, PaneCommandRender, PaneContext } from "./registry";
import { availableCommands } from "./registry";
import { rankCommands, type RankedCommand } from "./filter";
import { isTopmostModalLayer, useModalLayer } from "../lib/modalLayer";

/** Emit source tag for palette-originated commands. Matches
 *  the `EmitSource` union in the Rust safety gate; kept as a
 *  string literal here to avoid an import from that module. */
const PALETTE_SOURCE = "palette";

export interface PaletteOverlayProps {
  ctx: PaneContext;
  onClose: () => void;
}

type OverlayView =
  | { kind: "list" }
  | { kind: "preview"; command: string; from: PaneCommand }
  | { kind: "panel"; render: PaneCommandRender & { kind: "panel" }; from: PaneCommand };

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.55)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "12vh",
  zIndex: 110,
};

const PANEL: CSSProperties = {
  width: "min(560px, 80vw)",
  maxHeight: "70vh",
  background: "var(--pane)",
  border: "1px solid var(--border-strong)",
  borderRadius: 10,
  boxShadow: "0 24px 48px rgba(0, 0, 0, 0.5)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "var(--font-ui)",
  color: "var(--fg)",
};

const INPUT_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  background: "var(--pane2)",
};

const INPUT_PROMPT: CSSProperties = {
  color: "var(--fg-faint)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
};

const INPUT_FIELD: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: "none",
  outline: "none",
  background: "transparent",
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 14,
};

const LIST: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "6px 0",
};

const GROUP_HEADER: CSSProperties = {
  padding: "6px 14px 2px",
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "var(--fg-faint)",
};

const ROW_BASE: CSSProperties = {
  padding: "6px 14px",
  fontSize: 13,
  color: "var(--fg)",
  cursor: "pointer",
};

const ROW_SELECTED: CSSProperties = {
  ...ROW_BASE,
  background: "var(--surface-hover)",
  color: "var(--fg)",
};

const ROW_DESC: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-dim)",
};

const EMPTY_NOTE: CSSProperties = {
  padding: "20px 14px",
  color: "var(--fg-faint)",
  fontSize: 12,
  textAlign: "center",
};

const PREVIEW_ROW: CSSProperties = {
  padding: "10px 14px",
  borderTop: "1px solid var(--border)",
  background: "var(--pane2)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--fg)",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const PREVIEW_KBD: CSSProperties = {
  fontSize: 11,
  padding: "1px 6px",
  border: "1px solid var(--border-strong)",
  borderRadius: 4,
  color: "var(--fg-dim)",
  fontFamily: "var(--font-mono)",
};

export function PaletteOverlay({ ctx, onClose }: PaletteOverlayProps): React.ReactElement {
  useModalLayer("palette-overlay");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<OverlayView>({ kind: "list" });
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo(() => availableCommands(ctx), [ctx]);
  const ranked = useMemo(() => rankCommands(commands, query), [commands, query]);

  // Focus the input on open; also whenever we bounce back to
  // the list view (e.g. panel cancelled).
  useEffect(() => {
    if (view.kind === "list") inputRef.current?.focus();
  }, [view.kind]);

  // Clamp selection whenever the ranked list length changes.
  useEffect(() => {
    if (selectedIndex >= ranked.length) {
      setSelectedIndex(Math.max(0, ranked.length - 1));
    }
  }, [ranked.length, selectedIndex]);

  const emitAndClose = (command: string): void => {
    window.dispatchEvent(
      new CustomEvent("shax:emit-command", {
        detail: { paneId: ctx.ptyId, command, source: PALETTE_SOURCE },
      }),
    );
    onClose();
  };

  const openSelected = (): void => {
    const entry = ranked[selectedIndex];
    if (entry === undefined) return;
    const rendered = entry.command.render(ctx);
    if (rendered.kind === "preview") {
      setView({ kind: "preview", command: rendered.command, from: entry.command });
    } else {
      setView({ kind: "panel", render: rendered, from: entry.command });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (view.kind !== "list") return;
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(ranked.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      openSelected();
      return;
    }
  };

  // Global Escape handling — closes whichever view is on top.
  // Preview: Esc backs out to the list. Panel: Esc backs out
  // to the list too. List: Esc closes the whole overlay. The
  // modal-layer check ensures another overlay opened on top of
  // us gets its Escape first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (!isTopmostModalLayer("palette-overlay")) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (view.kind === "list") {
        onClose();
      } else {
        setView({ kind: "list" });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [view.kind, onClose]);

  // Preview view: Enter submits, Esc backs out (handled above).
  useEffect(() => {
    if (view.kind !== "preview") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Enter") return;
      if (!isTopmostModalLayer("palette-overlay")) return;
      e.preventDefault();
      e.stopPropagation();
      emitAndClose(view.command);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // Deps intentionally exclude emitAndClose — it closes over
    // view.command via the current render pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const grouped = useMemo(() => groupRanked(ranked), [ranked]);

  return (
    <div
      data-testid="palette-overlay"
      style={BACKDROP}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={INPUT_ROW}>
          <span aria-hidden="true" style={INPUT_PROMPT}>
            &gt;
          </span>
          <input
            ref={inputRef}
            data-testid="palette-overlay-input"
            style={INPUT_FIELD}
            placeholder="Type a command"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>

        {view.kind === "list" && (
          <>
            <div style={LIST} data-testid="palette-overlay-list">
              {ranked.length === 0 && <div style={EMPTY_NOTE}>No matching commands.</div>}
              {grouped.map(({ group, entries }) => (
                <div key={group}>
                  <div style={GROUP_HEADER}>{group}</div>
                  {entries.map(({ command, indexInRanked }) => {
                    const isSelected = indexInRanked === selectedIndex;
                    return (
                      <div
                        key={command.name}
                        data-testid="palette-overlay-row"
                        data-selected={isSelected ? "true" : "false"}
                        style={isSelected ? ROW_SELECTED : ROW_BASE}
                        onMouseEnter={() => setSelectedIndex(indexInRanked)}
                        onClick={() => {
                          setSelectedIndex(indexInRanked);
                          openSelected();
                        }}
                      >
                        <div>{command.name}</div>
                        <div style={ROW_DESC}>{command.description}</div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}

        {view.kind === "preview" && (
          <div style={PREVIEW_ROW} data-testid="palette-overlay-preview">
            <kbd style={PREVIEW_KBD}>⏎</kbd>
            <span>{view.command}</span>
          </div>
        )}

        {view.kind === "panel" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
            <view.render.Panel
              ctx={ctx}
              onSubmit={(command) => {
                if (command === null) {
                  setView({ kind: "list" });
                  return;
                }
                setView({ kind: "preview", command, from: view.from });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Group ranked entries by their command group while preserving
 *  the global `indexInRanked` for keyboard navigation. Group
 *  order follows the first appearance of each group in the
 *  ranked list, so higher-relevance groups float up. */
interface GroupBucket {
  group: string;
  entries: { command: PaneCommand; indexInRanked: number }[];
}
function groupRanked(ranked: RankedCommand[]): GroupBucket[] {
  const order: string[] = [];
  const buckets = new Map<string, GroupBucket>();
  ranked.forEach(({ command }, indexInRanked) => {
    let bucket = buckets.get(command.group);
    if (bucket === undefined) {
      bucket = { group: command.group, entries: [] };
      buckets.set(command.group, bucket);
      order.push(command.group);
    }
    bucket.entries.push({ command, indexInRanked });
  });
  return order.map((g) => buckets.get(g)).filter((b): b is GroupBucket => b !== undefined);
}
