/**
 * ClockWidget (M13.2, spec §19 D5).
 *
 * Subscribes to the App-level 1s tick via `useClock()` — no new
 * setInterval. Same signal the statusbar clock has consumed since
 * M12.4b, exposed as a Context for cross-surface reuse.
 *
 * Two renders:
 *   - Expanded (280px sidebar): HH:MM (large) + weekday, month day.
 *   - Rail (44px sidebar): compact "HH" digits with a full-time tooltip.
 *
 * Deliberately no seconds — a live seconds display on the sidebar
 * would be visual noise for a widget the eye passes over rather than
 * fixates on. The statusbar keeps its HH:MM:SS for the "precise
 * live time" use case; the sidebar answers "what hour is it" at a
 * glance.
 */

import { useMemo, type CSSProperties } from "react";
import { useClock } from "../../lib/ClockContext";

const EXPANDED_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "8px 10px",
  color: "var(--fg)",
};

const EXPANDED_TIME: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 20,
  fontWeight: 600,
  lineHeight: 1.1,
  letterSpacing: 0.5,
};

const EXPANDED_DATE: CSSProperties = {
  fontSize: 11,
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

  // Two derived strings recompute every tick — cheap and no
  // dependency on external formatters. `hour12: false` matches the
  // statusbar clock's format (M12.4b).
  const time = useMemo(
    () =>
      now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [now],
  );
  const date = useMemo(
    () =>
      now.toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
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
  // Rail-state label — hoisted above the conditional return so hook
  // order stays stable regardless of which branch renders. Two
  // digits, no colon, no minutes.
  const hour = useMemo(
    () => now.toLocaleTimeString([], { hour: "2-digit", hour12: false }).replace(/[^\d]/g, ""),
    [now],
  );

  if (!visible) {
    return (
      <div data-testid="sidebar-clock-rail" style={RAIL_ROOT} title={fullTooltip}>
        {hour}
      </div>
    );
  }

  return (
    <div data-testid="sidebar-clock" style={EXPANDED_ROOT} title={fullTooltip}>
      <div style={EXPANDED_TIME}>{time}</div>
      <div style={EXPANDED_DATE}>{date}</div>
    </div>
  );
}
