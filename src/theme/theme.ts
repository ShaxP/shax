/**
 * Theme applier — resolves the user's Preferences (M7 mode
 * + M10 preset choice) to a concrete preset from the catalog,
 * writes its palette as CSS custom properties on `:root`, and
 * sets `data-theme` for selectors that still key off it.
 *
 * Three theme modes (from M7):
 *   - `"dark"`   — always use `preferences.appearance.theme_dark`.
 *   - `"light"`  — always use `preferences.appearance.theme_light`.
 *   - `"system"` — track `prefers-color-scheme`. Re-resolves
 *     when the OS setting flips.
 *
 * The M10.1 catalog is a fixed set of presets loaded once from
 * `list_themes()` and passed to `applyTheme` on every apply.
 * A `null`/empty catalog is a legitimate boot state (Tauri
 * hasn't answered yet, or we're in plain browser dev) — the
 * function no-ops and the tokens.css `:root` fallback remains
 * in effect until the catalog arrives.
 *
 * Downstream consumers (xterm via `readXtermTheme`, hljs code
 * fences via `.hljs-*` rules, chrome via `var(--…)`) all read
 * from the CSS custom properties this file writes — no direct
 * dependency on the resolver. Preference changes propagate
 * through the existing `shax:preference-changed` event that
 * `App.tsx` re-emits.
 */

import type { Theme } from "../lib/ipc";
import { fontFamilyStack } from "./fonts";
import type { Preferences } from "./preferences";

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

/** Resolve a Preferences.theme mode to the concrete preset id
 *  the user wants active right now, given the current OS
 *  preference. Kept pure for tests. */
export function resolveActivePresetId(preferences: Preferences, systemMode: ResolvedTheme): string {
  const { theme, appearance } = preferences;
  if (theme === "light") return appearance.theme_light;
  if (theme === "dark") return appearance.theme_dark;
  return systemMode === "dark" ? appearance.theme_dark : appearance.theme_light;
}

/** Find a preset in the catalog by id. Returns `null` when the
 *  catalog is empty (boot race) or the id doesn't resolve — a
 *  preferences.json referencing a renamed preset falls through
 *  to the tokens.css :root fallback rather than crashing. */
export function findPreset(catalog: readonly Theme[], id: string): Theme | null {
  return catalog.find((t) => t.id === id) ?? null;
}

let mediaQueryListener: ((e: MediaQueryListEvent) => void) | null = null;
let mediaQuery: MediaQueryList | null = null;

/**
 * Apply the resolved preset to the document. Writes:
 *   - `preset.chrome[k]` as `--k` custom properties on `:root`.
 *   - Every ANSI colour as `--ansi-{kebab-case-name}` so
 *     `readXtermTheme` and `<AnsiSpans>` (both existing
 *     M7-era consumers) pick them up without changing.
 *   - Every syntax colour as `--syntax-{name}` for the hljs
 *     rules in `syntax.css`.
 *   - `data-theme` on `<html>` = the preset's `mode`, so
 *     any selector still keyed off `[data-theme=…]` keeps
 *     working (M7 code that hasn't migrated yet).
 *
 * A `"system"` preference also (re)binds the matchMedia
 * listener so an OS-level flip re-applies the resolved
 * preset live. Any other mode detaches the listener.
 *
 * Safe to call every time preferences change. Idempotent
 * given the same inputs — writing the same value to
 * `style.setProperty` doesn't trigger a repaint if the
 * computed value is unchanged.
 */
export function applyTheme(preferences: Preferences, catalog: readonly Theme[]): void {
  if (typeof document === "undefined") return;
  detachSystemListener();
  writeResolvedTheme(preferences, catalog);
  if (preferences.theme === "system") attachSystemListener(preferences, catalog);
}

/** The DOM-writing half of applyTheme, extracted so the
 *  system-mode matchMedia listener can re-apply on an OS flip
 *  WITHOUT going through detach/reattach. Re-attaching during
 *  the matchMedia listener callback re-enters the Set that
 *  triggered the callback in the first place and loops
 *  forever under V8's insertion-order Set iterator. */
function writeResolvedTheme(preferences: Preferences, catalog: readonly Theme[]): void {
  const systemMode = systemTheme();
  const presetId = resolveActivePresetId(preferences, systemMode);
  const preset = findPreset(catalog, presetId);
  if (preset !== null) {
    writePresetToRoot(preset);
    document.documentElement.setAttribute("data-theme", preset.mode);
  } else {
    // No catalog yet (Tauri IPC not resolved) or unknown id —
    // fall back to the M7 behaviour of just setting data-theme
    // from the resolved mode. tokens.css `:root` covers the
    // rest as the pre-JS default.
    document.documentElement.setAttribute("data-theme", systemMode);
  }
  writeAppearanceToRoot(preferences);
}

