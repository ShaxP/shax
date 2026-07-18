/**
 * Assistant-dock context (M7.7b).
 *
 * Owned by App, consumed by any deep component that needs to know
 * whether the assistant dock is open. Used by `PromptStrip` to swap
 * its placeholder hint (`type a command, or ? to ask Shax` → `assistant
 * is working beside you`) and to disable the `?`-first-char shortcut
 * when the dock is already visible.
 *
 * Modelled on `HomeDirContext` — a tiny boolean context beats prop-
 * threading through Layout → TerminalPane → PromptStrip.
 */
import { createContext, useContext } from "react";

const AssistantDockContext = createContext<boolean>(false);

export const AssistantDockProvider = AssistantDockContext.Provider;

/** Read whether the assistant dock is currently open. Defaults to
 *  `false` when no Provider is above the caller — sane for tests. */
export function useAssistantDocked(): boolean {
  return useContext(AssistantDockContext);
}
