/**
 * BatteryWidget (M13.5.3, spec §19 D9).
 *
 * A sidebar card mirroring the M12.4b statusbar chip's underlying
 * data but expressed at a card's scale.
 *
 * Layout (discharging) per `design/sidebar-extended.png`:
 *   BATTERY               [`82%` · `4h 20m`]
 *   [────────── heat-mapped bar ──────────]
 *
 * The `4h 20m` reads `estimating…` for the few polls after unplugging
 * where macOS hasn't computed a figure yet (see `ESTIMATING_LABEL`).
 *
 * Layout (charging) per `design/battery-charging-expanded.png`:
 *   BATTERY                       [⚡] [`82%`]
 *   [────────── heat-mapped bar ──────────]
 *   charging · 1h 05m to full
 *
 * **The bolt tracks `on_ac_power`, not `charging`.** The bolt answers
 * "is the cable in?", the same question macOS's menu-bar bolt answers,
 * and the line under the bar answers "and is energy actually flowing?"
 * Gating the bolt on `charging` was the M13.5.3 bug where a laptop
 * plugged in at 100 % showed no bolt: macOS reports `charged`, not
 * `charging`, the instant the battery fills (and reports neither while
 * optimised charging holds at 80 %), so the icon vanished exactly when
 * the cable was still in. `charging` remains the flag for the wording,
 * where the distinction is real and stated in words rather than
 * inferred from a missing glyph.
 *
 * Bar colour uses a three-tier heat map inverted from the CPU widget
 * (low is bad for battery, high is bad for CPU):
 *   - **< 10 %** → red. Alarm — plug in now.
 *   - **< 20 %** → amber. Warning tint.
 *   - **≥ 20 %** → green. Healthy — everyday discharging AND the
 *     fully-charged-on-AC case (macOS's `State::Full` surfaces as
 *     `on_ac_power && !charging` on the wire); a full battery is a
 *     healthy state, not an "inactive" one.
 *
 * **The bar does NOT change colour when charging.** An earlier draft
 * painted `--accent` on any charging state and the header carried no
 * icon; the charging mockup redistributes the signal — the icon in
 * the header carries "actively charging", the `charging · N to full`
 * line beneath the bar carries the outcome, and the bar's job is
 * unchanged (how much charge is in there right now). Triple-encoding
 * the same signal in the bar colour on top would be a waste of ink.
 *
 * Hides itself entirely when `present === false` — a desktop machine
 * or a probe failure. No placeholder, no "N/A".
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
  alignItems: "center",
  gap: 6,
  marginLeft: "auto",
};

const PERCENT_VALUE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg)",
};

const REMAINING_INLINE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
};

/** Stands in for the time-remaining figure while the OS has no
 *  estimate to give.
 *
 *  macOS has exactly one source for this number — IOKit's
 *  `TimeRemaining` — and after a power-source change it reports the
 *  sentinel `65535` minutes until it has recalculated (`pmset` prints
 *  that as `(no estimate)`). The backend filters the sentinel rather
 *  than passing 1092h through, so the widget gets `null` for those
 *  few polls. Unplugging at 100 % lands in that window every time.
 *
 *  Rendering nothing there reads as "this widget lost a feature".
 *  Naming the wait states the real situation and invents no number,
 *  and it resolves itself on the next poll once the OS answers. */
export const ESTIMATING_LABEL = "estimating…";

/** The `charging · 1h 05m to full` line beneath the bar. Faint tier
 *  like the network detail line and the memory swap line — it's
 *  context for the reading above, not a peer to it. */
