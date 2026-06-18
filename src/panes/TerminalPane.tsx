/**
 * TerminalPane — a single xterm.js instance wired to the backend PTY, with
 * the BlockList rendered alongside it.
 *
 * Responsibilities:
 * - Mount an xterm Terminal into the main canvas via a ref.
 * - Attach FitAddon and call fit() on mount and on ResizeObserver events
 *   (debounced to avoid thrashing the backend during resize drags).
 * - Subscribe to the backend PTY via spawnPty; pipe Output events into the
 *   terminal and keystrokes out via writePty.
 * - Route block-lifecycle and alt-screen IPC events into the blockReducer.
 * - Render the BlockList beside the xterm so captured commands surface as
 *   real, structured rows (replaces the slice-2 DevStatusBar).
 * - On unmount: killPty, dispose the Terminal, disconnect the observer.
 *
 * When running outside Tauri (browser dev server, Playwright) the IPC layer
 * returns a no-op handle and the component renders a static notice so the
 * page still mounts and tests can assert on the DOM.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { spawnPty, writePty, resizePty, killPty, listBlocks, base64Decode } from "../lib/ipc";
import type { PtyId, PtyEvent } from "../lib/ipc";
import { blockReducer, initialBlockState } from "./blockReducer";
import { BlockList } from "./BlockList";

const RESIZE_DEBOUNCE_MS = 50;

function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function TerminalPane(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  // Held as refs so the cleanup closure always sees the live values without
  // adding them to any effect dependency array.
  const terminalRef = useRef<Terminal | null>(null);
  const ptyIdRef = useRef<PtyId | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const [blockState, dispatch] = useReducer(blockReducer, initialBlockState);
  // Mirror the pty id into React state so the BlockList re-renders once the
  // backend assigns one. (The ref is for the effect; state is for the children.)
  const [ptyId, setPtyId] = useState<PtyId | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const terminal = new Terminal({
      // Let xterm fill the container; FitAddon will set the actual dimensions.
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    // Without this, the xterm canvas does not receive keystrokes until the
    // user clicks on it. Auto-focus on mount so the pane is interactive
    // immediately (matches the behavior of every native terminal app).
    terminal.focus();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Encode keystrokes and send them to the PTY.
    const encoder = new TextEncoder();
    const dataDisposable = terminal.onData((data: string) => {
      const id = ptyIdRef.current;
      if (id === null) return;
      void writePty(id, encoder.encode(data));
    });

    // ResizeObserver drives fit() and a resizePty call whenever the container
    // changes size (window resize, pane split later, etc.).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        const id = ptyIdRef.current;
        if (id !== null) {
          void resizePty(id, terminal.rows, terminal.cols);
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    // Route IPC events: output bytes go to xterm; block-lifecycle and
    // alt-screen events go to the reducer. The "exit" event is intentionally
    // left as a no-op for now — the shell will print its own message and a
    // future slice will handle clean teardown.
    const handleEvent = (event: PtyEvent): void => {
      switch (event.kind) {
        case "output":
          terminal.write(base64Decode(event.data));
          break;

        case "alt_screen_changed":
          dispatch({ type: "alt_screen", active: event.active });
          break;

        case "block_started":
          dispatch({
            type: "started",
            id: event.block_id,
            command: event.command,
            started_at_ms: event.started_at_ms,
          });
          break;

        case "block_completed":
          dispatch({
            type: "completed",
            id: event.block_id,
            exit_code: event.exit_code,
            ended_at_ms: event.ended_at_ms,
            duration_ms: event.duration_ms,
            aborted: event.aborted,
          });
          break;

        case "exit":
          // Handled by the shell's own output for now; block teardown in slice 4.
          break;
      }
    };

    void spawnPty({ rows: terminal.rows, cols: terminal.cols }, handleEvent).then((id) => {
      ptyIdRef.current = id;
      setPtyId(id);
      // Seed block state from any blocks that already existed before the
      // frontend mounted (defensive; in practice the pane mounts before the
      // first block is recorded).
      void listBlocks(id).then((blocks) => {
        if (blocks.length > 0) {
          dispatch({ type: "seed", blocks });
        }
      });
    });

    return () => {
      // Stop observing before anything else to prevent stray fit() calls.
      resizeObserver.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);

      dataDisposable.dispose();

      const id = ptyIdRef.current;
      if (id !== null) {
        void killPty(id);
        ptyIdRef.current = null;
      }

      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []); // intentionally empty: setup and teardown run once per mount

  const isInsideTauri = isTauriContext();

  return (
    <div
      data-testid="terminal-pane"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "row",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {!isInsideTauri && (
          <div
            data-testid="non-tauri-notice"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#888",
              fontFamily: "monospace",
              fontSize: "14px",
              pointerEvents: "none",
            }}
          >
            Not running inside Shax
          </div>
        )}
      </div>
      <BlockList pty={ptyId} blocks={blockState.blocks} />
    </div>
  );
}
