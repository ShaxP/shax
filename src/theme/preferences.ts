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

export interface Preferences {
  theme: ThemePreference;
  /** True when the assistant dock was open at last save (M7.7a). */
  assistant_docked: boolean;
  /** Width in pixels of the assistant dock's right-side column (M7.7a). */
  assistant_dock_width: number;
}

const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  assistant_docked: false,
  assistant_dock_width: DEFAULT_ASSISTANT_DOCK_WIDTH,
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
