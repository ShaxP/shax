/**
 * NetworkWidget (M13.3, restyled per design/widget-sidebar.png).
 *
 * Card layout:
 *   - Header row: "NETWORK" label + status dot.
 *   - Below: SSID / "Wired" / "Offline" prominently, then IP in a
 *     smaller mono line beneath.
 *
 * Degradation rules (unchanged from M13.3):
 *   - `ssid` null → label reads "Wired" (or "Offline" when the
 *     local-IP probe also failed). Happens on macOS unconditionally,
 *     on wired desktops, and on any probe failure.
 *   - `localIp` null → the whole card renders in an "offline"
 *     state (red dot, no IP line).
 */

import type { CSSProperties } from "react";
import { useNetwork } from "../../lib/NetworkContext";
import { CARD, CARD_HEADER, CARD_LABEL } from "./styles";

const STATUS_DOT_BASE: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
};

const NET_LABEL: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--fg)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const IP_LABEL: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-dim)",
};

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  height: 32,
  fontSize: 14,
  color: "var(--fg-dim)",
  cursor: "default",
};

export interface NetworkWidgetProps {
  visible: boolean;
}

export function NetworkWidget({ visible }: NetworkWidgetProps): React.ReactElement {
  const { ssid, localIp } = useNetwork();
  const online = localIp !== null;
  const dotStyle: CSSProperties = {
    ...STATUS_DOT_BASE,
    background: online ? "var(--green)" : "var(--red)",
  };
  const label = ssid ?? (online ? "Wired" : "Offline");
  const tooltip = buildTooltip(ssid, localIp, online);

  if (!visible) {
    return (
      <div data-testid="sidebar-network-rail" style={RAIL_ROOT} title={tooltip}>
        <span>📡</span>
        <span style={dotStyle} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div data-testid="sidebar-network" style={CARD} title={tooltip}>
      <div style={CARD_HEADER}>
        <span style={CARD_LABEL}>Network</span>
        <span style={dotStyle} aria-hidden="true" data-testid="sidebar-network-dot" />
      </div>
      <div style={NET_LABEL} data-testid="sidebar-network-label">
        {label}
      </div>
      {online && (
        <div style={IP_LABEL} data-testid="sidebar-network-ip">
          {localIp}
        </div>
      )}
    </div>
  );
}

function buildTooltip(ssid: string | null, localIp: string | null, online: boolean): string {
  if (!online) return "Offline (no default route)";
  const parts: string[] = [];
  if (ssid !== null) parts.push(`SSID: ${ssid}`);
  if (localIp !== null) parts.push(`IP: ${localIp}`);
  if (parts.length === 0) return "Online";
  return parts.join(" · ");
}
