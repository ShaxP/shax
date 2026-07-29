/**
 * Read the current Tauri window's label.
 *
 * Scaffolding for the multi-window rollout (M9.1, spec §15).
 * Today the backend derives the calling window's identity from
 * the injected `WebviewWindow` on every command, so most IPC
 * wrappers don't need to pass a window id explicitly. This hook
 * exists for the pieces that eventually will — persistence
 * keyed by window on the frontend side (M9.2's state audit),
 * per-window preference overrides, and diagnostics that
 * distinguish which window emitted a log line.
 *
 * Returns a string rather than a branded `WindowId` type because
 * the frontend consumes it as an opaque identity — the branding
 * lives on the Rust side (`crate::mux::WindowId`) where it
 * catches "pass any string" bugs at command boundaries.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

/** True when running inside a Tauri webview host — same probe as
 *  `src/lib/ipc.ts`. Kept local so this module has no cross-file
 *  runtime deps. */
function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The label of the Tauri window this React root is rendered inside.
 *  Stable for the lifetime of the window — a fresh window gets a
 *  fresh label from `WebviewWindowBuilder` (M9.3), and the built-in
 *  "main" window always reports `"main"`.
 *
 *  Outside a Tauri context (jsdom tests, browser preview) this
 *  falls back to `"main"` so components that key behaviour on the
 *  window identity keep the primary-window branch — matching how
 *  the app behaved before multi-window landed. */
export function useWindowId(): string {
  if (!isTauriContext()) return "main";
  return getCurrentWindow().label;
}
