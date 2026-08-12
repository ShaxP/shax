/**
 * M12.4 — map a backend-detected language label to a Nerd Font DevIcons
 * codepoint + display name for the prompt-strip chip.
 *
 * Labels are the exact strings the shell shim emits (see
 * `_shax_detect_lang` in shax.zsh / shax.bash / shax.fish and the table
 * in specs/18-prompt-overhaul.md). Codepoints are DevIcons glyphs from
 * the Nerd Font bundled with Shax (JetBrainsMono Nerd Font); they
 * render as monochrome and inherit the surrounding `currentColor`.
 *
 * Unknown labels return `null` so the prompt strip renders no chip
 * rather than a mystery glyph.
 *
 * Rendering guidance for callers: apply
 * `font-family: "JetBrainsMono Nerd Font", var(--font-mono), monospace`
 * to the icon span so the Nerd Font is tried first for the glyph even
 * when the user's chosen font_family lacks the icons.
 */

export interface LanguageChip {
  /** The backend label, echoed back for `data-*` attributes and tests. */
  label: string;
  /** Nerd Font codepoint (single character). */
  icon: string;
  /** Human-facing name shown next to the icon in the chip. */
  displayName: string;
}

// The mapping table — kept in one place so a future addition is a
// single-line change. Order does not matter for lookup (Map semantics),
// but the entries are grouped by rough ecosystem for reading.
const CHIPS: readonly LanguageChip[] = [
  // Rust
  { label: "rust", icon: "", displayName: "rust" },
  // Node ecosystem — TypeScript wins over JavaScript in the shim's
  // ordering (tsconfig.json is checked first), so if the label is
  // "typescript" the tsconfig was present; if "node" then it wasn't.
  { label: "typescript", icon: "", displayName: "typescript" },
  { label: "node", icon: "", displayName: "node" },
  { label: "deno", icon: "", displayName: "deno" },
  // Python
  { label: "python", icon: "", displayName: "python" },
  // Go
  { label: "go", icon: "", displayName: "go" },
  // Ruby
  { label: "ruby", icon: "", displayName: "ruby" },
  // JVM
  { label: "java", icon: "", displayName: "java" },
  { label: "kotlin", icon: "", displayName: "kotlin" },
  // .NET
  { label: "csharp", icon: "", displayName: "c#" },
  // Apple platforms
  { label: "swift", icon: "", displayName: "swift" },
  // C-family (shim can't reliably distinguish C from C++, so one shared
  // chip labelled `c-cpp`; display shows "c/c++").
  { label: "c-cpp", icon: "", displayName: "c/c++" },
] as const;

const CHIP_BY_LABEL = new Map<string, LanguageChip>(CHIPS.map((chip) => [chip.label, chip]));

/** Look up the chip for a backend-emitted language label. Returns
 *  `null` for unknown labels (frontend renders no chip). Also returns
 *  `null` for `null` / empty inputs so callers can pass the raw
 *  `promptMeta.language` value without pre-guarding. */
export function languageChip(label: string | null | undefined): LanguageChip | null {
  if (label === null || label === undefined || label.length === 0) return null;
  return CHIP_BY_LABEL.get(label) ?? null;
}

/** All chips — exported for tests and for any future palette / picker
 *  UI that wants to enumerate the supported set. */
export const ALL_LANGUAGE_CHIPS: readonly LanguageChip[] = CHIPS;
