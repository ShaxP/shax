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

export interface Preferences {
  theme: ThemePreference;
}

const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
};

function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadPreferences(): Promise<Preferences> {
  if (!isTauriContext()) return DEFAULT_PREFERENCES;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Preferences>("get_preferences");
}

export async function savePreferences(preferences: Preferences): Promise<void> {
  if (!isTauriContext()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_preferences", { preferences });
}
