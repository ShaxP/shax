/**
 * Pure helpers for block-focus mode (M4 polish).
 *
 * Block-focus is the keyboard-driven mode where the user
 * interacts with the block list directly: arrow keys / vim
 * motion to navigate blocks, Enter to open the preview modal,
 * Tab to toggle FMT/RAW, etc. The default mode (prompt) sends
 * keys to the shell as normal.
 *
 * This module covers the *logic* — pick-next, pick-prev,
 * pick-first, pick-last, plus the smart-scroll decision (scroll
 * within the focused block first, advance to next block only
 * when at the edge). Wiring it to actual DOM elements lives
 * in `App.tsx`.
 *
 * Two reasons for the extracted module:
 *   1. Tests don't need React or jsdom.
 *   2. The reducer-style API ("given current focus + key, return
 *      the next focus") makes the state machine inspectable.
 */

export type BlockId = string;

export interface BlockIdsView {
  readonly ids: readonly BlockId[];
}

/** Compute the next block id when the user presses `j` / `↓` at
 *  the bottom of the currently focused block. Returns `null` if
 *  the focused block is already the last one (caller stays put;
 *  the existing block keeps focus). */
export function nextBlockId(view: BlockIdsView, current: BlockId | null): BlockId | null {
  if (current === null) return view.ids[0] ?? null;
  const idx = view.ids.indexOf(current);
  if (idx === -1) return view.ids[0] ?? null;
  return view.ids[idx + 1] ?? null;
}

/** Symmetric: previous block when `k` / `↑` is pressed at the
 *  top of the focused block. */
export function prevBlockId(view: BlockIdsView, current: BlockId | null): BlockId | null {
  if (current === null) return view.ids[view.ids.length - 1] ?? null;
  const idx = view.ids.indexOf(current);
  if (idx === -1) return view.ids[0] ?? null;
  return view.ids[idx - 1] ?? null;
}

/** First block in the list (oldest). `g g` / `Home`. */
export function firstBlockId(view: BlockIdsView): BlockId | null {
  return view.ids[0] ?? null;
}

/** Last block in the list (newest). `G` / `End`. */
export function lastBlockId(view: BlockIdsView): BlockId | null {
  return view.ids[view.ids.length - 1] ?? null;
}

/** Pixel slack to call a scroll position "at the edge". */
export const EDGE_PX = 4;

/** Decide what to do for a smart line-down keypress, given the
 *  focused block's scroll state. */
