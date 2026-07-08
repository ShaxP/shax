/**
 * Chat history persistence — thin wrapper around the Rust
 * commands defined in `src-tauri/src/agent/history.rs`.
 *
 * The overlay loads on mount, saves after each turn
 * completes, and clears when the user clicks "New" in the
 * header.
 */

export interface ChatTurn {
  /** `"user"` | `"assistant"` | `"error"`. String rather
   *  than a union so future roles from newer Shax versions
   *  don't reject on load. */
  role: string;
  content: string;
  /** Unix-epoch milliseconds. */
  created_ms: number;
}

export interface ChatHistory {
  turns: ChatTurn[];
}

const EMPTY: ChatHistory = { turns: [] };

function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadChatHistory(): Promise<ChatHistory> {
  if (!isTauriContext()) return EMPTY;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ChatHistory>("get_chat_history");
}

export async function saveChatHistory(history: ChatHistory): Promise<void> {
  if (!isTauriContext()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_chat_history", { history });
}

export async function clearChatHistory(): Promise<void> {
  if (!isTauriContext()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("clear_chat_history");
}