const CHARGING_LINE: CSSProperties = {
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

// Rail battery renders as a real battery *icon* — a rounded outline
// with a terminal nub on the right, fill inside — matching the
// mockup rather than a plain progress bar. Same visual grammar as
// the extended card's `ChargingBadge` SVG, at a level-carrying size.
//
// Div-based rather than SVG because the fill width has to animate
// smoothly (CSS width transitions on a plain `<div>` are cheaper and
// easier to keep in step with the extended bar's 300 ms ease-out
// than animating an SVG rect width attribute).
const RAIL_BATTERY_OUTLINE: CSSProperties = {
  width: 26,
  height: 12,
  border: "1px solid var(--fg-dim)",
  borderRadius: 3,
  padding: 1.5,
  boxSizing: "border-box",
  position: "relative",
  flexShrink: 0,
};

// The little cathode nub on the right of a battery outline. Absolute-
// positioned just outside the outer border so it reads as attached to
// the body without disturbing the fill geometry inside the outline.
const RAIL_BATTERY_TERMINAL: CSSProperties = {
  position: "absolute",
  right: -3,
  top: "50%",
  marginTop: -2.5,
  width: 2,
  height: 5,
  background: "var(--fg-dim)",
  borderRadius: 1,
};

const RAIL_BATTERY_FILL_BASE: CSSProperties = {
  height: "100%",
  borderRadius: 1.5,
  transition: "width 300ms ease-out, background 300ms ease-out",
};

const RAIL_PERCENT_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
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
      ...RAIL_BATTERY_FILL_BASE,
      width: `${barWidth}%`,
      background: colour,
    };
    return (
      <div data-testid="sidebar-battery-rail" style={RAIL_ROOT} title={tooltip}>
        <div style={RAIL_BATTERY_OUTLINE} data-testid="sidebar-battery-rail-track">
          <div style={fillStyle} data-testid="sidebar-battery-rail-fill" />
          <div style={RAIL_BATTERY_TERMINAL} aria-hidden="true" />
        </div>
        {/* Bolt sits to the LEFT of the percent number when charging
         *  (per `design/battery-charging-collapsed.png`). The row
         *  wrapper renders even when not charging so the percent's
         *  vertical position doesn't jump between states. */}
        <div style={RAIL_PERCENT_ROW}>
          {battery.on_ac_power && (
            <BoltGlyph
              size={9}
              colour="var(--green)"
              testid="sidebar-battery-rail-charging"
              title={powerLabel(battery)}
            />
          )}
          <span style={RAIL_PERCENT} data-testid="sidebar-battery-rail-percent">
            {percent ?? "?"}
          </span>
        </div>
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
          {battery.on_ac_power && (
            <ChargingBadge testid="sidebar-battery-charging-badge" title={powerLabel(battery)} />
          )}
          {percent !== null && (
            <span style={PERCENT_VALUE} data-testid="sidebar-battery-percent">
              {percent}%
            </span>
          )}
          {/* Discharging shows the time inline with the percent, as
           *  in the sidebar-extended mockup. Every plugged-in state
           *  moves its wording to a dedicated line beneath the bar
           *  (see below) so the `charging · … to full` phrasing has
           *  room to breathe.
           *
           *  The slot holds its place when the OS has no estimate —
           *  see `ESTIMATING_LABEL`. On battery there is always
           *  something true to say here, even if it's only that we're
           *  waiting for the number. */}
          {!battery.on_ac_power && (
            <span style={REMAINING_INLINE} data-testid="sidebar-battery-remaining">
              · {remainingLabel ?? ESTIMATING_LABEL}
            </span>
          )}
        </span>
      </div>
      <div style={BAR_TRACK} data-testid="sidebar-battery-track">
        <div style={fillStyle} data-testid="sidebar-battery-fill" />
      </div>
      {battery.on_ac_power && (
        <span style={CHARGING_LINE} data-testid="sidebar-battery-charging-line">
          {powerDetail(battery, remainingLabel)}
        </span>
      )}
    </div>
  );
}

/** The battery-outline-with-bolt chip that sits before the percent
 *  in the header when charging. Inline SVG so it themes with the
 *  card and doesn't ship a glyph font just for this one icon.
 *
 *  Battery shape: rounded outline + terminal nub on the right, with
 *  a lightning bolt cut through the interior in accent green. The
 *  outline picks up `--fg-dim` so it reads as chrome, not data. */
