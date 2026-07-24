/**
 * Derive an xterm.js `ITheme` from the app's CSS design tokens
 * (M7 loose-end cleanup).
 *
 * xterm.js accepts a `theme` option at construction and via
 * `terminal.options.theme = …` at runtime. It expects concrete
 * colour strings — CSS variables aren't resolved for us, so we
 * read the app's `--fg`, `--bg`, and `--ansi-*` tokens through
 * `getComputedStyle` on a throwaway element. That element's
 * computed `color` collapses whatever the token points at
 * (oklch, hex, rgb, …) into a canonical `rgb()` string the
 * canvas renderer inside xterm handles reliably.
 *
 * Call once at Terminal construction and again whenever the
 * theme changes (`shax:preference-changed`). The whole
 * operation is a handful of DOM reads — cheap.
 */

import type { ITheme } from "@xterm/xterm";

const ANSI_KEYS = [
  ["black", "--ansi-black"],
  ["red", "--ansi-red"],
  ["green", "--ansi-green"],
  ["yellow", "--ansi-yellow"],
  ["blue", "--ansi-blue"],
  ["magenta", "--ansi-magenta"],
  ["cyan", "--ansi-cyan"],
  ["white", "--ansi-white"],
  ["brightBlack", "--ansi-bright-black"],
  ["brightRed", "--ansi-bright-red"],
  ["brightGreen", "--ansi-bright-green"],
  ["brightYellow", "--ansi-bright-yellow"],
  ["brightBlue", "--ansi-bright-blue"],
  ["brightMagenta", "--ansi-bright-magenta"],
  ["brightCyan", "--ansi-bright-cyan"],
  ["brightWhite", "--ansi-bright-white"],
] as const satisfies ReadonlyArray<readonly [keyof ITheme, string]>;

/** Read a CSS custom property, resolved via `getComputedStyle`
 *  on a probe element, so oklch/hex/rgb tokens all come back as
 *  a canonical `rgb()` string. Returns an empty string if the
 *  DOM isn't available (SSR / early boot). */
function readVar(probe: HTMLElement, varName: string): string {
  probe.style.color = `var(${varName})`;
  return getComputedStyle(probe).color;
}

/** Build an `ITheme` for xterm.js from the current CSS tokens.
 *  Safe to call whenever the theme might have changed. Returns
 *  `null` if we're not in a browser (no `document`), so the
 *  caller can fall through to xterm's built-in defaults. */
export function readXtermTheme(): ITheme | null {
  if (typeof document === "undefined") return null;
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  try {
    const ansiEntries = Object.fromEntries(
      ANSI_KEYS.map(([key, varName]) => [key, readVar(probe, varName)]),
    ) as Pick<
      ITheme,
      | "black"
      | "red"
      | "green"
      | "yellow"
      | "blue"
      | "magenta"
      | "cyan"
      | "white"
      | "brightBlack"
      | "brightRed"
      | "brightGreen"
      | "brightYellow"
      | "brightBlue"
      | "brightMagenta"
      | "brightCyan"
      | "brightWhite"
    >;
    const theme: ITheme = {
      background: readVar(probe, "--bg"),
      foreground: readVar(probe, "--fg"),
      cursor: readVar(probe, "--fg"),
      cursorAccent: readVar(probe, "--bg"),
      selectionBackground: readVar(probe, "--accent-soft"),
      ...ansiEntries,
    };
    return theme;
  } finally {
    probe.remove();
  }
}
