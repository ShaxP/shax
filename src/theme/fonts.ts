/**
 * Bundled font catalog (M10.3).
 *
 * The list of monospace families Shax ships. Each entry
 * carries the display name (shown in the M10.4 picker), the
 * canonical CSS `font-family` name that `fonts.css`'s
 * `@font-face` declared, and the licence / source URL surfaced
 * in the About screen.
 *
 * Users can also type a system-installed family name into
 * `preferences.appearance.font_family`. That value flows
 * through `--font-mono` verbatim and the fallback stack in
 * that variable ends in the OS monospace default, so an
 * unknown name still renders in *some* monospace face.
 */

export interface BundledFont {
  /** Display name shown in the M10.4 preferences picker. */
  displayName: string;
  /** CSS `font-family` value written into `--font-mono`. */
  cssFamily: string;
  /** SPDX-style licence identifier. */
  licence: string;
  /** Upstream URL, surfaced in the About screen. */
  source: string;
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  {
    displayName: "JetBrains Mono",
    cssFamily: "JetBrains Mono",
    licence: "OFL-1.1",
    source: "https://github.com/JetBrains/JetBrainsMono",
  },
  {
    displayName: "Fira Code",
    cssFamily: "Fira Code",
    licence: "OFL-1.1",
    source: "https://github.com/tonsky/FiraCode",
  },
  {
    displayName: "Cascadia Code",
    cssFamily: "Cascadia Code",
    licence: "OFL-1.1",
    source: "https://github.com/microsoft/cascadia-code",
  },
  {
    displayName: "Iosevka",
    cssFamily: "Iosevka",
    licence: "OFL-1.1",
    source: "https://github.com/be5invis/Iosevka",
  },
];

/**
 * Build the CSS `font-family` stack that gets written into
 * `--font-mono`. Puts the user's chosen family first, then
 * every bundled family as a fallback, and ends in the
 * OS monospace default so an unknown / mistyped preference
 * still renders in *some* monospace face.
 *
 * `chosen` is either a bundled family's `cssFamily` (from
 * `BUNDLED_FONTS`) or a system-installed family name the user
 * typed themselves. `null` selects the default (JetBrains
 * Mono).
 */
export function fontFamilyStack(chosen: string | null): string {
  const parts = new Set<string>();
  const quote = (name: string): string =>
    // Multi-word family names need quoting to be valid CSS
    // (`Fira Code` → `"Fira Code"`). Single-word names don't
    // strictly need it but quoting is harmless and simpler.
    /\s/.test(name) ? `"${name}"` : name;
  if (chosen !== null && chosen.length > 0) parts.add(quote(chosen));
  for (const bundled of BUNDLED_FONTS) parts.add(quote(bundled.cssFamily));
  // Nerd-Font variant of JetBrains Mono comes bundled from
  // M1 for prompt-strip icons + statusline glyphs. Include it
  // in the fallback stack so per-character font-fallback pulls
  // in devicon / powerline arrows even when the user picked
  // a non-Nerd-Font family like Fira Code — otherwise glyphs
  // used by prompt themes render as tofu.
  parts.add('"JetBrainsMono Nerd Font Mono"');
  parts.add('"JetBrainsMono Nerd Font"');
  // System fallback stack — same as the M7 default in tokens.css.
  parts.add("ui-monospace");
  parts.add("SFMono-Regular");
  parts.add('"SF Mono"');
  parts.add("Menlo");
  parts.add("Consolas");
  parts.add("monospace");
  return Array.from(parts).join(", ");
}