function ChargingBadge({ testid, title }: { testid: string; title?: string }): React.ReactElement {
  return (
    <svg
      width="18"
      height="12"
      viewBox="0 0 18 12"
      data-testid={testid}
      aria-label={title ?? "Charging"}
      role="img"
    >
      <title>{title ?? "Charging"}</title>
      {/* Battery outline */}
      <rect
        x="0.5"
        y="1.5"
        width="14"
        height="9"
        rx="1.5"
        fill="none"
        stroke="var(--fg-dim)"
        strokeWidth="1"
      />
      {/* Terminal nub on the right */}
      <rect x="15" y="4" width="2" height="4" rx="0.5" fill="var(--fg-dim)" />
      {/* Lightning bolt inside the battery */}
      <path d="M 8 3 L 5 7 H 7 L 6.5 9 L 9.5 5 H 7.5 L 8 3 Z" fill="var(--green)" />
    </svg>
  );
}

/** A tiny lightning-bolt glyph for the rail — no battery outline,
 *  because the rail's mini bar already carries the "how much charge"
 *  visual and the outline would double the width. */
function BoltGlyph({
  size,
  colour,
  testid,
  title,
}: {
  size: number;
  colour: string;
  testid: string;
  title?: string;
}): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 8 8"
      data-testid={testid}
      aria-label={title ?? "Charging"}
      role="img"
    >
      <title>{title ?? "Charging"}</title>
      <path d="M 5 0 L 1 5 H 3.5 L 3 8 L 7 3 H 4.5 L 5 0 Z" fill={colour} />
    </svg>
  );
}

/** What the bolt means right now, for its `title` / `aria-label`. The
 *  bolt itself is one glyph across every plugged-in state (the cable
 *  is in, full stop); the label is where the three states separate. */
export function powerLabel(battery: { on_ac_power: boolean; charging: boolean }): string {
  if (battery.charging) return "Charging";
  return battery.on_ac_power ? "On AC power" : "On battery";
}

/** The faint line under the bar, shown whenever we're on AC.
 *
 *  Three plugged-in states, three phrasings — this line is what keeps
 *  the always-on bolt honest, so "plugged in and filling" never reads
 *  the same as "plugged in and idle":
 *    - charging          → `charging · 1h 05m to full` (estimate when
 *                          the OS gives us one, bare `charging` when
 *                          it doesn't)
 *    - on AC at 100 %    → `charged`
 *    - on AC below 100 % → `on AC · not charging` (macOS holding the
 *                          charge; the cell is neither filling nor
 *                          draining)
 *
 *  Exported so tests can pin each phrasing without a render. */
export function powerDetail(
  battery: { on_ac_power: boolean; charging: boolean; percent: number | null },
  remainingLabel: string | null,
): string {
  if (battery.charging) {
    return remainingLabel !== null ? `charging · ${remainingLabel} to full` : "charging";
  }
  return battery.percent !== null && battery.percent >= 100 ? "charged" : "on AC · not charging";
}

/** Colour rules from the widget header. Exported so a test can pin
 *  each branch without going through a render.
 *
 *  Neither `charging` nor `on_ac_power` feature here. Charging is
 *  communicated by the icon in the header and the line beneath the
 *  bar (see the widget docstring); `on_ac_power && !charging` only
 *  ever fires at 100% (macOS `State::Full`), where the heat map
 *  already paints green — the healthy answer. */
export function barColour(battery: { percent: number | null }): string {
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
      ? battery.percent !== null && battery.percent >= 100
        ? "Charged"
        : "On AC power (not charging)"
      : "On battery";
  parts.push(state);
  if (battery.percent !== null) parts.push(`${battery.percent}%`);
  const remaining = formatRemaining(battery);
  if (remaining !== null) {
    parts.push(battery.charging ? `${remaining} to full` : `${remaining} left`);
  }
  return parts.join(" · ");
}
