/**
 * Rescan the community-commands directory, register whatever's
 * new, report the names loaded (or "nothing changed"). Read-only
 * — closes on Esc / click.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { loadCommunityCommands } from "../../sandbox/loader";
import type { PaneContext } from "../../registry";

export interface ReloadPanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

const STATUS: CSSProperties = {
  padding: 16,
  fontSize: 12,
  color: "var(--fg-dim)",
  textAlign: "center",
};

const OK: CSSProperties = {
  ...STATUS,
  color: "var(--green)",
};

const ERR: CSSProperties = {
  ...STATUS,
  color: "var(--red)",
};

type ReloadState =
  | { kind: "loading" }
  | { kind: "loaded"; names: readonly string[] }
  | { kind: "error"; reason: string };

export function ReloadPanel({ onSubmit }: ReloadPanelProps): React.ReactElement {
  const [state, setState] = useState<ReloadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void loadCommunityCommands()
      .then((names) => {
        if (cancelled) return;
        setState({ kind: "loaded", names });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return <div style={STATUS}>Scanning ~/.config/shax/commands/…</div>;
  }
  if (state.kind === "error") {
    return (
      <div>
        <div style={ERR}>{state.reason}</div>
        <div style={STATUS}>
          <button type="button" onClick={() => onSubmit(null)}>
            Close
          </button>
        </div>
      </div>
    );
  }
  const summary =
    state.names.length === 0
      ? "No community commands found."
      : `Loaded ${state.names.length} command${
          state.names.length === 1 ? "" : "s"
        }: ${state.names.join(", ")}`;
  return (
    <div>
      <div style={OK}>{summary}</div>
      <div style={STATUS}>
        <button type="button" data-testid="palette-reload-close" onClick={() => onSubmit(null)}>
          Close
        </button>
      </div>
    </div>
  );
}
