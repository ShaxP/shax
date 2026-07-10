/**
 * Theme applier — resolves a `ThemePreference` to a concrete
 * `"dark" | "light"` and writes it to
 * `document.documentElement`'s `data-theme` attribute, which
 * `tokens.css` uses to switch palettes.
 *
 * Three preferences:
 *   - `"dark"` — always dark, regardless of OS.
 *   - `"light"` — always light.
 *   - `"system"` — track `prefers-color-scheme`. Re-resolves
 *     on the fly when the OS setting flips (macOS auto-
 *     schedule, Linux GTK preference toggle, etc.).
 *
 * The applier maintains a single active listener on the
 * media query. Switching from `system` to `dark`/`light`
 * removes it; switching back adds it.
 */

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

/** Read the current OS preference. Falls back to `"dark"`
 *  when `matchMedia` is unavailable (tests, older environments). */
export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Resolve a preference to the concrete theme that should be
 *  applied. `"system"` maps to whatever the OS reports. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return systemTheme();
  return preference;
}

let mediaQueryListener: ((e: MediaQueryListEvent) => void) | null = null;
let mediaQuery: MediaQueryList | null = null;

/** Apply a preference to the document — sets the
 *  `data-theme` attribute and (when the preference is
 *  `"system"`) subscribes to `prefers-color-scheme` changes. */
export function applyTheme(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  detachSystemListener();
  const resolved = resolveTheme(preference);
  document.documentElement.setAttribute("data-theme", resolved);
  if (preference === "system") attachSystemListener();
}

function attachSystemListener(): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
  mediaQueryListener = (e: MediaQueryListEvent): void => {
    document.documentElement.setAttribute("data-theme", e.matches ? "light" : "dark");
  };
  mediaQuery.addEventListener("change", mediaQueryListener);
}

function detachSystemListener(): void {
  if (mediaQuery !== null && mediaQueryListener !== null) {
    mediaQuery.removeEventListener("change", mediaQueryListener);
  }
  mediaQuery = null;
  mediaQueryListener = null;
}
