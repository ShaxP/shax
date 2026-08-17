/**
 * ClockWidget (M13.2, restyled per design/widget-sidebar.png).
 *
 * Subscribes to the App-level 1s tick via `useClock()` — no new
 * setInterval. Same signal the statusbar clock has consumed since
 * M12.4b, exposed as a Context for cross-surface reuse.
 *
 * Expanded card:
 *   - Big monospace `HH:MM` (28px) with a small accent-colored
 *     `SS` glued to its baseline. Seconds are ambient information
 *     — glanceable when the eye lingers, invisible-cost when it
 *     doesn't.
 *   - Weekday + full month + day in dimmed text below.
 * Rail:
 *   - Two-digit HH glyph with the same tooltip as expanded.
 *
 * 24-hour format matches the statusbar clock (M12.4b) and the
 * mockup.
 */

import { useMemo, type CSSProperties } from "react";
import { useClock } from "../../lib/ClockContext";
import { CARD_RAISED } from "./styles";

const TIME_ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
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
  color: "var(--fg-dim)",
};

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 36,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--fg-dim)",
  cursor: "default",
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
  // Rail-state label hoisted above the conditional return so hook
  // order stays stable regardless of which branch renders.
  const hourOnly = useMemo(
    () => now.toLocaleTimeString([], { hour: "2-digit", hour12: false }).replace(/[^\d]/g, ""),
    [now],
  );

  if (!visible) {
    return (
      <div data-testid="sidebar-clock-rail" style={RAIL_ROOT} title={fullTooltip}>
        {hourOnly}
      </div>
    );
  }

  return (
    <div data-testid="sidebar-clock" style={CARD_RAISED} title={fullTooltip}>
      <div style={TIME_ROW}>
        <span style={HH_MM} data-testid="sidebar-clock-time">
          {hourMinute}
        </span>
        <span style={SECONDS} data-testid="sidebar-clock-seconds">
          {seconds}
        </span>
      </div>
      <div style={DATE_LINE} data-testid="sidebar-clock-date">
        {dateLine}
      </div>
    </div>
  );
}
