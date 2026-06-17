/**
 * TerminalPane — a single xterm.js instance wired to the backend PTY.
 *
 * Responsibilities:
 * - Mount an xterm Terminal into a full-window div via a ref.
 * - Attach FitAddon and call fit() on mount and on ResizeObserver events
 *   (debounced to avoid thrashing the backend during resize drags).
 * - Subscribe to the backend PTY via spawnPty; pipe Output events into the
 *   terminal and keystrokes out via writePty.
 * - On unmount: killPty, dispose the Terminal, disconnect the observer.
 *
 * When running outside Tauri (browser dev server, Playwright) the IPC layer
 * returns a no-op handle and the component renders a static notice so the
 * page still mounts and tests can assert on the DOM.
 */

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { spawnPty, writePty, resizePty, killPty, base64Decode } from "../lib/ipc";
import type { PtyId, PtyEvent } from "../lib/ipc";

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

    // Spawn the PTY; pipe Output events into the terminal.
    const handleEvent = (event: PtyEvent): void => {
      if (event.kind === "output") {
        terminal.write(base64Decode(event.data));
      }
      // "exit" events are intentionally ignored for now: the shell will print
      // its own exit message; a future slice will handle block assembly.
    };

    void spawnPty({ rows: terminal.rows, cols: terminal.cols }, handleEvent).then((id) => {
      ptyIdRef.current = id;
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
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
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
  );
}
