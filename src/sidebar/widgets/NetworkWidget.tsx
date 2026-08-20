/**
 * NetworkWidget (M13.3, throughput added in the M13 refinement pass).
 *
 * Card layout:
 *   - Header row: "NETWORK" label + status dot.
 *   - SSID / "Wired" / "Offline" prominently, then IP in a smaller
 *     mono line beneath.
 *   - Throughput: `↑ 1.2 MB/s` (green) and `↓ 240 KB/s` (cyan).
 *
 * The mockup shows a half-width card carrying throughput *instead of*
 * identity, paired with a Disk card that Phase 1 doesn't build. We
 * kept the full width and added the rates beneath, so nothing the
 * M13.3 SSID probe earned is thrown away to gain them — see spec
 * §19 D5 item 3.
 *
 * Rates come from the 2s system sampler, not the 30s network poll:
 * throughput is a delta, and like CPU its meaning depends on the
 * interval it was measured over.
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
import { useSystemLoad } from "../../lib/SystemLoadContext";
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

const THROUGHPUT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  marginTop: 2,
};

const UP: CSSProperties = { color: "var(--green)" };
const DOWN: CSSProperties = { color: "var(--cyan)" };

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
  const { net_up_bps: upBps, net_down_bps: downBps } = useSystemLoad();
  const online = localIp !== null;
  const dotStyle: CSSProperties = {
    ...STATUS_DOT_BASE,
    background: online ? "var(--green)" : "var(--red)",
  };
  const label = ssid ?? (online ? "Wired" : "Offline");
  const tooltip = buildTooltip(ssid, localIp, online, upBps, downBps);
  // Render the pair together or not at all: one arrow alone reads as
  // "the other direction is idle" rather than "unmeasured".
  const showRates = upBps !== null && downBps !== null;

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
      {showRates && (
        <div style={THROUGHPUT} data-testid="sidebar-network-throughput">
          <span style={UP} data-testid="sidebar-network-up">
            ↑ {formatRate(upBps)}
          </span>
          <span style={DOWN} data-testid="sidebar-network-down">
            ↓ {formatRate(downBps)}
          </span>
        </div>
      )}
    </div>
  );
}

/** `240 KB/s` / `1.2 MB/s` / `0 B/s`. Decimal units, matching how
 *  every network tool quotes a link rate — the binary units used for
 *  memory would put a different number beside the same wire. */
export function formatRate(bytesPerSecond: number): string {
  const value = Math.max(0, bytesPerSecond);
  if (value >= 1_000_000) {
    const mb = value / 1_000_000;
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB/s`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)} KB/s`;
  return `${Math.round(value)} B/s`;
}

function buildTooltip(
  ssid: string | null,
  localIp: string | null,
  online: boolean,
  upBps: number | null,
  downBps: number | null,
): string {
  if (!online) return "Offline (no default route)";
  const parts: string[] = [];
  if (ssid !== null) parts.push(`SSID: ${ssid}`);
  if (localIp !== null) parts.push(`IP: ${localIp}`);
  if (upBps !== null && downBps !== null) {
    // Name the interface scope: the rate describes the link this IP
    // is on, not every adapter on the machine.
    parts.push(`↑ ${formatRate(upBps)} ↓ ${formatRate(downBps)} on this interface`);
  }
  if (parts.length === 0) return "Online";
  return parts.join(" · ");
}
