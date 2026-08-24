/**
 * NetworkWidget (M13, remodelled per spec §19 D5 item 3 and
 * design/network-widget-1..3.png).
 *
 * A pager over the machine's interfaces, one card at a time:
 *   - Header: NETWORK, a type pill, and `◀ n ▶` when there is more
 *     than one interface.
 *   - Identity line + a per-type detail line.
 *   - `IP <addr>` with the interface name right-aligned.
 *   - `↑` / `↓` rates.
 *
 * Two data sources on two cadences, joined by interface name.
 * Descriptions come from `NetworkContext` at 30s; rates come from the
 * 2s system sampler. That split is not incidental — throughput is a
 * delta whose meaning depends on the interval it was measured over,
 * while the descriptive fields cost a `networksetup` / `scutil` /
 * `ifconfig` fork for values that essentially never change.
 *
 * Selection is held by interface name and is ephemeral — not
 * persisted across a restart, where the set of interfaces can differ
 * entirely. Within a session, a name either still resolves or is
 * honestly gone; an index would quietly slide onto a neighbour when
 * something earlier in the list disappeared.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNetwork } from "../../lib/NetworkContext";
import { useSystemLoadSeries } from "../../lib/SystemLoadContext";
import {
  wifiInfo,
  wifiRequestSsidAccess,
  type InterfaceKind,
  type NetInterface,
  type WifiInfo,
} from "../../lib/ipc";
import { CARD, CARD_HEADER, CARD_LABEL } from "./styles";

const PILL_BASE: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  padding: "2px 7px",
  borderRadius: 999,
  fontFamily: "var(--font-ui)",
};

const PAGER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginLeft: "auto",
};

const PAGER_BUTTON: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--fg-dim)",
  borderRadius: 5,
  width: 18,
  height: 16,
  lineHeight: "12px",
  fontSize: 9,
  padding: 0,
  cursor: "pointer",
};

const PAGER_COUNT: CSSProperties = {
  // Matches the detail line beneath the identity (`1000BASET · full
  // duplex` on Ethernet, `ch 44 · WPA3` on Wi-Fi): mono family at
  // 11px in the faint tier. The pager count is a value the user is
  // navigating with, not a label describing the card, so it takes
  // the data-typography of the detail line rather than the chrome
  // typography of the `NETWORK` label alongside it.
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
  minWidth: 10,
  textAlign: "center",
};

const IDENTITY_ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  marginTop: 2,
};

const IDENTITY: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--fg)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const HEADLINE_VALUE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--cyan)",
  flexShrink: 0,
};

const DETAIL_LINE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const RULE: CSSProperties = {
  height: 1,
  background: "var(--border)",
  margin: "6px 0 4px",
};

const ADDRESS_ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const IP_KEY: CSSProperties = { color: "var(--fg-faint)", fontSize: 11 };
const IP_VALUE: CSSProperties = { color: "var(--fg)" };
const IFACE_NAME: CSSProperties = { color: "var(--fg-faint)", fontSize: 11 };

const THROUGHPUT: CSSProperties = {
  display: "flex",
  gap: 12,
  marginTop: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const UP: CSSProperties = { color: "var(--green)" };
const DOWN: CSSProperties = { color: "var(--cyan)" };

const GRANT_BUTTON: CSSProperties = {
  alignSelf: "flex-start",
  marginTop: 2,
  padding: 0,
  border: "none",
  background: "none",
  color: "var(--accent)",
  fontSize: 11,
  fontFamily: "var(--font-ui)",
  cursor: "pointer",
  textAlign: "left",
};

// Disabled variant used while the CoreLocation prompt is being answered.
// Inline styles can't target `:disabled`, so the awaiting state must be
// spelled out explicitly — otherwise the button stays blue with a
// pointer cursor and the text-only flip to "Waiting for permission…"
// is the only signal the click landed. The click-ack is the whole
// point of the flip; colour and cursor carry it.
const GRANT_BUTTON_AWAITING: CSSProperties = {
  ...GRANT_BUTTON,
  color: "var(--fg-faint)",
  cursor: "default",
};

const DECLINED_NOTE: CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  color: "var(--fg-faint)",
  fontFamily: "var(--font-ui)",
};

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 1,
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  cursor: "default",
  lineHeight: 1.1,
};

// Rail throughput lines — up in green, down in accent, matching the
// expanded card's arrow-colour language. `↑` / `↓` glyphs carry the
// direction; the number carries the rate. Unit implied by context —
// dropped on the rail to save horizontal space (§D11).
const RAIL_UP: CSSProperties = {
  color: "var(--green)",
};

const RAIL_DOWN: CSSProperties = {
  color: "var(--accent)",
};

// Fallback for the offline / pre-probe state where no interface is
// active — a single dim glyph rather than a blank line so the reader
// can still see that a Network row exists.
const RAIL_GLYPH: CSSProperties = {
  color: "var(--fg-faint)",
  fontSize: 14,
};

const OFFLINE_LABEL: CSSProperties = {
  fontSize: 13,
  color: "var(--fg-dim)",
};

export interface NetworkWidgetProps {
  visible: boolean;
}

export function NetworkWidget({ visible }: NetworkWidgetProps): React.ReactElement {
  const { interfaces } = useNetwork();
  const { net_rates: rates } = useSystemLoadSeries();
  // Selection is held by interface NAME, not by index — the same
  // reason rates are joined by name. An interface *earlier* in the
  // list disappearing would leave an index pointing at a different
  // link, and the card would quietly describe the wrong one. A name
  // either still resolves or is honestly gone.
  const [selected, setSelected] = useState<string | null>(null);
  // Applied from the grant request's own response so the name appears
  // on the click rather than up to 30s later.
  // The answer the poll settled on, held locally because the 30s
  // refresh is the only other source and waiting for it is what made
  // this feel broken. Both the name AND the access state come from
  // here: storing only the name left the button on screen for up to
  // 30s after a decline, where clicking it did nothing — macOS never
  // re-prompts — putting the user straight back into "did that
  // work?".
  const [settled, setSettled] = useState<WifiInfo | null>(null);
  const [awaitingGrant, setAwaitingGrant] = useState(false);

  // Fall back to the primary when the selected interface goes away —
  // a cable unplugged, a VPN dropped. Position 0 is the default route,
  // which is the most useful thing to land on.
  const found = interfaces.findIndex((i) => i.name === selected);
  const position = found >= 0 ? found : 0;
  const active: NetInterface | null = interfaces[position] ?? null;

  // Keep the stored name in step once it has resolved, so paging from
  // a fallback moves relative to what is actually on screen.
  useEffect(() => {
    if (active !== null && active.name !== selected) setSelected(active.name);
  }, [active, selected]);

  // The OS dialog is asynchronous: `wifiRequestSsidAccess` returns
  // before the user has answered, so the answer has to be waited
  // for. Polling rather than an event because the settle is a
  // one-shot within a few seconds of a click, and a backend event
  // for it would be machinery for a single moment.
  const askForName = (): void => {
    if (awaitingGrant) return;
    setAwaitingGrant(true);
    void wifiRequestSsidAccess()
      .then(() => pollUntilAnswered())
      .then((info) => {
        if (info !== null) setSettled(info);
      })
      .finally(() => setAwaitingGrant(false));
  };

  const step = (delta: number): void => {
    if (interfaces.length === 0) return;
    const next = (position + delta + interfaces.length) % interfaces.length;
    setSelected(interfaces[next]?.name ?? null);
  };
  const rate = useMemo(
    () => rates.find((r) => active !== null && r.name === active.name) ?? null,
    [rates, active],
  );

  const tooltip = buildTooltip(active, rate, position, interfaces.length);

  if (!visible) {
    // Rail: `↑` / `↓` throughput on two lines per §D11 and the
    // mockup. Signal bars and SSID don't fit at the rail width; the
    // throughput answers the "am I moving bytes right now?" question
    // a user glances at the sidebar for. Falls back to a dim glyph
    // when we have no active interface (offline / pre-probe).
    if (active === null || rate === null) {
      return (
        <div data-testid="sidebar-network-rail" style={RAIL_ROOT} title={tooltip}>
          <span style={RAIL_GLYPH}>{active === null ? "📡" : glyphFor(active.kind)}</span>
        </div>
      );
    }
    return (
      <div data-testid="sidebar-network-rail" style={RAIL_ROOT} title={tooltip}>
        <span style={RAIL_UP} data-testid="sidebar-network-rail-up">
          ↑{formatRailRate(rate.up_bps)}
        </span>
        <span style={RAIL_DOWN} data-testid="sidebar-network-rail-down">
          ↓{formatRailRate(rate.down_bps)}
        </span>
      </div>
    );
  }

  if (active === null) {
    return (
      <div data-testid="sidebar-network" style={CARD} title={tooltip}>
        <div style={CARD_HEADER}>
          <span style={CARD_LABEL}>Network</span>
        </div>
        <span style={OFFLINE_LABEL} data-testid="sidebar-network-label">
          Offline
        </span>
      </div>
    );
  }

  const ssid = settled?.ssid ?? active.wifi?.ssid ?? null;
  const access = settled?.ssid_access ?? active.wifi?.ssid_access ?? "not_required";
  const canAskForName = active.kind === "wi_fi" && ssid === null && access === "not_determined";
  // Declining is a real outcome and deserves saying so. Silently
  // removing the button reads the same as the button not working.
  const nameDeclined = active.kind === "wi_fi" && ssid === null && access === "denied";
  const headline = headlineFor(active);
  const detail = detailFor(active);

  return (
    <div data-testid="sidebar-network" style={CARD} title={tooltip}>
      <div style={CARD_HEADER}>
        <span style={CARD_LABEL}>Network</span>
        <span style={pillStyle(active.kind)} data-testid="sidebar-network-pill">
          {pillLabel(active.kind)}
        </span>
        {interfaces.length > 1 && (
          <span style={PAGER} data-testid="sidebar-network-pager">
            <button
              type="button"
              aria-label="Previous interface"
              data-testid="sidebar-network-prev"
              style={PAGER_BUTTON}
              onClick={() => step(-1)}
            >
              ◀
            </button>
            {/* The interface's position in the list, not how many
                there are — the arrows already imply a sequence, and a
                fixed total tells you nothing about where you are. The
                total is in the tooltip. */}
            <span style={PAGER_COUNT} data-testid="sidebar-network-position">
              {position + 1}
            </span>
            <button
              type="button"
              aria-label="Next interface"
              data-testid="sidebar-network-next"
              style={PAGER_BUTTON}
              onClick={() => step(1)}
            >
              ▶
            </button>
          </span>
        )}
      </div>

      <div style={IDENTITY_ROW}>
        <span style={IDENTITY} data-testid="sidebar-network-label">
          {identityFor(active, ssid)}
        </span>
        {active.wifi?.bars != null && <SignalBars bars={active.wifi.bars} />}
        {headline !== null && (
          <span style={HEADLINE_VALUE} data-testid="sidebar-network-headline">
            {headline}
          </span>
        )}
      </div>

      {detail !== null && (
        <span style={DETAIL_LINE} data-testid="sidebar-network-detail">
          {detail}
        </span>
      )}

      {canAskForName && (
        <button
          type="button"
          data-testid="sidebar-network-grant"
          style={awaitingGrant ? GRANT_BUTTON_AWAITING : GRANT_BUTTON}
          onClick={askForName}
          disabled={awaitingGrant}
        >
          {awaitingGrant ? "Waiting for permission…" : "Show network name…"}
        </button>
      )}

      {nameDeclined && (
        <span style={DECLINED_NOTE} data-testid="sidebar-network-declined">
          Name hidden — allow Location for Shax to show it
        </span>
      )}

      <div style={RULE} aria-hidden="true" />

      <div style={ADDRESS_ROW}>
        <span>
          <span style={IP_KEY}>IP </span>
          <span style={IP_VALUE} data-testid="sidebar-network-ip">
            {active.ip}
          </span>
        </span>
        <span style={IFACE_NAME} data-testid="sidebar-network-iface">
          {active.name}
        </span>
      </div>

      {rate !== null && (
        <div style={THROUGHPUT} data-testid="sidebar-network-throughput">
          <span style={UP} data-testid="sidebar-network-up">
            ↑ {formatRate(rate.up_bps)}
          </span>
          <span style={DOWN} data-testid="sidebar-network-down">
            ↓ {formatRate(rate.down_bps)}
          </span>
        </div>
      )}
    </div>
  );
}

