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

import { memo, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { spawnPty, writePty, resizePty, killPty, base64Decode } from "../lib/ipc";
import type { BlockId, PtyId, PtyEvent } from "../lib/ipc";
import type { UiBlock } from "./blockReducer";
import { blockReducer, initialBlockState } from "./blockReducer";
import { BlockList } from "./BlockList";
import { PromptStrip } from "./PromptStrip";
import {
  dispatchBlockKey,
  firstBlockId,
  INITIAL_KEY_STATE,
  lastBlockId,
  nextBlockId,
  prevBlockId,
  smartScrollDown,
  smartScrollUp,
  type BlockKeyAction,
  type KeyState,
  type ScrollFrame,
} from "./blockFocus";

const RESIZE_DEBOUNCE_MS = 50;

function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface TerminalPaneProps {
  /**
   * Stable id by which the parent (App, via LayoutRender) addresses
   * this pane. The pane uses it to filter window-level "send this
   * block to a specific pane" events (the search overlay's jump and
   * inspect paths).
   */
  paneId?: string;
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
  /**
   * Notify the parent of the backend-assigned PTY id once spawn
   * resolves. The App uses this to maintain a paneId → ptyId map so
   * that "jump to pane" in the search overlay can route to a still-
   * alive pane when its block was the search hit.
   */
  onPtyIdChange?: (ptyId: PtyId | null) => void;
}

function TerminalPaneInner({
  paneId,
  active = true,
  onMetaChange,
  onAltScreenChange,
  onPtyIdChange,
}: TerminalPaneProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  // Wraps the entire pane (title-bar-below-chrome + block list +
  // prompt strip). The mousedown listener below uses it to route
  // clicks: inside a block row engages block-focus + selects;
  // anywhere else (prompt / meta / empty area) exits block-focus.
  const paneRootRef = useRef<HTMLDivElement>(null);
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

  // ── Search-jump events ────────────────────────────────────────────────
  //
  // The search overlay fires window-level events to tell *a specific*
  // pane to either select an existing block (`shax:select-block`) or
  // inspect a historical one (`shax:inspect-block`). Every TerminalPane
  // listens; only the one whose `paneId` matches the event's detail
  // routes the action to its block reducer.
  useEffect(() => {
    if (paneId === undefined) return;
    const onSelect = (e: Event): void => {
      const detail = (e as CustomEvent<{ paneId: string; blockId: BlockId; focus?: boolean }>)
        .detail;
      if (detail?.paneId !== paneId) return;
      dispatch({ type: "select_block", id: detail.blockId });
      // The search overlay's jump path sets `focus: true` so the
      // user lands ready to navigate with j/k/Enter/Esc. Plain
      // click-to-select on a row omits the flag (BlockList passes
      // just `id`), so the highlight updates without hijacking
      // the keymap.
      if (detail.focus === true) setBlockFocus(true);
    };
    const onInspect = (e: Event): void => {
      const detail = (e as CustomEvent<{ paneId: string; block: UiBlock; focus?: boolean }>).detail;
      if (detail?.paneId !== paneId) return;
      dispatch({ type: "inspect_block", block: detail.block });
      if (detail.focus === true) setBlockFocus(true);
    };
    window.addEventListener("shax:select-block", onSelect);
    window.addEventListener("shax:inspect-block", onInspect);
    return () => {
      window.removeEventListener("shax:select-block", onSelect);
      window.removeEventListener("shax:inspect-block", onInspect);
    };
  }, [paneId]);

  // ── Block-focus mode ──────────────────────────────────────────────────
  //
  // When active && blockFocus is true, this pane intercepts the
  // navigation keys defined in `panes/blockFocus.ts`. Entry is via
  // Ctrl+J (handled below); exit via Esc or another Ctrl+J.
  const [blockFocus, setBlockFocus] = useState(false);
  // Block "fit-to-pane": when set, the named block fills the
  // whole pane (covering the prompt strip and every other
  // block). Navigation is suspended in this state — the only
  // valid keys are the lens cycle (Tab), yank (y), and a
  // second `f` (or Esc) to restore normal view.
  const [maximizedBlockId, setMaximizedBlockId] = useState<BlockId | null>(null);
  // Refs let the keydown handler read the latest state without
  // re-registering on every block-list change.
  const blocksRef = useRef<UiBlock[]>([]);
  const selectedIdRef = useRef<BlockId | null>(null);
  const blockFocusRef = useRef(false);
  const activeRef = useRef(active);
  const chordStateRef = useRef<KeyState>(INITIAL_KEY_STATE);
  const maximizedBlockIdRef = useRef<BlockId | null>(null);
  blocksRef.current = blockState.blocks;
  selectedIdRef.current = blockState.selectedBlockId;
  blockFocusRef.current = blockFocus;
  activeRef.current = active;
  maximizedBlockIdRef.current = maximizedBlockId;

  // Every block is navigable, including interactive ones (vim,
  // less, htop). The user still needs to reach them to yank the
  // command, open the modal, etc. — operations that don't depend
  // on a rich rendered body. Block-action listeners in BlockRow
  // no-op on operations that don't apply (expand/collapse for
  // interactive blocks).
  const navigableBlocks = (): UiBlock[] => blocksRef.current;
  const navigableIds = (): string[] => navigableBlocks().map((b) => b.id);

  // Imperative helpers used by the action dispatcher below.
  const selectBlock = (id: BlockId | null): void => {
    dispatch({ type: "select_block", id });
  };

  const getScrollHost = (blockId: BlockId): HTMLElement | null => {
    const block = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
    if (block === null) return null;
    // Formatters that opt into the navigation API tag their
    // scroller explicitly (ls, git diff).
    const tagged = block.querySelector<HTMLElement>("[data-block-scroll-host]");
    if (tagged !== null) return tagged;
    // Fit-to-pane: every other formatter's scroller has to be
    // findable too. Walk the block for the most-likely
    // scrollable elements — CodeMirror's `.cm-scroller`, the
    // markdown view, the hex view — and pick the first one
    // whose content actually overflows. Capped query list
    // keeps the lookup O(handful), not full-DOM.
    const candidates = block.querySelectorAll<HTMLElement>(
      ".cm-scroller, [data-testid='markdown-rendered'], [data-testid='hex-view']",
    );
    for (const el of Array.from(candidates)) {
      if (el.scrollHeight > el.clientHeight + 1) return el;
    }
    return null;
  };

  const scrollFrame = (host: HTMLElement | null): ScrollFrame | null => {
    if (host === null) return null;
    return {
      scrollTop: host.scrollTop,
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
    };
  };

  /** Dispatch a `shax:widget-nav` event for a directional
   *  key press (`j`/`k`/`h`/`l` and their arrow-key aliases).
   *  Widgets that own file / item navigation listen for these,
   *  set `detail.claimed = true` when they moved focus, and
   *  we return `true` so the caller skips its default action.
   *  When no widget is present or the widget is at a boundary
   *  it leaves `claimed` false and normal scroll / block
   *  advance / block collapse-expand takes over. */
  const dispatchWidgetNav = (
    blockId: BlockId,
    direction: "up" | "down" | "left" | "right",
  ): boolean => {
    const detail = { blockId, direction, claimed: false };
    window.dispatchEvent(new CustomEvent("shax:widget-nav", { detail }));
    return detail.claimed;
  };

  /** Drop the new block into a sensible scroll position when
   *  focus advances continuously: top-edge when going down,
   *  bottom-edge when going up. Mimics RSS / mail readers. */
  const positionForDirection = (id: BlockId, dir: "next" | "prev"): void => {
    const host = getScrollHost(id);
    if (host === null) return;
    host.scrollTop = dir === "next" ? 0 : host.scrollHeight;
  };

  /** Scroll the BlockList just enough so the entire block is
   *  visible. Called after `expand` so freshly-revealed output
   *  on the last block doesn't sit half off-screen. If the block
   *  is taller than the visible area, align its top instead so
   *  the user sees the start of the output. */
  const ensureBlockVisible = (id: BlockId): void => {
    const block = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
    if (block === null) return;
    const list = block.closest<HTMLElement>('[data-testid="block-list"]');
    if (list === null) return;
    const blockRect = block.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (blockRect.height > listRect.height) {
      // Block bigger than the viewport — align its top.
      list.scrollTop += blockRect.top - listRect.top;
      return;
    }
    if (blockRect.bottom > listRect.bottom) {
      list.scrollTop += blockRect.bottom - listRect.bottom;
    } else if (blockRect.top < listRect.top) {
      list.scrollTop -= listRect.top - blockRect.top;
    }
  };

  const advanceFocus = (dir: "next" | "prev"): void => {
    const ids = navigableIds();
    const current = selectedIdRef.current;
    const newId = dir === "next" ? nextBlockId({ ids }, current) : prevBlockId({ ids }, current);
    if (newId === null || newId === current) return;
    selectBlock(newId);
    // Defer scroll positioning to next paint — the new id needs
    // to be in the DOM first.
    requestAnimationFrame(() => positionForDirection(newId, dir));
  };

  const exitBlockFocus = (): void => {
    setBlockFocus(false);
    selectBlock(null);
    chordStateRef.current = INITIAL_KEY_STATE;
    // Hand focus back to the prompt strip (or xterm under
    // alt-screen). Reusing the existing "refocus active pane"
    // signal would couple us to App; an explicit event keeps
    // TerminalPane self-contained.
    window.dispatchEvent(new CustomEvent("shax:refocus-pane"));
  };

  // Approx line height of the in-pane formatter / raw rows; used
  // for line-step scrolls. Conservative — most formatter rows are
  // 18–20 px in the current theme.
  const LINE_PX = 20;
  const PAGE_FRACTION = 0.9;

  const performAction = (action: BlockKeyAction): void => {
    const currentId = selectedIdRef.current;
    // Fit-to-pane: the visible UI hides every other row, so
    // "advance to next block" makes no sense. Instead, redirect
    // every navigation action to *scroll within* the maximised
    // block's content. Lens-cycle / yank / open-modal /
    // un-maximise still pass through to their normal handlers.
    if (maximizedBlockIdRef.current !== null) {
      const id = currentId;
      const host = id !== null ? getScrollHost(id) : null;
      switch (action.kind) {
        case "exit":
          // Esc un-maximises first; a second Esc exits block-focus.
          setMaximizedBlockId(null);
          return;
        case "advance-down":
          // Give widgets first refusal so a fit-to-pane git-diff
          // widget still walks its file list on j / ArrowDown.
          if (id !== null && dispatchWidgetNav(id, "down")) return;
          if (host !== null) host.scrollTop += LINE_PX;
          return;
        case "advance-up":
          if (id !== null && dispatchWidgetNav(id, "up")) return;
          if (host !== null) host.scrollTop -= LINE_PX;
          return;
        case "page-down":
          if (host !== null) host.scrollTop += host.clientHeight * PAGE_FRACTION;
          return;
        case "page-up":
          if (host !== null) host.scrollTop -= host.clientHeight * PAGE_FRACTION;
          return;
        case "first-block":
        case "scroll-top":
          if (host !== null) host.scrollTop = 0;
          return;
        case "last-block":
        case "scroll-bottom":
          if (host !== null) host.scrollTop = host.scrollHeight;
          return;
        case "focus":
          // Block-list clicks are meaningless while one block
          // owns the pane.
          return;
        case "noop":
          return;
        case "toggle-fmt-raw":
        case "toggle-side-by-side":
        case "toggle-maximize":
        case "widget-primary":
        case "yank":
        case "collapse":
        case "expand":
        case "open-modal":
        case "ask-shax":
          // Fall through to the normal handlers below.
          break;
      }
    }
    switch (action.kind) {
      case "noop":
        return;
      case "exit":
        exitBlockFocus();
        return;
      case "focus":
        selectBlock(action.id);
        return;
      case "first-block": {
        const id = firstBlockId({ ids: navigableIds() });
        if (id !== null) {
          selectBlock(id);
          requestAnimationFrame(() => positionForDirection(id, "prev"));
        }
        return;
      }
      case "last-block": {
        const id = lastBlockId({ ids: navigableIds() });
        if (id !== null) {
          selectBlock(id);
          requestAnimationFrame(() => positionForDirection(id, "next"));
        }
        return;
      }
      case "advance-down": {
        if (currentId === null) return;
        // Widgets in the current block get first refusal on
        // j / ArrowDown: the git-diff widget moves its focused
        // file down, claims the event, and we return. When
        // the widget is at its last file (or absent) the
        // event isn't claimed and we fall through to the
        // usual scroll-then-advance path.
        if (dispatchWidgetNav(currentId, "down")) return;
        const host = getScrollHost(currentId);
        const decision = smartScrollDown(scrollFrame(host), LINE_PX);
        if (decision.kind === "scroll-within" && host !== null) {
          host.scrollTop += decision.deltaPx;
        } else {
          advanceFocus("next");
        }
        return;
      }
      case "advance-up": {
        if (currentId === null) return;
        if (dispatchWidgetNav(currentId, "up")) return;
        const host = getScrollHost(currentId);
        const decision = smartScrollUp(scrollFrame(host), LINE_PX);
        if (decision.kind === "scroll-within" && host !== null) {
          host.scrollTop += decision.deltaPx;
        } else {
          advanceFocus("prev");
        }
        return;
      }
      case "widget-primary": {
        // Space: give widgets first refusal — a git-status
        // widget emits a `git add / git reset HEAD` command
        // for the focused entry, ls will `cd` on the focused
        // row, etc. If nothing claims, fall through to
        // page-down so bare blocks behave as they always did.
        if (currentId === null) return;
        const detail = { blockId: currentId, claimed: false };
        window.dispatchEvent(new CustomEvent("shax:widget-primary", { detail }));
        if (detail.claimed) return;
        // Fall through: same body as `page-down`.
        const host = getScrollHost(currentId);
        if (host === null) {
          advanceFocus("next");
          return;
        }
        const page = host.clientHeight * PAGE_FRACTION;
        const decision = smartScrollDown(scrollFrame(host), page);
        if (decision.kind === "scroll-within") {
          host.scrollTop += decision.deltaPx;
        } else {
          advanceFocus("next");
        }
        return;
      }
      case "page-down": {
        if (currentId === null) return;
        const host = getScrollHost(currentId);
        if (host === null) {
          advanceFocus("next");
          return;
        }
        const page = host.clientHeight * PAGE_FRACTION;
        const decision = smartScrollDown(scrollFrame(host), page);
        if (decision.kind === "scroll-within") {
          host.scrollTop += decision.deltaPx;
        } else {
          advanceFocus("next");
        }
        return;
      }
      case "page-up": {
        if (currentId === null) return;
        const host = getScrollHost(currentId);
        if (host === null) {
          advanceFocus("prev");
          return;
        }
        const page = host.clientHeight * PAGE_FRACTION;
        const decision = smartScrollUp(scrollFrame(host), page);
        if (decision.kind === "scroll-within") {
          host.scrollTop += decision.deltaPx;
        } else {
          advanceFocus("prev");
        }
        return;
      }
      case "scroll-top":
        if (currentId !== null) {
          const host = getScrollHost(currentId);
          if (host !== null) host.scrollTop = 0;
        }
        return;
      case "scroll-bottom":
        if (currentId !== null) {
          const host = getScrollHost(currentId);
          if (host !== null) host.scrollTop = host.scrollHeight;
        }
        return;
      case "open-modal":
        if (currentId !== null) {
          const block = blocksRef.current.find((b) => b.id === currentId);
          if (block !== undefined) {
            window.dispatchEvent(
              new CustomEvent("shax:open-viewer", {
                detail: { pty: ptyIdRef.current, block },
              }),
            );
          }
        }
        return;
      case "toggle-maximize":
        if (currentId !== null) {
          setMaximizedBlockId((prev) => (prev === currentId ? null : currentId));
        }
        return;
      case "toggle-fmt-raw":
      case "toggle-side-by-side":
      case "yank":
      case "ask-shax":
        if (currentId !== null) {
          window.dispatchEvent(
            new CustomEvent("shax:block-action", {
              detail: { pty: ptyIdRef.current, blockId: currentId, kind: action.kind },
            }),
          );
        }
        return;
      case "collapse":
        // h / ArrowLeft: widget owns file-collapse when
        // it has a focused file; otherwise collapse the
        // whole block.
        if (currentId !== null) {
          if (dispatchWidgetNav(currentId, "left")) return;
          window.dispatchEvent(
            new CustomEvent("shax:block-action", {
              detail: { pty: ptyIdRef.current, blockId: currentId, kind: action.kind },
            }),
          );
        }
        return;
      case "expand":
        // l / ArrowRight: same but for expand.
        if (currentId !== null) {
          if (dispatchWidgetNav(currentId, "right")) return;
          window.dispatchEvent(
            new CustomEvent("shax:block-action", {
              detail: { pty: ptyIdRef.current, blockId: currentId, kind: action.kind },
            }),
          );
          // After the row expands, the captured output appears
          // below the header — likely pushing the block's
          // bottom past the BlockList's visible area when the
          // focused block was already at the bottom. Two rAFs
          // so React commits + layout settles, then ensure the
          // whole block is on-screen.
          const idToScroll = currentId;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              ensureBlockVisible(idToScroll);
            });
          });
        }
        return;
    }
  };

  /** True when an app-level overlay (search, block viewer
   *  modal) is open. The block-focus keymap must not swallow
   *  keys while the user is interacting with one of those —
   *  e.g. typing into the search box would otherwise trigger
   *  `j` → advance-down. We check the DOM rather than thread a
   *  prop because the overlays are App-level state and
   *  TerminalPane shouldn't need a wider awareness. */
  const overlayIsOpen = (): boolean =>
    document.querySelector('[data-testid="search-overlay"]') !== null ||
    document.querySelector('[data-testid="block-viewer-modal"]') !== null ||
    document.querySelector('[data-testid="safety-gate"]') !== null ||
    document.querySelector('[data-testid="settings-modal"]') !== null;
  // Note: the assistant overlay is deliberately NOT in this
  // list. It's a right-side *panel*, not a blocking modal —
  // the terminal stays visible and interactive on its left.
  // We only bail on keys whose event target is inside the
  // overlay itself (see `eventTargetIsInsideAssistant` below),
  // so typing into the chat doesn't drive block-focus but
  // `Ctrl+J` / vim motion in the pane still works while the
  // panel is open.

  /** True when the keydown originated inside the assistant
   *  overlay's DOM subtree — i.e. the user is typing into the
   *  chat panel, not the terminal. In that case we don't want
   *  block-focus to intercept: `j` in the message textarea
   *  should stay `j`, not "advance block down". */
  const eventTargetIsInsideAssistant = (e: KeyboardEvent): boolean => {
    const target = e.target;
    if (!(target instanceof Element)) return false;
    return target.closest('[data-testid="assistant-overlay"]') !== null;
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!activeRef.current) return;
      // Hand off to the overlay's own keymap. This applies to
      // `Ctrl+J` too: a user inside the search input probably
      // doesn't want it to also re-engage block-focus on the
      // pane behind the backdrop.
      if (overlayIsOpen()) return;
      // The assistant overlay is a side panel — don't bail
      // globally, but do bail when the key event started
      // inside its textarea / bubbles so typing there doesn't
      // trigger block-focus.
      if (eventTargetIsInsideAssistant(e)) return;
      // Ctrl+J enters block-focus mode from the prompt; also
      // exits when already in it (symmetric toggle). We swallow
      // the keystroke so xterm doesn't see a literal `\n`.
      const isCtrlJ = e.key === "j" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (isCtrlJ) {
        e.preventDefault();
        e.stopPropagation();
        if (blockFocusRef.current) {
          exitBlockFocus();
          return;
        }
        const ids = navigableIds();
        const latest = ids[ids.length - 1];
        if (latest === undefined) return; // nothing to focus
        setBlockFocus(true);
        selectBlock(latest);
        return;
      }
      // Other keys only intercept while in block-focus mode OR
      // while a block is maximised — the maximised block owns
      // the pane visually, so every visible key should route
      // there too (j/k/etc. scroll its content).
      if (!blockFocusRef.current && maximizedBlockIdRef.current === null) return;
      const { action, state: nextChord } = dispatchBlockKey(
        {
          key: e.key,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
        },
        chordStateRef.current,
      );
      chordStateRef.current = nextChord;
      if (action.kind === "noop") {
        // Block-focus is a modal state — keys the dispatcher
        // doesn't map should NOT fall through to the prompt.
        // Eat any bare-key noop so letters / numbers / punct
        // typed while a block is focused don't echo into the
        // shell. Keys carrying a system modifier (Cmd / Ctrl /
        // Alt) pass through so `Cmd+T` new tab, `Cmd+/` split,
        // etc. still work.
        const hasSystemModifier = e.metaKey || e.ctrlKey || e.altKey;
        if (!hasSystemModifier || nextChord.pendingG) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      performAction(action);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs cover the changing state
  }, []);

  // When this pane loses `active` (tab switch, focus moves to a
  // sibling pane), drop out of block-focus so the next pane
  // doesn't inherit a stale mode.
  useEffect(() => {
    if (!active && blockFocus) {
      setBlockFocus(false);
      selectBlock(null);
      chordStateRef.current = INITIAL_KEY_STATE;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Route clicks to a coherent block-focus state. Two bugs
  // this fixes:
  //   1. Ctrl+J engaged block-focus, then the user clicked the
  //      prompt to type — block-focus stayed on, so Tab / f /
  //      Enter were still hijacked by the block-focus handler
  //      even though the prompt visibly had focus.
  //   2. The user clicked a block to interact with it, expected
  //      it to be the active surface, but block-focus stayed
  //      off — so Tab / f / Enter fell through to the prompt.
  // A click inside a block row engages block-focus and selects
  // that block; a click anywhere else in the pane exits it.
  // Fires in capture phase so we win against the block row's
  // own onClick (which only wants selection, not focus).
  useEffect(() => {
    const root = paneRootRef.current;
    if (root === null) return;
    const onMouseDown = (e: MouseEvent): void => {
      // Ignore synthetic / non-primary clicks. Left-button only.
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target === null) return;
      // The BlockViewerModal renders under document.body via a
      // portal-ish absolute positioning; those clicks don't
      // reach us here. Search overlay is the same. So we don't
      // need to guard against them explicitly.
      const blockEl = target.closest<HTMLElement>("[data-block-id]");
      if (blockEl !== null) {
        const id = blockEl.getAttribute("data-block-id");
        if (id !== null) {
          selectBlock(id);
          if (!blockFocusRef.current) setBlockFocus(true);
        }
        return;
      }
      // Click outside any block — prompt strip, meta chrome,
      // empty pane area. Exit block-focus so the surface the
      // user just clicked can consume keys normally, and clear
      // the row highlight — a lingering blue ring on a row the
      // user has explicitly stepped away from reads as noise,
      // not context.
      if (blockFocusRef.current) {
        setBlockFocus(false);
        chordStateRef.current = INITIAL_KEY_STATE;
      }
      selectBlock(null);
    };
    root.addEventListener("mousedown", onMouseDown, true);
    return () => root.removeEventListener("mousedown", onMouseDown, true);
  }, []);

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

    // Race guard: if the pane is closed (or React StrictMode runs the
    // double-mount dance) before spawn resolves, we still want to kill
    // the freshly-minted PTY so it doesn't outlive its UI. We also flip
    // this true early so the channel handler below ignores anything the
    // now-doomed PTY emits — without that, the kill we issue triggers
    // a `PtyEvent::Exit` that lands in the *surviving* mount's reducer
    // and pops a spurious "Shell exited with code 1" banner on every
    // freshly-opened tab or pane.
    let cancelled = false;

    // Route IPC events: output bytes go to xterm; block-lifecycle and
    // alt-screen events go to the reducer.
    const handleEvent = (event: PtyEvent): void => {
      // The cleanup of this effect (StrictMode rerun, restart, real
      // unmount) flips `cancelled` true. The PTY tied to this handler
      // is being torn down or has already been killed; ignore its
      // trailing events instead of mutating state that belongs to the
      // next mount.
      if (cancelled) return;
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
          // Notify listeners: this block just finished. Pop
          // the FIFO queue of pending emit sources — if
          // non-empty, this block was emitted by whatever
          // pushed the front entry (widget, AI, palette). If
          // empty, it was a user-typed command, which should
          // freeze any live widgets and never be treated as a
          // tool result.
          {
            const source: "widget" | "ai" | "palette" | "user" =
              pendingEmitSourcesRef.current.shift() ?? "user";
            window.dispatchEvent(
              new CustomEvent("shax:block-complete", {
                detail: {
                  paneId: ptyIdRef.current,
                  blockId: event.block_id,
                  source,
                },
              }),
            );
          }
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

        case "scrollback_cleared":
          // Shell emitted `CSI 3 J` — the wire signal for `clear`,
          // `Ctrl+L`, or any alias with the same effect. Wipe the
          // visible block list without touching the store; the
          // cleared blocks stay searchable via the overlay.
          dispatch({ type: "scrollback_cleared" });
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

    void spawnPty({ rows: terminal.rows, cols: terminal.cols }, handleEvent).then((id) => {
      if (cancelled) {
        void killPty(id);
        return;
      }
      ptyIdRef.current = id;
      setPtyId(id);
      // Panes start blank (M7 slice 4). Historical blocks live in the
      // store and surface through the search overlay; the pane's own
      // list only shows commands run in this session.
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
  const onPtyIdChangeRef = useRef(onPtyIdChange);
  useEffect(() => {
    onMetaChangeRef.current = onMetaChange;
  }, [onMetaChange]);
  useEffect(() => {
    onAltScreenChangeRef.current = onAltScreenChange;
  }, [onAltScreenChange]);
  useEffect(() => {
    onPtyIdChangeRef.current = onPtyIdChange;
  }, [onPtyIdChange]);
  useEffect(() => {
    onMetaChangeRef.current?.(cwd, branch);
  }, [cwd, branch]);
  useEffect(() => {
    onAltScreenChangeRef.current?.(altScreen);
  }, [altScreen]);
  useEffect(() => {
    onPtyIdChangeRef.current?.(ptyId);
  }, [ptyId]);

  // Focus management. Only the active pane claims focus, so background
  // tabs don't pull keystrokes away from the user's currently-visible
  // tab. `exitedCode` is in the dep list so that clicking "Restart
  // shell" — which clears the banner and re-renders the prompt strip
  // — also re-fires this effect and lands focus back in the strip the
  // user is about to type into. Without this, the user has to click
  // the strip first.
  useEffect(() => {
    if (!active) return;
    if (exitedCode !== null) return; // banner showing; the strip isn't even mounted
    if (altScreen) {
      terminalRef.current?.focus();
    } else {
      promptStripRef.current?.focus();
    }
  }, [active, altScreen, exitedCode]);

  // App-level overlays (search, viewer modal) steal focus into their
  // input / button when they open. When they close, no DOM element is
  // focused and the user has to click the pane to type again. App
  // fires `shax:refocus-pane` on close; the active pane listens and
  // re-claims its strip / xterm.
  useEffect(() => {
    if (!active || exitedCode !== null) return;
    const handler = (): void => {
      if (altScreen) {
        terminalRef.current?.focus();
      } else {
        promptStripRef.current?.focus();
      }
    };
    window.addEventListener("shax:refocus-pane", handler);
    return () => window.removeEventListener("shax:refocus-pane", handler);
  }, [active, altScreen, exitedCode]);

  // Widgets that trigger side effects (git status widget's
  // stage / unstage, ls widget's cd) emit `shax:emit-command`
  // events per spec §08's visible-command rule: instead of
  // mutating state silently, the widget dispatches the command
  // it wants run and this pane writes it to its own PTY as if
  // the user typed it. Newline is appended so the shell runs
  // it; the scrollback captures the command the way OSC 133
  // does for anything typed at the prompt, keeping the log
  // honest.
  //
  // Filtering by `paneId` so a widget in pane A doesn't
  // hijack pane B's shell. `paneId` is the caller's own view
  // of the target — for widgets rendered by the git-status /
  // git-diff formatters, it's `ctx.paneId`.
  // Widget-emit → block-complete correlation. Widgets need to
  // know when the command they just emitted has finished so
  // they can re-probe their structured data silently and
  // refresh in place (spec §08's "visible writes / silent
  // reads" model). We assume blocks complete in emit order
  // and pop the front of the queue as each `block_completed`
  // event arrives in the PTY handler below. Each entry
  // records which SOURCE emitted it (widget vs ai vs
  // palette) — the block-complete event forwards that tag so
  // downstream listeners (widget silent-refresh, assistant
  // tool-loop) can react appropriately.
  const pendingEmitSourcesRef = useRef<Array<"widget" | "ai" | "palette">>([]);

  // Post-M6-slice-1: the raw `shax:emit-command` no longer
  // reaches us directly. It's intercepted by the App-level
  // `SafetyGate` (spec §10), classified as
  // routine / destructive / ai, and — on approval —
  // re-dispatched as `shax:emit-command-approved`. That's the
  // event we act on. The chokepoint invariant: no PTY write
  // driven by an assistant, widget, or palette action skips
  // the gate. `source: "widget"` is the current mainline; AI
  // and palette sources arrive in later slices.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (
        e as CustomEvent<{ paneId: string; command: string; source: "widget" | "ai" | "palette" }>
      ).detail;
      if (detail?.paneId !== ptyIdRef.current) return;
      const id = ptyIdRef.current;
      if (id === null) return;
      // Track the source in a FIFO queue so `block_completed`
      // can tag the resulting event with the *actual* source
      // (widget silent-refresh vs assistant tool-result vs
      // palette). Missing source defaults to widget for
      // backward-compat with existing widget emits.
      pendingEmitSourcesRef.current.push(detail.source ?? "widget");
      void writePty(id, new TextEncoder().encode(`${detail.command}\n`));
    };
    window.addEventListener("shax:emit-command-approved", handler);
    return () => window.removeEventListener("shax:emit-command-approved", handler);
  }, []);

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
  // Stable identity (useCallback) so the ⌘⇧R keyboard effect below can
  // depend on it without re-binding the listener on every render.
  const handleRestart = useCallback((): void => {
    dispatch({ type: "reset" });
    setExitedCode(null);
    setRestartNonce((n) => n + 1);
  }, []);

  // ⌘⇧R (Ctrl+Shift+R elsewhere) restarts the shell — same as clicking
  // the banner button. Gated on `exitedCode !== null` so a stray
  // keystroke can't kill a running shell; the active-pane guard keeps
  // background panes from grabbing the shortcut. Listener stays mounted
  // only while both conditions hold; cleanup ensures we don't leak
  // handlers across pane transitions.
  useEffect(() => {
    if (!active || exitedCode === null) return;
    const handler = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key !== "R" && e.key !== "r") return;
      e.preventDefault();
      handleRestart();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, exitedCode, handleRestart]);

  const isInsideTauri = isTauriContext();

  return (
    <div
      data-testid="terminal-pane"
      ref={paneRootRef}
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
          <BlockList
            pty={ptyId}
            blocks={blockState.blocks}
            liveOutputs={blockState.liveOutputs}
            selectedBlockId={blockState.selectedBlockId}
            inspectedBlock={blockState.inspectedBlock}
            maximizedBlockId={maximizedBlockId}
            onToggleMaximize={(id) => {
              setMaximizedBlockId((prev) => (prev === id ? null : id));
              // Clicking ⛶ also selects the block — the key
              // handler scrolls *that* block's content, so the
              // selection has to point at it. (Pressing `f`
              // from block-focus mode already had the selection
              // right; this catches the click path.)
              dispatch({ type: "select_block", id });
            }}
            onSelectBlock={(id) => {
              // Click highlights the row but does NOT engage
              // block-focus mode — engaging it would silently
              // eat subsequent prompt keystrokes that overlap
              // with nav bindings (`j` for jq, etc.). Users who
              // want keyboard nav on a clicked block can press
              // Ctrl+J after the click.
              dispatch({ type: "select_block", id });
            }}
          />
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
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
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
              title="Restart shell (⌘⇧R)"
            >
              Restart shell
              <span style={{ opacity: 0.75, fontWeight: 500 }}>⌘⇧R</span>
            </button>
          </div>
        )}
      </div>
      {!altScreen && exitedCode === null && maximizedBlockId === null && (
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
