/**
 * Frontend platform sniffing.
 *
 * Shax has no `@tauri-apps/plugin-os` dependency; the one place that
 * already needed to tell macOS apart from everything else
 * (`TitleBar.tsx`, traffic-light inset) does it via a `navigator.userAgent`
 * regex. `detectPlatform` generalises that same approach to the three-way
 * split the M13.4 caffeinate widget needs (macOS / Linux native shell
 * command, Windows disabled state).
 *
 * Pure function of the user-agent string so tests can drive every branch
 * without stubbing `navigator` globally.
 */

export type Platform = "macos" | "linux" | "windows" | "other";

export function detectPlatform(userAgent: string): Platform {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Mac|iPhone|iPad/i.test(userAgent)) return "macos";
  if (/Linux/i.test(userAgent)) return "linux";
  return "other";
}

/** Convenience wrapper reading the real browser/webview user agent.
 *  Falls back to `"other"` outside a browser context (SSR, some test
 *  harnesses) the same way `TitleBar.tsx`'s `IS_MAC` falls back to
 *  `false`. */
export function currentPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  return detectPlatform(navigator.userAgent);
}