export interface ScrollFrame {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type SmartScrollAction =
  | { kind: "scroll-within"; deltaPx: number }
  | { kind: "advance"; direction: "next" | "prev" };

export function smartScrollDown(frame: ScrollFrame | null, linePx: number): SmartScrollAction {
  // No internal scroll container, or already at the bottom →
  // advance focus to the next block.
  if (frame === null) return { kind: "advance", direction: "next" };
  const atBottom = frame.scrollTop + frame.clientHeight >= frame.scrollHeight - EDGE_PX;
  if (atBottom) return { kind: "advance", direction: "next" };
  return { kind: "scroll-within", deltaPx: linePx };
}

export function smartScrollUp(frame: ScrollFrame | null, linePx: number): SmartScrollAction {
  if (frame === null) return { kind: "advance", direction: "prev" };
  const atTop = frame.scrollTop <= EDGE_PX;
  if (atTop) return { kind: "advance", direction: "prev" };
  return { kind: "scroll-within", deltaPx: -linePx };
}

/** What a top-level key press should do while block-focus mode is
 *  active. Returned by `dispatchBlockKey`. The App layer carries
 *  out the action (DOM scroll, focus change, modal open, etc.). */
export type BlockKeyAction =
  | { kind: "noop" }
  | { kind: "exit" }
  | { kind: "focus"; id: BlockId }
  | { kind: "advance-down" }
  | { kind: "advance-up" }
  | { kind: "page-down" }
  | { kind: "page-up" }
  | { kind: "scroll-top" }
  | { kind: "scroll-bottom" }
  | { kind: "first-block" }
  | { kind: "last-block" }
  | { kind: "open-modal" }
  | { kind: "toggle-fmt-raw" }
  | { kind: "toggle-maximize" }
  | { kind: "toggle-side-by-side" }
  | { kind: "yank" }
  | { kind: "collapse" }
  | { kind: "expand" };

export interface KeyState {
  /** Whether the previous keypress was `g`. Used for the `g g` chord. */
  readonly pendingG: boolean;
}

export const INITIAL_KEY_STATE: KeyState = { pendingG: false };

export interface KeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** Translate a keypress into a block-focus action.
 *
 *  Returns the chosen action *and* the next chord-tracking state.
 *  The caller resets `pendingG` between distinct keystrokes via
 *  the returned state — this keeps the chord logic testable
 *  without React refs. */
export function dispatchBlockKey(
  event: KeyEvent,
  state: KeyState,
): { action: BlockKeyAction; state: KeyState } {
  const { key, shiftKey } = event;
  // Esc always exits, regardless of pending chord.
  if (key === "Escape") {
    return { action: { kind: "exit" }, state: INITIAL_KEY_STATE };
  }
  // g g → first block. Anything other than `g` after `g` cancels
  // the chord but the second key is *not* consumed (so the user
  // can press `g j` and the `j` still navigates).
  if (state.pendingG) {
    if (key === "g") {
      return { action: { kind: "first-block" }, state: INITIAL_KEY_STATE };
    }
    // Cancel chord, but continue dispatching the new key.
    return dispatchBlockKey(event, INITIAL_KEY_STATE);
  }
  if (key === "g" && !shiftKey) {
    return { action: { kind: "noop" }, state: { pendingG: true } };
  }
  if ((key === "G" && shiftKey) || key === "End") {
    return { action: { kind: "last-block" }, state: INITIAL_KEY_STATE };
  }
  if (key === "Home") {
    return { action: { kind: "first-block" }, state: INITIAL_KEY_STATE };
  }
  if (key === "j" || key === "ArrowDown") {
    return { action: { kind: "advance-down" }, state: INITIAL_KEY_STATE };
  }
  if (key === "k" || key === "ArrowUp") {
    return { action: { kind: "advance-up" }, state: INITIAL_KEY_STATE };
  }
  // Vim-tree convention: `h` / `←` collapse the focused block,
  // `l` / `→` expand it. There's no sideways navigation in a
  // single-column block list, so the horizontal keys are free.
  if (key === "h" || key === "ArrowLeft") {
    return { action: { kind: "collapse" }, state: INITIAL_KEY_STATE };
  }
  if (key === "l" || key === "ArrowRight") {
    return { action: { kind: "expand" }, state: INITIAL_KEY_STATE };
  }
  // Space is the conventional pager step; vim's `Ctrl+F` also
  // pages down. `f` used to alias here but it's a much better
  // mnemonic for "fit to pane" — see `toggle-maximize` below.
  if (key === " ") {
    return { action: { kind: "page-down" }, state: INITIAL_KEY_STATE };
  }
  if (key === "b") {
    return { action: { kind: "page-up" }, state: INITIAL_KEY_STATE };
  }
  if (key === "Enter" || key === "o") {
    return { action: { kind: "open-modal" }, state: INITIAL_KEY_STATE };
  }
  if (key === "Tab") {
    return { action: { kind: "toggle-fmt-raw" }, state: INITIAL_KEY_STATE };
  }
  if (key === "f") {
    // Fit-to-pane: maximise the focused block within its pane.
    // Press `f` again or Esc to restore normal view. Navigation
    // is suspended while the block is maximised.
    return { action: { kind: "toggle-maximize" }, state: INITIAL_KEY_STATE };
  }
  if (key === "s") {
    // Widget-scoped: toggles side-by-side view on widgets that
    // support it (git diff today). Widgets listen for the
    // dispatched `shax:block-action` event and no-op if they
    // don't care about the key. Non-widget blocks see no
    // effect.
    return { action: { kind: "toggle-side-by-side" }, state: INITIAL_KEY_STATE };
  }
  if (key === "y") {
    return { action: { kind: "yank" }, state: INITIAL_KEY_STATE };
  }
  return { action: { kind: "noop" }, state: INITIAL_KEY_STATE };
}
