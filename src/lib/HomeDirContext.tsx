/**
 * Home-directory context (M7.6).
 *
 * Fetched once at App boot via the `home_dir` Tauri command and made
 * available to any deep component that displays a cwd. Consumers pass
 * the value to `compactCwd()` to render `~/dev/shax` instead of
 * `/Users/ada/dev/shax`.
 *
 * Defaults to `null` — during the boot probe window (and in test
 * environments without a Provider) consumers just show the raw path.
 */
import { createContext, useContext } from "react";

const HomeDirContext = createContext<string | null>(null);

export const HomeDirProvider = HomeDirContext.Provider;

/**
 * Read the current user's home directory from context. Returns `null`
 * when no Provider is above the caller or when the backend hasn't
 * resolved a value yet.
 */
export function useHomeDir(): string | null {
  return useContext(HomeDirContext);
}
