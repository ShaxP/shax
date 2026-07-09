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

export interface OllamaCapabilities {
  tools: boolean;
  vision: boolean;
}

export interface AssistantConfig {
  /** Active provider id. `"claude"` | `"ollama"` for M6. */
  provider: string;
  /** Which Claude lane is active when `provider === "claude"`. */
  claude_lane: ClaudeLane;
  /** Model override for the Claude provider. */
  claude_model: string | null;
  /** Model selection for the Ollama provider — required to
   *  make a request. */
  ollama_model: string | null;
  /** Cached per-model capabilities for the Ollama provider,
   *  probed via `/api/show` on model pick. Lets the sync
   *  provider factory declare tools / vision honestly for
   *  the selected model. `null` before we've probed. */
  ollama_capabilities: OllamaCapabilities | null;
}

const DEFAULT_CONFIG: AssistantConfig = {
  provider: "claude",
  claude_lane: "none",
  claude_model: null,
  ollama_model: null,
  ollama_capabilities: null,
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
