/**
 * BatteryWidget (M13.5.3, spec §19 D9 and design/sidebar-extended.png).
 *
 * A sidebar card mirroring the M12.4b statusbar chip's underlying
 * data but expressed at a card's scale: a `BATTERY` label with `82%`
 * and the remaining-time estimate on the header, and a full-width
 * horizontal fill beneath, coloured by state.
 *
 * Colour rules:
 *   - **Charging** — blue (`--accent`). Overrides the percent-based
 *     heat map because the semantic here is "actively refilling",
 *     not "current level" — a laptop at 10% but charging is on its
 *     way up, not in trouble.
 *   - **Otherwise**, a three-tier heat map inverted from the CPU
 *     widget (low is bad for battery, high is bad for CPU):
 *     - **< 10 %** → red. Alarm — plug in now.
 *     - **< 20 %** → amber. Warning tint.
 *     - **≥ 20 %** → green. Healthy — everyday discharging AND the
 *       fully-charged-on-AC case (macOS's `State::Full` surfaces as
 *       `on_ac_power && !charging` on the wire); a full battery is
 *       a healthy state, not an "inactive" one.
 *
 * Hides itself entirely when `present === false` — a desktop
 * machine or a probe failure. No placeholder, no "N/A".
 *
 * Consumes the M12.4b `system_battery` probe via `BatteryContext`,
 * shared with the statusbar chip. Statusbar consolidation is a
 * separate follow-up (spec §D9).
 */

import { useMemo, type CSSProperties } from "react";
import { useBattery } from "../../lib/BatteryContext";
import { CARD, CARD_HEADER, CARD_LABEL } from "./styles";

/** Thresholds for the three-tier battery heat map. Inverted from the
 *  CPU widget — where higher is hotter, on battery *lower* is worse.
 *  Named separately from CpuWidget's `AMBER_AT` / `RED_AT` to keep
 *  the two independent (a change to one shouldn't move the other). */
const BATTERY_AMBER_AT = 20;
const BATTERY_RED_AT = 10;

const HEADER_RIGHT: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  marginLeft: "auto",
};

const PERCENT_VALUE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg)",
};

const REMAINING: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
};

/** Track for the horizontal fill. Same colour language as the CPU
 *  sparkline's baseline: a low-contrast track that lets the fill
 *  read as the primary content. */
const BAR_TRACK: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: "var(--pane2)",
  overflow: "hidden",
};

const BAR_FILL_BASE: CSSProperties = {
  height: "100%",
  borderRadius: 3,
  transition: "width 300ms ease-out, background 300ms ease-out",
};

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  cursor: "default",
};

const RAIL_BAR_TRACK: CSSProperties = {
  width: 22,
  height: 6,
  borderRadius: 3,
  background: "var(--pane2)",
  overflow: "hidden",
};

const RAIL_BAR_FILL_BASE: CSSProperties = {
  height: "100%",
  borderRadius: 3,
};

const RAIL_PERCENT: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--fg-dim)",
};

export interface BatteryWidgetProps {
  visible: boolean;
}

export function BatteryWidget({ visible }: BatteryWidgetProps): React.ReactElement | null {
  const battery = useBattery();
  const percent = battery.percent;
  const colour = useMemo(() => barColour(battery), [battery]);
  const remainingLabel = useMemo(() => formatRemaining(battery), [battery]);
  const tooltip = useMemo(() => buildTooltip(battery), [battery]);

  if (!battery.present) return null;

  // Firmware occasionally reports a percent for a moment even when
  // `present` is true (e.g. an initial "unknown" state). Fall back
  // to 0 for the bar geometry but hide the label — inventing "0%"
  // in the header would be a lie.
  const barWidth = percent ?? 0;

  if (!visible) {
    const fillStyle: CSSProperties = {
      ...RAIL_BAR_FILL_BASE,
      width: `${barWidth}%`,
      background: colour,
    };
    return (
      <div data-testid="sidebar-battery-rail" style={RAIL_ROOT} title={tooltip}>
        <div style={RAIL_BAR_TRACK} data-testid="sidebar-battery-rail-track">
          <div style={fillStyle} data-testid="sidebar-battery-rail-fill" />
        </div>
        <span style={RAIL_PERCENT} data-testid="sidebar-battery-rail-percent">
          {percent ?? "?"}
        </span>
      </div>
    );
  }

  const fillStyle: CSSProperties = {
    ...BAR_FILL_BASE,
    width: `${barWidth}%`,
    background: colour,
  };

  return (
    <div data-testid="sidebar-battery" style={CARD} title={tooltip}>
      <div style={CARD_HEADER}>
        <span style={CARD_LABEL}>Battery</span>
        <span style={HEADER_RIGHT}>
          {percent !== null && (
            <span style={PERCENT_VALUE} data-testid="sidebar-battery-percent">
              {percent}%
            </span>
          )}
          {remainingLabel !== null && (
            <span style={REMAINING} data-testid="sidebar-battery-remaining">
              · {remainingLabel}
            </span>
          )}
        </span>
      </div>
      <div style={BAR_TRACK} data-testid="sidebar-battery-track">
        <div style={fillStyle} data-testid="sidebar-battery-fill" />
      </div>
    </div>
  );
}

/** Colour rules from the widget header. Exported so a test can pin
 *  each branch without going through a render.
 *
 *  `on_ac_power` deliberately doesn't feature: the only combination
 *  where `on_ac_power && !charging` fires is `State::Full` (a
 *  plugged-in laptop at 100%), and there the percent branch already
 *  paints green — the healthy answer. Rendering the at-rest case as
 *  dim (an earlier draft) misread as unhealthy / disconnected. */
export function barColour(battery: { percent: number | null; charging: boolean }): string {
  if (battery.charging) return "var(--accent)";
  if (battery.percent === null) return "var(--green)";
  return batteryHeatColour(battery.percent);
}

/** Red < `BATTERY_RED_AT`, amber < `BATTERY_AMBER_AT`, green above.
 *  Exported so tests can pin the thresholds directly. Mirrors the
 *  shape of `CpuWidget`'s `heatColour` (thresholds inverted). */
export function batteryHeatColour(percent: number): string {
  if (percent < BATTERY_RED_AT) return "var(--red)";
  if (percent < BATTERY_AMBER_AT) return "var(--amber)";
  return "var(--green)";
}

/** `4h 20m` / `45m` / null when the OS didn't estimate a value.
 *
 *  We use whole minutes throughout — a per-second estimate has
 *  meaningless precision here (the OS itself moves the number in
 *  chunks). Under 1 minute rounds up to `0m` rather than showing
 *  `< 1m`, which would break the fixed `Nm` / `Nh NNm` shape.
 *
 *  Exported so tests can pin the two branches directly.
 */
export function formatRemaining(battery: { seconds_remaining: number | null }): string | null {
  const s = battery.seconds_remaining;
  if (s === null || s < 0) return null;
  const totalMinutes = Math.round(s / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

function buildTooltip(battery: {
  present: boolean;
  percent: number | null;
  on_ac_power: boolean;
  charging: boolean;
  seconds_remaining: number | null;
}): string {
  if (!battery.present) return "No battery detected";
  const parts: string[] = [];
  const state = battery.charging
    ? "Charging"
    : battery.on_ac_power
      ? "On AC power (at rest)"
      : "On battery";
  parts.push(state);
  if (battery.percent !== null) parts.push(`${battery.percent}%`);
  const remaining = formatRemaining(battery);
  if (remaining !== null) {
    parts.push(battery.charging ? `${remaining} to full` : `${remaining} left`);
  }
  return parts.join(" · ");
}
