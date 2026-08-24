/**
 * ClockWidget (M13.2, extended per M13.5 spec §D7 and
 * design/sidebar-extended.png).
 *
 * Subscribes to the App-level 1s tick via `useClock()` — no new
 * setInterval. Same signal the statusbar clock has consumed since
 * M12.4b, exposed as a Context for cross-surface reuse.
 *
 * Expanded card, two lines:
 *   - Line 1: big monospace `HH:MM` (28px), small accent-colored `SS`
 *     glued to its baseline, and the OS timezone abbreviation
 *     (`CEST` / `PST` / `UTC+2`) right-aligned in dim. Seconds are
 *     ambient information — glanceable when the eye lingers,
 *     invisible-cost when it doesn't. The timezone is there because
 *     laptop users cross zones and the abbreviation is the shortest
 *     honest way to disambiguate a `08:15` reading.
 *   - Line 2: weekday + full month + day, dim.
 *
 * No uptime line — M13.5 §D7 deferred uptime to Phase 2 rather than
 * folding it into the Clock. The earlier mockup carried it here; the
 * refreshed mockup removed it.
 *
 * The timezone comes from `Intl.DateTimeFormat` — the OS's own zone,
 * read in-process with no probe. `timeZoneName: "short"` gives
 * `CEST` / `PST` when the runtime knows them, and falls back to
 * `GMT±N` when it doesn't. Formatted once per component render since
 * it changes at most twice a year (DST), not per tick.
 *
 * Rail:
 *   - Two-digit HH glyph with the same tooltip as expanded.
 *
 * 24-hour format matches the statusbar clock (M12.4b) and the mockup.
 */

import { useMemo, type CSSProperties } from "react";
import { useClock } from "../../lib/ClockContext";
import { CARD_RAISED } from "./styles";

const TIME_ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 6,
};

// HH:MM + SS group, kept together on the left so `space-between`
// pushes only the timezone to the right edge.
const TIME_GROUP: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
};

const TIMEZONE: CSSProperties = {
  fontSize: 11,
  // Same faintest tier as the date line — the timezone is a
  // disambiguator, not a reading, and the mockup treats it that way.
  color: "var(--fg-faint)",
  letterSpacing: 0.4,
  fontFamily: "var(--font-ui)",
};

const HH_MM: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 28,
  fontWeight: 600,
  lineHeight: 1,
  letterSpacing: -0.5,
  color: "var(--fg)",
};

const SECONDS: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--accent)",
  lineHeight: 1,
};

const DATE_LINE: CSSProperties = {
  fontSize: 12,
  // `--fg-faint`, not `--fg-dim`. The mockup renders the date line
  // at the faintest tier — dim would make it compete with the time
  // for attention, and the time is the reading; the date is context.
  color: "var(--fg-faint)",
};

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: "var(--font-mono)",
  cursor: "default",
  lineHeight: 1,
  gap: 1,
};

// Two-line HH / MM stack per `design/sidebar-collapsed.png` and §D11.
// The hour reads as the primary line — bold, at foreground brightness
// — and the minutes sit under it in a dimmer weight so the eye lands
// on the hour first (which is how a glance at a clock actually works).
const RAIL_HH: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: "var(--fg)",
};

const RAIL_MM: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: "var(--fg-dim)",
};

export interface ClockWidgetProps {
  /** Sidebar's expanded / rail state — same value passed to every
   *  widget by the parent Sidebar. */
  visible: boolean;
}

export function ClockWidget({ visible }: ClockWidgetProps): React.ReactElement {
  const now = useClock();

  const hourMinute = useMemo(
    () =>
      now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [now],
  );
  const seconds = useMemo(
    () =>
      now
        .toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
        .slice(-2),
    [now],
  );
  const dateLine = useMemo(
    () =>
      now.toLocaleDateString([], {
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
    [now],
  );
  const fullTooltip = useMemo(
    () =>
      now.toLocaleString([], {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [now],
  );
  // Rail-state labels hoisted above the conditional return so hook
  // order stays stable regardless of which branch renders. Split into
  // hour and minute components — `hourMinute` is the display string
  // for the expanded card, but the rail wants each half in a
  // different style so the eye lands on the hour.
  const railHour = useMemo(
    () => now.toLocaleTimeString([], { hour: "2-digit", hour12: false }).replace(/[^\d]/g, ""),
    [now],
  );
  const railMinute = useMemo(() => hourMinute.slice(-2), [hourMinute]);
  // Timezone abbreviation from the OS, via Intl — no probe. Changes at
  // most twice a year (DST), so a re-derive per second render is
  // wasted; memoise on `now`'s Date reference and let React skip.
  const timezoneAbbr = useMemo(() => shortTimezone(now), [now]);

  if (!visible) {
    return (
      <div data-testid="sidebar-clock-rail" style={RAIL_ROOT} title={fullTooltip}>
        <span style={RAIL_HH} data-testid="sidebar-clock-rail-hour">
          {railHour}
        </span>
        <span style={RAIL_MM} data-testid="sidebar-clock-rail-minute">
          {railMinute}
        </span>
      </div>
    );
  }

  return (
    <div data-testid="sidebar-clock" style={CARD_RAISED} title={fullTooltip}>
      <div style={TIME_ROW}>
        <span style={TIME_GROUP}>
          <span style={HH_MM} data-testid="sidebar-clock-time">
            {hourMinute}
          </span>
          <span style={SECONDS} data-testid="sidebar-clock-seconds">
            {seconds}
          </span>
        </span>
        <span style={TIMEZONE} data-testid="sidebar-clock-timezone">
          {timezoneAbbr}
        </span>
      </div>
      <div style={DATE_LINE} data-testid="sidebar-clock-date">
        {dateLine}
      </div>
    </div>
  );
}

/** OS timezone abbreviation extracted from `Intl.DateTimeFormat` with
 *  `timeZoneName: "short"`. The API returns the full formatted string
 *  including the time part, so we take the last non-time token — the
 *  timezone piece — and hand it back. Falls back to the IANA zone name
 *  if the runtime returned no timezone token, which is unusual but
 *  survivable (`Europe/Stockholm` on the card reads oddly but honestly).
 *
 *  Split out and pure so tests can exercise it against captured strings
 *  without needing a full render. */
export function shortTimezone(now: Date): string {
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(now);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value;
  if (tz !== undefined && tz !== "") return tz;
  // Explicit `new` on the fallback too — `Intl.DateTimeFormat()` is
  // spec-callable without `new` on the intrinsic, but a subclass
  // used to shim the intrinsic (test doubles) can only be constructed
  // with `new`. Using `new` uniformly makes both cases work.
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
