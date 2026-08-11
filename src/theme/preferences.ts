/**
 * App-level preferences — thin wrapper around the Rust
 * `get_preferences` / `set_preferences` commands.
 *
 * Separate from `assistant/history.ts` and
 * `settings/config.ts` on purpose: theme + future UI knobs
 * aren't assistant-related and shouldn't share a fate with
 * assistant config corruption. Small file, small surface.
 */

import type { ThemePreference } from "./theme";

/** Default assistant dock width in pixels (M7.7a). Matches the old overlay
 * width so users don't feel a jump when the dock lands. Kept in sync with
 * `DEFAULT_ASSISTANT_DOCK_WIDTH` in `src-tauri/src/preferences.rs`. */
export const DEFAULT_ASSISTANT_DOCK_WIDTH = 420;

/** Default preset ids — kept in sync with
 *  `DEFAULT_LIGHT_THEME_ID` / `DEFAULT_DARK_THEME_ID` in
 *  `src-tauri/src/themes.rs`. */
export const DEFAULT_LIGHT_THEME_ID = "shax-light";
export const DEFAULT_DARK_THEME_ID = "shax-dark";

/** Bounds for `AppearancePreferences.font_size` — mirrors
 *  `MIN_FONT_SIZE` / `MAX_FONT_SIZE` in
 *  `src-tauri/src/preferences.rs`. */
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 24;
export const DEFAULT_FONT_SIZE = 13;

/**
 * The user's chosen line-editing mode for the shell prompt
 * (M12.2, spec §18 D2).
 *
 * - `"emacs"` (default) — the shim forces emacs bindings against
 *   any plugin that tries to install vi keys.
 * - `"vi"` — the shim sources the bundled `zsh-vi-mode` when the
 *   user's rc hasn't already loaded it, and registers a
 *   `zle-keymap-select` widget so the statusline can render a
 *   two-chip pill (COMMAND · INSERT / NORMAL / VISUAL).
 *
 * Mirrors `LineEditing` in `src-tauri/src/preferences.rs`.
 */
export type LineEditing = "emacs" | "vi";

/**
 * Appearance sub-block introduced in M10.1. Mirrors
 * `AppearancePreferences` in `src-tauri/src/preferences.rs`.
 * A pre-M10 `preferences.json` without this block deserialises
 * to defaults on the backend, so the field is always populated
 * when the frontend reads it.
 */
export interface AppearancePreferences {
  theme_light: string;
  theme_dark: string;
  font_family: string | null;
  font_size: number;
  ligatures: boolean;
  /** M12.2: how the user wants to edit the shell prompt line. */
  line_editing: LineEditing;
}

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme_light: DEFAULT_LIGHT_THEME_ID,
  theme_dark: DEFAULT_DARK_THEME_ID,
  font_family: null,
  font_size: DEFAULT_FONT_SIZE,
  ligatures: true,
  line_editing: "emacs",
};

export interface Preferences {
  theme: ThemePreference;
  /** True when the assistant dock was open at last save (M7.7a). */
  assistant_docked: boolean;
  /** Width in pixels of the assistant dock's right-side column (M7.7a). */
  assistant_dock_width: number;
  /** M10.1: theme preset + font choices. */
  appearance: AppearancePreferences;
}

const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  assistant_docked: false,
  assistant_dock_width: DEFAULT_ASSISTANT_DOCK_WIDTH,
  appearance: DEFAULT_APPEARANCE,
};

function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadPreferences(): Promise<Preferences> {
  if (!isTauriContext()) return DEFAULT_PREFERENCES;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Preferences>("get_preferences");
}

/**
 * Save preferences. Accepts a partial so a caller changing one field
 * (theme / dock state / dock width) doesn't have to know about the
 * others. Reads the current stored value first and merges — cheap
 * enough that we don't need a shared in-memory cache. Not concurrent-
 * write-safe, but Shax has a single UI thread writing these, so no
 * race in practice.
 */
export async function savePreferences(update: Partial<Preferences>): Promise<void> {
  if (!isTauriContext()) return;
  const current = await loadPreferences();
  const merged: Preferences = { ...current, ...update };
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_preferences", { preferences: merged });
}