/** Wait for the location dialog to be answered *and* the SSID to
 *  materialise.
 *
 *  Two independent lags on macOS after the user clicks Allow:
 *    1. `CLLocationManager.authorizationStatus()` flips to Granted —
 *       usually within a poll tick or two of the click.
 *    2. `CWWiFiClient.interface().ssid()` returns the actual name —
 *       CoreWLAN caches per-process and only sees the grant after its
 *       next internal refresh, which is a further second or two.
 *
 *  An earlier version exited on the first non-not-determined access
 *  state, which meant the widget snapped into a `Granted` state with
 *  `ssid = null` and stayed as a bare `Wi-Fi` label for the rest of
 *  the app-level 30s refresh cycle. That regression is the reason
 *  this predicate now waits for the name too.
 *
 *  Bounded: a user who walks away from the prompt must not leave a
 *  poll running for the life of the process. Giving up returns null
 *  and changes nothing on screen — the next 30s refresh will pick up
 *  the answer whenever it arrives.
 */
async function pollUntilAnswered(attempts = 60, intervalMs = 500): Promise<WifiInfo | null> {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const info = await wifiInfo();
    // Denied is definitive — no name is coming.
    if (info.ssid_access === "denied") return info;
    // Granted without a name yet is CoreWLAN's cache lag; keep going.
    if (info.ssid_access === "granted" && info.ssid !== null) return info;
  }
  return null;
}

