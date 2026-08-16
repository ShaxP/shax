/**
 * Panel for the "Sidebar: expand / collapse" palette command.
 *
 * Fire-and-forget: on mount, dispatch `shax:toggle-sidebar` on the
 * window and immediately close the palette. No IPC, no async — the
 * App-level event listener flips the sidebar state synchronously.
 *
 * Mirrors `builtins/newWindow/NewWindowPanel.tsx` in shape but skips
 * the async state machine (there's nothing that can fail).
 *
 * The `firedRef` guard is load-bearing: React.StrictMode (enabled
 * in dev — see `main.tsx`) double-invokes every useEffect on mount.
 * Without the guard, the panel would dispatch `shax:toggle-sidebar`
 * twice on mount, toggling the sidebar back to its original state
 * and appearing to no-op. The ref survives StrictMode's
 * cleanup+rerun cycle and keeps the dispatch exactly once.
 */

import { useEffect, useRef } from "react";
import type { PaneContext } from "../../registry";

export interface SidebarTogglePanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

export function SidebarTogglePanel({ onSubmit }: SidebarTogglePanelProps): React.ReactElement {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    window.dispatchEvent(new CustomEvent("shax:toggle-sidebar"));
    onSubmit(null);
  }, [onSubmit]);
  // The palette closes on the same tick; this render is invisible.
  return <div data-testid="palette-sidebar-toggle" />;
}
