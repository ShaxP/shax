/**
 * "New Window" palette entry (M9.3, spec §15).
 *
 * Behaviour: mount → spawn a fresh Shax window via IPC → close
 * the palette. User sees the palette briefly then the new window
 * opens over/beside the current one. On IPC failure, show the
 * reason with a Close button rather than silently swallowing —
 * the panel is the only surface that can report a spawn error
 * back to the user.
 *
 * Mirrors the shape of `builtins/reload/ReloadPanel.tsx` (also a
 * fire-and-forget on-mount action). Not a shell-command emitter,
 * so `onSubmit` is always called with `null`.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { openNewWindow } from "../../../lib/ipc";
import type { PaneContext } from "../../registry";

export interface NewWindowPanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

const STATUS: CSSProperties = {
  padding: 16,
  fontSize: 12,
  color: "var(--fg-dim)",
  textAlign: "center",
};

const ERR: CSSProperties = {
  ...STATUS,
  color: "var(--red)",
};

type SpawnState = { kind: "spawning" } | { kind: "error"; reason: string };

export function NewWindowPanel({ onSubmit }: NewWindowPanelProps): React.ReactElement {
  const [state, setState] = useState<SpawnState>({ kind: "spawning" });

  useEffect(() => {
    let cancelled = false;
    void openNewWindow()
      .then(() => {
        if (cancelled) return;
        // Success — close the palette. The new window has already
        // been created by the backend; there's nothing left for
        // this panel to show.
        onSubmit(null);
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
  }, [onSubmit]);

  if (state.kind === "spawning") {
    return <div style={STATUS}>Opening a new window…</div>;
  }
  return (
    <div>
      <div style={ERR}>Failed to open new window: {state.reason}</div>
      <div style={STATUS}>
        <button type="button" data-testid="palette-new-window-close" onClick={() => onSubmit(null)}>
          Close
        </button>
      </div>
    </div>
  );
}