/** Four bars, filled to `bars`. Inline SVG rather than a glyph font
 *  so it follows the theme and scales with the card. */
function SignalBars({ bars }: { bars: number }): React.ReactElement {
  return (
    <svg
      width="16"
      height="12"
      viewBox="0 0 16 12"
      aria-hidden="true"
      data-testid="sidebar-network-bars"
      data-bars={bars}
    >
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={i * 4}
          y={9 - i * 3}
          width="3"
          height={3 + i * 3}
          rx="0.5"
          fill={i < bars ? "var(--green)" : "var(--border)"}
        />
      ))}
    </svg>
  );
}

export function pillLabel(kind: InterfaceKind): string {
  if (kind === "wi_fi") return "WI-FI";
  if (kind === "ethernet") return "ETHERNET";
  if (kind === "vpn") return "VPN";
  return "OTHER";
}

function pillStyle(kind: InterfaceKind): CSSProperties {
  const colour =
    kind === "wi_fi"
      ? "var(--green)"
      : kind === "ethernet"
        ? "var(--accent)"
        : kind === "vpn"
          ? "var(--cyan)"
          : "var(--fg-dim)";
  return { ...PILL_BASE, color: colour, background: "var(--surface)" };
}

function glyphFor(kind: InterfaceKind): string {
  if (kind === "wi_fi") return "📶";
  if (kind === "ethernet") return "🔌";
  if (kind === "vpn") return "🔒";
  return "📡";
}

