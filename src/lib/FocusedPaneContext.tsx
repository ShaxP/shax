/**
 * FocusedPaneContext — the meta of the pane that currently owns
 * focus in the active tab. Any surface that needs to reflect
 * "what pane is the user typing into?" reads this.
 *
 * M13.2 sidebar's GitBranchWidget is the first consumer. Future
 * sidebar widgets (Phase 2) that show per-focused-pane state
 * (cwd, language, kubectl context resolved from the pane's env)
 * will read the same signal.
 *
 * `null` means no pane is focused (empty window, all tabs closed,
 * hydrate not yet resolved). Widgets treat null as "hide me."
 *
 * Same shape as `AssistantDockContext` / `HomeDirContext`. The
 * provider lives once in App.tsx, wrapping the render tree with
 * the `activeFocused` value that App already computes.
 */

import { createContext, useContext } from "react";

export interface FocusedPaneMeta {
  /** Backend PTY id, or null before spawn resolves / after exit. */
  ptyId: string | null;
  /** Working directory of the pane, or null before first OSC 133 A. */
  cwd: string | null;
  /** Git branch, or null when the cwd isn't a repo. */
  branch: string | null;
  /** Commits the branch is ahead of upstream, or null when unknown. */
  ahead: number | null;
  /** Commits the branch is behind upstream, or null when unknown. */
  behind: number | null;
}

export const FocusedPaneContext = createContext<FocusedPaneMeta | null>(null);

export const FocusedPaneProvider = FocusedPaneContext.Provider;

/** Subscribe to the focused pane's meta. Returns null when no
 *  pane is currently focused; widgets should render nothing. */
export function useFocusedPane(): FocusedPaneMeta | null {
  return useContext(FocusedPaneContext);
}
