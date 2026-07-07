/**
 * Assistant config wrappers around the Rust
 * `get_assistant_config` / `set_assistant_config` commands.
 *
 * The config lives on disk (see `src-tauri/src/agent/config.rs`)
 * so restarts remember which lane the user picked. Kept
 * thin — the settings modal is the only caller today; the
 * chat surface (slice 4) will read the same to instantiate
 * the right provider at start-up.
 */

export type ClaudeLane = "api-key" | "subscription" | "none";

export interface AssistantConfig {
  provider: string;
  claude_lane: ClaudeLane;
  model: string | null;
}

const DEFAULT_CONFIG: AssistantConfig = {
  provider: "claude",
  claude_lane: "none",
  model: null,
};

function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getAssistantConfig(): Promise<AssistantConfig> {
  if (!isTauriContext()) return DEFAULT_CONFIG;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AssistantConfig>("get_assistant_config");
}

export async function setAssistantConfig(config: AssistantConfig): Promise<void> {
  if (!isTauriContext()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_assistant_config", { config });
}