/** What to call this link. Never guesses: an interface we can't
 *  characterise is named by its own device name rather than labelled
 *  something we don't know it to be. */
export function identityFor(iface: NetInterface, ssid: string | null): string {
  if (iface.kind === "wi_fi") return ssid ?? "Wi-Fi";
  if (iface.kind === "ethernet") return "Wired LAN";
  if (iface.kind === "vpn") return "VPN";
  return iface.name;
}

/** The right-aligned value on the identity row — Ethernet's link
 *  speed. Wi-Fi shows bars there instead, and VPN shows nothing,
 *  since latency was ruled out (spec §19 D5 out-of-scope). */
export function headlineFor(iface: NetInterface): string | null {
  const mbps = iface.link?.speed_mbps ?? null;
  if (mbps === null) return null;
  return mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`;
}

/** The dim line beneath the identity. Built from whatever the platform
 *  actually reported — a field we couldn't read is omitted rather than
 *  rendered as a placeholder. */
export function detailFor(iface: NetInterface): string | null {
  const parts: string[] = [];
  if (iface.kind === "wi_fi" && iface.wifi !== null) {
    const { channel, security, captive } = iface.wifi;
    if (channel !== null) parts.push(`ch ${channel}`);
    if (security !== null) parts.push(security);
    if (captive) parts.push("captive");
  }
  if (iface.kind === "ethernet" && iface.link !== null) {
    const { media, full_duplex: duplex } = iface.link;
    if (media !== null) parts.push(media.toUpperCase());
    if (duplex !== null) parts.push(duplex ? "full duplex" : "half duplex");
  }
  return parts.length === 0 ? null : parts.join(" · ");
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

/** Rail throughput — same decimal thresholds as `formatRate` but
 *  with the unit implied by context (§D11): `1.2` above 1 MB/s,
 *  `240` above 1 KB/s, bare bytes below. Unit is dropped so the
 *  two-line stack fits in ~40 px. Same rounding rule so a reader
 *  glancing between the rail and the expanded card doesn't see the
 *  digit jump.
 *
 *  Exported so tests can pin each threshold. */
export function formatRailRate(bytesPerSecond: number): string {
  const value = Math.max(0, bytesPerSecond);
  if (value >= 1_000_000) {
    const mb = value / 1_000_000;
    return mb >= 10 ? `${Math.round(mb)}` : `${mb.toFixed(1)}`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}`;
  return `${Math.round(value)}`;
}

function buildTooltip(
  iface: NetInterface | null,
  rate: { up_bps: number; down_bps: number } | null,
  position: number,
  total: number,
): string {
  if (iface === null) return "Offline (no addressed interface)";
  const parts: string[] = [`${pillLabel(iface.kind)} · ${iface.name} · ${iface.ip}`];
  if (total > 1) parts.push(`interface ${position + 1} of ${total}`);
  const detail = detailFor(iface);
  if (detail !== null) parts.push(detail);
  if (iface.wifi?.rssi != null) parts.push(`${iface.wifi.rssi} dBm`);
  if (iface.wifi?.ssid_access === "not_determined") {
    parts.push("allow location access to see the network name");
  } else if (iface.wifi?.ssid_access === "denied") {
    parts.push("network name needs location access, which was declined");
  }
  if (rate !== null) {
    parts.push(`↑ ${formatRate(rate.up_bps)} ↓ ${formatRate(rate.down_bps)}`);
  }
  return parts.join(" · ");
}
