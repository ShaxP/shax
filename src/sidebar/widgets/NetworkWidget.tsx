/**
 * NetworkWidget (M13.3, spec §19 D5).
 *
 * SSID (when known) + default-route IPv4 + a small colored dot for
 * up/down. Reads from `useNetwork()`; App polls the two underlying
 * probes at 30s.
 *
 * Renders:
 *   - Expanded: `📡  MyHomeWiFi` (or IP-only) and `192.168.1.42` on
 *     a second line; green dot when reachable, red when offline.
 *   - Rail: 📡 glyph with a colored dot overlay; tooltip carries
 *     SSID + IP + status.
 *
 * Degradation rules (spec §D5, restated for clarity):
 *   - `ssid` null → the SSID line disappears (widget still renders
 *     with just the IP). Happens on macOS unconditionally, on wired
 *     desktops, and on any probe failure.
 *   - `localIp` null → the whole widget renders in an "offline"
 *     state (red dot, no IP text). The `local-ip-address` crate
 *     returning None is the closest signal we have to "no network"
 *     without a per-poll reachability check — Shax intentionally
 *     doesn't ping (local-first, no telemetry).
 */

import type { CSSProperties } from "react";
import { useNetwork } from "../../lib/NetworkContext";

const EXPANDED_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "6px 10px",
  fontSize: 11,
  color: "var(--fg)",
};

const HEADER_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const NET_GLYPH: CSSProperties = {
  fontSize: 12,
  flexShrink: 0,
};

const SSID_LABEL: CSSProperties = {
  fontSize: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
};

const IP_LABEL: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-dim)",
  paddingLeft: 18, // align under the SSID row, after the glyph
};

const STATUS_DOT_BASE: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  flexShrink: 0,
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
    <div data-testid="sidebar-network" style={EXPANDED_ROOT} title={tooltip}>
      <div style={HEADER_ROW}>
        <span style={NET_GLYPH}>📡</span>
        <span style={SSID_LABEL} data-testid="sidebar-network-label">
          {ssid ?? (online ? "Wired" : "Offline")}
        </span>
        <span style={dotStyle} aria-hidden="true" data-testid="sidebar-network-dot" />
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
