/**
 * Modal layer stack — the app's single source of truth for
 * "which overlay currently owns the foreground?".
 *
 * Before this module, every overlay (search, viewer, safety
 * gate, settings, assistant, palette) registered its own
 * capture-phase `keydown` listener on `window`. When multiple
 * were up, every listener fired — `stopPropagation` doesn't
 * stop sibling capture-phase listeners on the same target — so
 * every overlay had to carry a defensive "bail if a
 * higher-priority overlay is up" allowlist. That's O(n²)
 * coupling: adding a new overlay meant auditing every existing
 * listener. Gaps happened.
 *
 * The stack fixes that with a single ordered list of layer
 * ids. Overlays call `useModalLayer(id)` — the hook pushes on
 * mount, pops on unmount. Any global keybinding starts with
 * `if (!isTopmostModalLayer(id)) return;`. One lookup, one
 * source of truth. Adding a new overlay is one line; adding a
 * new keybinding is one line.
 *
 * The stack lives at module scope on purpose: it's a global
 * property of the DOM (only one modal can meaningfully own the
 * keyboard at a time). React `useEffect` handles the lifecycle
 * but the store itself isn't React state — no re-renders on
 * push/pop, no context threading, works from event listeners
 * that don't have a React scope.
 *
 * Debug: `window.__shaxModalStack` mirrors the current stack so
 * a devtools inspect can answer "why isn't my key firing?".
 */

import { useEffect } from "react";

/** Canonical layer ids — kept as a union so a typo can't
 *  silently mis-register a layer. Add new overlays here.
 *
 *  The assistant dock is deliberately absent: it's a peer of
 *  the terminal pane, not a modal that owns the keyboard.
 *  Its own Escape handler reads `anyModalLayerOpen()` to know
 *  when to defer to whichever real modal is on top. */
export type ModalLayerId =
  | "search-overlay"
  | "block-viewer-modal"
  | "safety-gate"
  | "settings-modal"
  | "palette-overlay"
  | "confirm-close-modal"
  | "confirm-paste-modal";

const stack: ModalLayerId[] = [];

function publishDebugMirror(): void {
  if (typeof window === "undefined") return;
  (window as unknown as { __shaxModalStack: ModalLayerId[] }).__shaxModalStack = stack.slice();
}

/** Push a layer id on mount, pop on unmount. Call once per
 *  overlay component. The last push wins the "topmost" spot,
 *  which mirrors mount order — a new overlay opened while an
 *  older one is up automatically becomes the foreground.
 *
 *  `active` (default `true`) lets components with conditional
 *  modal state — e.g. `SafetyGate`, which always mounts but
 *  only renders its modal DOM when a proposal is pending —
 *  push/pop with the visibility rather than the mount. */
export function useModalLayer(id: ModalLayerId, active: boolean = true): void {
  useEffect(() => {
    if (!active) return;
    stack.push(id);
    publishDebugMirror();
    return () => {
      // Remove the most-recent occurrence of `id` — handles
      // the (rare) case of the same layer id being open twice.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === id) {
          stack.splice(i, 1);
          break;
        }
      }
      publishDebugMirror();
    };
  }, [id, active]);
}

/** True when `id` is the current topmost layer. Global
 *  keybindings inside an overlay's `useEffect` start with
 *  `if (!isTopmostModalLayer(id)) return;`. */
export function isTopmostModalLayer(id: ModalLayerId): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** True when *any* modal layer is currently mounted. Used by
 *  non-overlay code (like TerminalPane's block-focus keymap)
 *  that wants to surrender the keyboard whenever the
 *  foreground is owned by an overlay — regardless of which. */
export function anyModalLayerOpen(): boolean {
  return stack.length > 0;
}

/** Snapshot of the current stack (top-most last). For tests
 *  and diagnostics. Never mutate this from callers. */
export function _modalLayerStackForTests(): readonly ModalLayerId[] {
  return stack.slice();
}

/** Test hook — wipe the stack so tests don't leak state
 *  across cases. Not exported for production use. */
export function _resetModalLayersForTests(): void {
  stack.length = 0;
  publishDebugMirror();
}
