/**
 * Panel for the "Sidebar: expand / collapse" palette command.
 *
 * Fire-and-forget: on mount, dispatch `shax:toggle-sidebar` on the
 * window and immediately close the palette. No IPC, no async — the
 * App-level event listener flips the sidebar state synchronously.
 *
 * Mirrors `builtins/newWindow/NewWindowPanel.tsx` in shape but skips
 * the async state machine (there's nothing that can fail).
 */

import { useEffect } from "react";
import type { PaneContext } from "../../registry";

export interface SidebarTogglePanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

export function SidebarTogglePanel({ onSubmit }: SidebarTogglePanelProps): React.ReactElement {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("shax:toggle-sidebar"));
    onSubmit(null);
  }, [onSubmit]);
  // The palette closes on the same tick; this render is invisible.
  return <div data-testid="palette-sidebar-toggle" />;
}