/** Write the M10.3 appearance settings — font family, font
 *  size — as CSS custom properties on `:root`. Kept separate
 *  from `writePresetToRoot` because these values come from
 *  the appearance block (user's choice), not from the active
 *  preset. Ligatures are xterm-addon lifecycle and don't
 *  translate to a CSS variable — see TerminalPane.
 *
 *  `--font-mono` is the stack used by xterm + CodeMirror. The
 *  user's chosen family sits first; every bundled family and
 *  the OS fallback stack follow. `--font-size-terminal` is a
 *  bare number of CSS pixels — xterm consumes it via
 *  `readXtermTheme` (or reads it off the preferences payload
 *  in M10.4). */
function writeAppearanceToRoot(preferences: Preferences): void {
  const root = document.documentElement.style;
  root.setProperty("--font-mono", fontFamilyStack(preferences.appearance.font_family));
  root.setProperty("--font-size-terminal", `${preferences.appearance.font_size}px`);
  // M10.5: derived scale tokens for secondary mono surfaces
  // (formatters, block-list preview, metadata line, markdown
  // code fences and inline code). Ratios preserve the design
  // hierarchy — secondary content sits deliberately smaller
  // than the terminal — while letting everything scale
  // together when the user bumps the base size.
  root.setProperty("--font-size-secondary", `calc(var(--font-size-terminal) * 0.92)`);
  root.setProperty("--font-size-compact", `calc(var(--font-size-terminal) * 0.85)`);
  // Ligatures on the DOM renderer come from the browser's own
  // text engine (`font-variant-ligatures`) and, when set
  // inline by consumers like xterm, from `font-feature-
  // settings`. Per the CSS Fonts spec, feature-settings
  // OVERRIDES variant-*, so we must write both to cover the
  // full cascade. tokens.css's `:root, .xterm` rule reads
  // these and inherits them to every descendant. The xterm
  // options path (`fontFeatureSettings` in TerminalPane) is a
  // parallel mechanism for the DOM renderer's own inline
  // write — the CSS var is what other mono surfaces (prompt
  // strip, code viewer, formatters, palette, ...) read.
  const on = preferences.appearance.ligatures;
  root.setProperty("--terminal-ligatures", on ? "normal" : "none");
  root.setProperty("--terminal-font-features", on ? "normal" : '"liga" 0, "clig" 0, "calt" 0');
}

function writePresetToRoot(preset: Theme): void {
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(preset.chrome)) {
    root.setProperty(`--${name}`, value);
  }
  const ansi = preset.terminal.ansi;
  root.setProperty("--ansi-black", ansi.black);
  root.setProperty("--ansi-red", ansi.red);
  root.setProperty("--ansi-green", ansi.green);
  root.setProperty("--ansi-yellow", ansi.yellow);
  root.setProperty("--ansi-blue", ansi.blue);
  root.setProperty("--ansi-magenta", ansi.magenta);
  root.setProperty("--ansi-cyan", ansi.cyan);
  root.setProperty("--ansi-white", ansi.white);
  root.setProperty("--ansi-bright-black", ansi.brightBlack);
  root.setProperty("--ansi-bright-red", ansi.brightRed);
  root.setProperty("--ansi-bright-green", ansi.brightGreen);
  root.setProperty("--ansi-bright-yellow", ansi.brightYellow);
  root.setProperty("--ansi-bright-blue", ansi.brightBlue);
  root.setProperty("--ansi-bright-magenta", ansi.brightMagenta);
  root.setProperty("--ansi-bright-cyan", ansi.brightCyan);
  root.setProperty("--ansi-bright-white", ansi.brightWhite);
  const s = preset.syntax;
  root.setProperty("--syntax-comment", s.comment);
  root.setProperty("--syntax-keyword", s.keyword);
  root.setProperty("--syntax-string", s.string);
  root.setProperty("--syntax-number", s.number);
  root.setProperty("--syntax-literal", s.literal);
  root.setProperty("--syntax-builtin", s.builtin);
  root.setProperty("--syntax-name", s.name);
  root.setProperty("--syntax-title", s.title);
  root.setProperty("--syntax-type", s.type);
  // xterm consumers read `--fg-terminal` / `--bg-terminal`
  // when a preset ships terminal-specific overrides distinct
  // from the chrome foreground / background. Kept aliased to
  // the general chrome tokens if the preset didn't split them.
  root.setProperty("--bg-terminal", preset.terminal.background);
  root.setProperty("--fg-terminal", preset.terminal.foreground);
  root.setProperty("--cursor", preset.terminal.cursor);
  root.setProperty("--selection", preset.terminal.selectionBackground);
}

function attachSystemListener(preferences: Preferences, catalog: readonly Theme[]): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
  mediaQueryListener = (): void => {
    // Re-apply CSS vars + data-theme WITHOUT going through
    // applyTheme's detach/reattach — see the note on
    // `writeResolvedTheme`. Passing the same preferences +
    // catalog is intentional: only `systemTheme()` changed,
    // and we want the resolver to pick up the new value.
    writeResolvedTheme(preferences, catalog);
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
