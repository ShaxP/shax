/**
 * TerminalPane — one PTY's session, structured around the M1.9
 * prompt-strip-owns-input model.
 *
 * One instance per tab as of M2 slice 2.1. The App-level shell owns the
 * top chrome (TitleBar, Statusline) so multiple TerminalPanes can coexist
 * in background-tab state without each rendering its own copy. Per-tab
 * state changes (cwd, branch, alt-screen) bubble up through callback
 * props so the chrome can reflect whichever tab is currently active.
 *
 * Resting state (no alt-screen):
 *   - Block stack is the visible scrollback.
 *   - PromptStrip is focused and captures keystrokes (only when `active`).
 *     xterm.js is hidden behind the block stack (kept alive so its byte
 *     stream stays in sync and alt-screen handover doesn't need a re-fit).
 *
 * Alt-screen state (vim, less, top, REPLs):
 *   - xterm.js is revealed and focused (only when `active`).
 *   - Block stack and prompt strip step aside.
 *
 * Background-tab state (`active=false`):
 *   - The PTY stays alive and events continue to flow into the reducer.
 *   - Focus is never claimed.
 *   - The pane is wrapped by the App in a hidden container, so users
 *     don't see it.
 */

import { memo, startTransition, useEffect, useReducer, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { spawnPty, writePty, resizePty, killPty, listBlocks, base64Decode } from "../lib/ipc";
import type { PtyId, PtyEvent } from "../lib/ipc";
import { blockReducer, initialBlockState } from "./blockReducer";
import { BlockList } from "./BlockList";
import { PromptStrip } from "./PromptStrip";

const RESIZE_DEBOUNCE_MS = 50;

function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface TerminalPaneProps {
  /**
   * True when this pane is the currently-visible tab. The pane uses this
   * to decide whether to claim focus on mount / on alt-screen toggle, and
   * the parent uses the same flag to set the wrapper's visibility.
   * Defaults to true so callers that render a single pane don't need to
   * pass it.
   */
  active?: boolean;
  /**
   * Notify the parent when this pane's cwd / branch changes (sourced from
   * the latest OSC 133 A). Used by the App-level TitleBar and Statusline
   * to show the active tab's metadata.
   */
  onMetaChange?: (cwd: string | null, branch: string | null) => void;
  /**
   * Notify the parent when the alternate screen flips on or off so the
   * App can route focus and adjust chrome accordingly.
   */
  onAltScreenChange?: (active: boolean) => void;
}

function TerminalPaneInner({
  active = true,
  onMetaChange,
  onAltScreenChange,
}: TerminalPaneProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  // Held as refs so the cleanup closure always sees the live values without
  // adding them to any effect dependency array.
  const terminalRef = useRef<Terminal | null>(null);
  const ptyIdRef = useRef<PtyId | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const promptStripRef = useRef<HTMLDivElement | null>(null);

  const [blockState, dispatch] = useReducer(blockReducer, initialBlockState);
  // Mirror the pty id into React state so the BlockList re-renders once the
  // backend assigns one. (The ref is for the effect; state is for the children.)
  const [ptyId, setPtyId] = useState<PtyId | null>(null);
  // Set to the shell's exit code when the PTY exits while the pane is
  // alive. The banner reads this to render a "shell exited / restart"
  // overlay. `null` means the shell is alive; `-1` is the sentinel for
  // "no numeric code reported" (signal-killed, etc.).
  const [exitedCode, setExitedCode] = useState<number | null>(null);
  // Bumped by `handleRestart` to retrigger the mount effect: the existing
  // cleanup tears down xterm + the (already-dead) PTY entry, and setup
  // spawns a fresh shell in the same React-tree position. No unmount,
  // so the pane wrapper, focus state, and layout slot stay intact.
  const [restartNonce, setRestartNonce] = useState(0);

  const altScreen = blockState.altScreen;

  // Mirror altScreen into a ref so the IPC event handler can read it
  // without re-binding the channel listener. We use this to short-circuit
  // `block_chunk` events during alt-screen mode (vim, htop, btop, …):
  // the bytes are already streaming through xterm for display, and the
  // block list is hidden, so accumulating them again into `liveOutputs`
  // is wasted work — a wasted base64 decode, a wasted reducer dispatch,
  // a wasted React render, and a Uint8Array copy that grows O(N²) with
  // every byte the alt-screen app emits. A long btop session would
  // otherwise pile up tens of megabytes of bytes nobody will ever read.
  const altScreenRef = useRef(false);
  useEffect(() => {
    altScreenRef.current = altScreen;
  }, [altScreen]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    // Read the monospace font stack from the global theme so xterm's
    // canvas renderer picks up the same Nerd-Font-first list used by
    // the rest of the UI (prompt strip, block list). Falls back to a
    // safe default if the CSS variable is missing for any reason.
    const fontMono =
      typeof window !== "undefined"
        ? getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
        : "";
    const terminal = new Terminal({
      // Let xterm fill the container; FitAddon will set the actual dimensions.
      allowProposedApi: true,
      fontFamily: fontMono !== "" ? fontMono : "ui-monospace, monospace",
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // xterm still has `onData` for the alt-screen path: when the alternate
    // screen is active (vim, less, top), xterm takes focus and the prompt
    // strip steps aside. Keystrokes captured here are forwarded straight
    // to the PTY, same as before.
    const dataDisposable = terminal.onData((data: string) => {
      const id = ptyIdRef.current;
      if (id === null) return;
      void writePty(id, new TextEncoder().encode(data));
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
    // alt-screen events go to the reducer.
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
            cwd: event.cwd,
            git_branch: event.git_branch,
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
            cwd: event.cwd,
            git_branch: event.git_branch,
            interactive: event.interactive,
          });
          break;

        case "block_chunk":
          // Skip the whole chunk pipeline when the alt-screen owns the
          // pane — see the `altScreenRef` comment above for the why.
          if (altScreenRef.current) break;
          dispatch({
            type: "block_chunk",
            id: event.block_id,
            bytes: base64Decode(event.data),
          });
          break;

        case "prompt_chunk":
          dispatch({
            type: "prompt_chunk",
            bytes: base64Decode(event.data),
          });
          break;

        case "exit":
          // The shell died (user typed `exit`, it crashed, or a
          // `kill -9` from outside). The PTY entry is gone from the
          // backend map; surface the fact in the UI so the user can
          // restart instead of staring at an unresponsive prompt.
          // Use -1 as the "no code" sentinel so the banner can
          // distinguish "exited cleanly with no reported code" from
          // a real exit code.
          setExitedCode(event.code ?? -1);
          ptyIdRef.current = null;
          break;
      }
    };

    // Race guard: if the pane is closed (or React StrictMode runs the
    // double-mount dance) before spawn resolves, we still want to kill
    // the freshly-minted PTY so it doesn't outlive its UI.
    let cancelled = false;
    void spawnPty({ rows: terminal.rows, cols: terminal.cols }, handleEvent).then((id) => {
      if (cancelled) {
        void killPty(id);
        return;
      }
      ptyIdRef.current = id;
      setPtyId(id);
      void listBlocks(id).then((blocks) => {
        if (blocks.length > 0) {
          startTransition(() => {
            dispatch({ type: "seed", blocks });
          });
        }
      });
    });

    return () => {
      cancelled = true;

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
    // `restartNonce` is the only intentional retrigger — everything else
    // used inside is a ref or the dispatch/stable closures captured at
    // mount, so excluding them from the dep array is deliberate.
  }, [restartNonce]);

  // Derive the current cwd/branch from the most recently observed block.
  // OSC 133 A on every prompt updates the block's metadata, so the last
  // entry always reflects where the shell is now.
  const latestBlock = blockState.blocks[blockState.blocks.length - 1];
  const cwd = latestBlock?.cwd ?? null;
  const branch = latestBlock?.git_branch ?? null;

  // Tell the parent whenever cwd / branch / alt-screen changes so the
  // App-level chrome can mirror the active tab's state. We stash the
  // callbacks in refs and depend only on the value, otherwise an inline
  // arrow-in-parent (the common case for App) would change identity on
  // every parent render and cause an effect → setState → render loop.
  const onMetaChangeRef = useRef(onMetaChange);
  const onAltScreenChangeRef = useRef(onAltScreenChange);
  useEffect(() => {
    onMetaChangeRef.current = onMetaChange;
  }, [onMetaChange]);
  useEffect(() => {
    onAltScreenChangeRef.current = onAltScreenChange;
  }, [onAltScreenChange]);
  useEffect(() => {
    onMetaChangeRef.current?.(cwd, branch);
  }, [cwd, branch]);
  useEffect(() => {
    onAltScreenChangeRef.current?.(altScreen);
  }, [altScreen]);

  // Focus management. Only the active pane claims focus, so background
  // tabs don't pull keystrokes away from the user's currently-visible tab.
  useEffect(() => {
    if (!active) return;
    if (altScreen) {
      terminalRef.current?.focus();
    } else {
      promptStripRef.current?.focus();
    }
  }, [active, altScreen]);

  // Forward typed bytes from the PromptStrip to the PTY. The strip never
  // local-echoes; the shell's own echo (via `prompt_chunk`) drives the
  // visible line through the renderer.
  const handlePromptInput = (bytes: Uint8Array): void => {
    const id = ptyIdRef.current;
    if (id === null) return;
    void writePty(id, bytes);
  };

  // Restart the shell after it exited. Wipes the pane's runtime state
  // (block list, live outputs, alt-screen flag, prompt strip) and bumps
  // `restartNonce` so the mount effect re-runs: cleanup tears down the
  // old xterm + the (already-dead) PTY entry, setup spawns a fresh shell.
  const handleRestart = (): void => {
    dispatch({ type: "reset" });
    setExitedCode(null);
    setRestartNonce((n) => n + 1);
  };

  const isInsideTauri = isTauriContext();

  return (
    <div
      data-testid="terminal-pane"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--fg)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <div
        data-testid="pane-area"
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          background: "var(--bg)",
        }}
      >
        <div
          data-testid="xterm-wrapper"
          style={{
            position: "absolute",
            inset: 0,
            background: "var(--pane)",
            // Stack instead of visibility-toggle. The App-level tab
            // wrapper uses `visibility: hidden` to hide background tabs;
            // if we also used `visibility: visible` here it would
            // override the parent's hide (visibility:visible on a child
            // overrides visibility:hidden on the parent) and the
            // alt-screen xterm of a background tab would render on top
            // of the active tab. Z-index keeps xterm on top of the
            // block list only when its own tab is in alt-screen mode,
            // and the App's visibility:hidden remains effective for
            // every layer inside an inactive tab.
            pointerEvents: altScreen ? "auto" : "none",
            zIndex: altScreen ? 2 : 0,
          }}
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
                color: "var(--fg-faint)",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                pointerEvents: "none",
              }}
            >
              Not running inside Shax
            </div>
          )}
        </div>

        <div
          style={{
            display: altScreen ? "none" : "flex",
            flex: 1,
            minHeight: 0,
            position: "relative",
            zIndex: 1,
          }}
        >
          <BlockList pty={ptyId} blocks={blockState.blocks} liveOutputs={blockState.liveOutputs} />
        </div>
        {exitedCode !== null && (
          <div
            data-testid="shell-exited-banner"
            style={{
              position: "absolute",
              left: 12,
              right: 12,
              bottom: 12,
              zIndex: 50,
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 14px",
              borderRadius: "var(--radius)",
              background: "var(--surface)",
              border: "1px solid var(--border-strong)",
              color: "var(--fg)",
              fontFamily: "var(--font-ui)",
              fontSize: 13,
              boxShadow: "0 6px 24px rgba(0, 0, 0, 0.35)",
            }}
          >
            <span style={{ flex: 1 }}>
              Shell exited
              {exitedCode >= 0 ? ` with code ${exitedCode}` : ""}.
            </span>
            <button
              type="button"
              data-testid="shell-restart"
              onClick={handleRestart}
              style={{
                background: "var(--accent)",
                color: "var(--bg)",
                border: "none",
                borderRadius: "var(--radius-sm)",
                padding: "5px 12px",
                fontFamily: "var(--font-ui)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Restart shell
            </button>
          </div>
        )}
      </div>
      {!altScreen && exitedCode === null && (
        <PromptStrip
          ref={promptStripRef}
          cwd={cwd}
          branch={branch}
          line={blockState.promptLine}
          onInput={handlePromptInput}
          altScreen={altScreen}
        />
      )}
    </div>
  );
}

/**
 * Memoised so the geometry-driven layout re-renders on every divider
 * drag don't propagate into the (relatively heavy) TerminalPane
 * subtree. Together with the stable callbacks LayoutRender now hands
 * down, a pane only re-renders when its own `active` flag changes or
 * its internal state advances — not when a sibling's divider is being
 * dragged or a sibling's PTY emits output.
 */
export const TerminalPane = memo(TerminalPaneInner);
