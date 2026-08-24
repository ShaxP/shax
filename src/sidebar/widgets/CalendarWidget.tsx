/**
 * CalendarWidget (M13.5.3, spec §19 D8 and design/sidebar-extended.png).
 *
 * A hollow month grid: seven weekday columns (M-T-W-T-F-S-S), five to
 * six week rows, today circled in the accent colour. Chevrons above
 * the grid step through months; "today" is preserved on return.
 *
 * Deliberately not:
 *   - Real events. That needs EventKit (macOS) / iCloud / CalDAV /
 *     Google — permission prompts on macOS, an auth surface everywhere,
 *     and network for the sync variants. Phase 2 territory. This card
 *     answers "what day of the month is it, and how far into the
 *     week?" without any of that.
 *   - Persistence. Navigation is client-only and ephemeral; a fresh
 *     window opens on the current month.
 *
 * Data source: `useClock()` for "today". No probes, no backend calls,
 * no async surface — the whole widget runs in-process from the
 * App-level 1s tick already driving the other clock consumers.
 *
 * Rail state: three-letter month abbreviation stacked over the
 * day-of-month in an accent circle (matches design/sidebar-collapsed.png,
 * which the M13.5.5 rail remodel builds on).
 */

import { useMemo, useState, type CSSProperties } from "react";
import { useClock } from "../../lib/ClockContext";
import { CARD, CARD_HEADER } from "./styles";

const CARD_TITLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg)",
};

const NAV: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginLeft: "auto",
};

const CHEVRON: CSSProperties = {
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

const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};

const WEEKDAY: CSSProperties = {
  color: "var(--fg-faint)",
  textAlign: "center",
  fontSize: 10,
  letterSpacing: 0.4,
};

const DAY_BASE: CSSProperties = {
  textAlign: "center",
  color: "var(--fg-dim)",
  padding: "2px 0",
  // Rounded rectangle, not a circle — per `design/sidebar-extended.png`.
  // A circle at the natural cell width visibly clips two-digit days
  // (`22`, `23`, `24` etc. end up cramped against a curved edge);
  // a rounded rectangle at 4px sits comfortably around one or two
  // digits at the same weight. The rail's own day mark stays a
  // circle (see `RAIL_DAY`) because there it sits on its own row
  // with room to breathe.
  borderRadius: 4,
  lineHeight: "18px",
};

const DAY_OTHER_MONTH: CSSProperties = {
  ...DAY_BASE,
  // Days spilling in from the previous or next month, greyed so the
  // reader's eye finds the current month's grid without effort.
  color: "var(--fg-faint)",
};

const DAY_TODAY: CSSProperties = {
  ...DAY_BASE,
  background: "var(--accent)",
  color: "var(--fg)",
  fontWeight: 600,
};

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  fontSize: 10,
  fontFamily: "var(--font-ui)",
  cursor: "default",
};

const RAIL_MONTH: CSSProperties = {
  color: "var(--fg-faint)",
  letterSpacing: 0.4,
  textTransform: "uppercase",
};

const RAIL_DAY: CSSProperties = {
  width: 20,
  height: 20,
  // Rounded square per `design/sidebar-collapsed.png` — matches the
  // shape the expanded card's DAY_TODAY carries (borderRadius: 4).
  // A circle at this cell size clips two-digit days visually against
  // the curved edge; a rounded square sits square around one or two
  // digits at the same weight and keeps the treatment consistent
  // between the two states of the widget.
  borderRadius: 4,
  background: "var(--accent)",
  color: "var(--fg)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  fontWeight: 600,
  fontFamily: "var(--font-mono)",
};

/** Monday-first day-of-week labels. The mockup shows `M T W T F S S`,
 *  matching ISO-8601 / the majority of non-US calendars. If a future
 *  preference reveals a US-style Sunday-first need, it lives in that
 *  preference, not in per-render locale sniffing. */
const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"] as const;

export interface CalendarWidgetProps {
  visible: boolean;
}

export function CalendarWidget({ visible }: CalendarWidgetProps): React.ReactElement {
  const now = useClock();
  // Viewed month is separate from the current month so nav doesn't
  // lose the user's place. Stored as year/month rather than Date so
  // "same month" comparisons are cheap and unambiguous across DST.
  const [view, setView] = useState<{ year: number; month: number }>(() => ({
    year: now.getFullYear(),
    month: now.getMonth(),
  }));

  const today = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };

  const cells = useMemo(() => buildMonthGrid(view.year, view.month), [view.year, view.month]);

  const monthLabel = useMemo(
    () =>
      new Date(view.year, view.month, 1).toLocaleDateString([], {
        month: "long",
        year: "numeric",
      }),
    [view.year, view.month],
  );

  if (!visible) {
    return (
      <div data-testid="sidebar-calendar-rail" style={RAIL_ROOT} title={monthLabel}>
        <span style={RAIL_MONTH} data-testid="sidebar-calendar-rail-month">
          {new Date(today.year, today.month, 1)
            .toLocaleDateString([], { month: "short" })
            .toUpperCase()}
        </span>
        <span style={RAIL_DAY} data-testid="sidebar-calendar-rail-day">
          {today.day}
        </span>
      </div>
    );
  }

  const goPrev = (): void => {
    const m = view.month - 1;
    setView(m < 0 ? { year: view.year - 1, month: 11 } : { year: view.year, month: m });
  };
  const goNext = (): void => {
    const m = view.month + 1;
    setView(m > 11 ? { year: view.year + 1, month: 0 } : { year: view.year, month: m });
  };

  return (
    <div data-testid="sidebar-calendar" style={CARD}>
      <div style={CARD_HEADER}>
        <span style={CARD_TITLE} data-testid="sidebar-calendar-month">
          {monthLabel}
        </span>
        <span style={NAV}>
          <button
            type="button"
            aria-label="Previous month"
            data-testid="sidebar-calendar-prev"
            style={CHEVRON}
            onClick={goPrev}
          >
            ◀
          </button>
          <button
            type="button"
            aria-label="Next month"
            data-testid="sidebar-calendar-next"
            style={CHEVRON}
            onClick={goNext}
          >
            ▶
          </button>
        </span>
      </div>
      <div style={GRID} data-testid="sidebar-calendar-grid" role="grid">
        {WEEKDAY_LABELS.map((label, i) => (
          // Weekday labels: `key={i}` because M-T-W-T-F-S-S repeats
          // the letters (two T, two S), so the letter alone is not
          // unique enough for a stable key.
          <span key={i} style={WEEKDAY} role="columnheader">
            {label}
          </span>
        ))}
        {cells.map((cell) => {
          const isToday =
            cell.year === today.year && cell.month === today.month && cell.day === today.day;
          const isCurrentMonth = cell.month === view.month;
          const style = isToday ? DAY_TODAY : isCurrentMonth ? DAY_BASE : DAY_OTHER_MONTH;
          const testid = isToday
            ? "sidebar-calendar-today"
            : isCurrentMonth
              ? "sidebar-calendar-day"
              : "sidebar-calendar-day-other";
          return (
            <span
              key={`${cell.year}-${cell.month}-${cell.day}`}
              style={style}
              data-testid={testid}
              role="gridcell"
            >
              {cell.day}
            </span>
          );
        })}
      </div>
    </div>
  );
}

interface Cell {
  year: number;
  month: number;
  day: number;
}

/** Build the 6×7 grid of day cells for the month at (year, month),
 *  padded at the front with the tail of the previous month and at
 *  the back with the head of the next month so every week row is
 *  complete. Monday-first per the weekday labels above.
 *
 *  Exported for direct testing without going through a render.
 */
export function buildMonthGrid(year: number, month: number): Cell[] {
  // Number of days in this month. Month `m + 1` day `0` is the last
  // day of month `m` (`new Date(2024, 1, 0)` → Jan 31), which is the
  // classic JS idiom for "days in month".
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // JS `getDay()` returns 0..6 with 0 = Sunday. Convert to 0..6 with
  // 0 = Monday so the grid lines up with the M-first weekday labels.
  const firstWeekdayJs = new Date(year, month, 1).getDay();
  const firstColumn = (firstWeekdayJs + 6) % 7;

  const cells: Cell[] = [];

  // Fill in trailing days from the previous month so the first
  // row of the current month lines up with the correct weekday.
  const prevMonthLast = new Date(year, month, 0).getDate();
  for (let i = 0; i < firstColumn; i += 1) {
    const day = prevMonthLast - firstColumn + 1 + i;
    const prev = month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
    cells.push({ year: prev.year, month: prev.month, day });
  }

  // The month itself.
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push({ year, month, day: d });
  }

  // Pad the tail with the leading days of the next month up to the
  // end of the last row we need. Six rows keeps the grid height
  // stable across months (some months fit in 5, some need 6; padding
  // to 6 always means the widget doesn't jump vertically on nav).
  const targetLength = 42;
  const next = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
  for (let d = 1; cells.length < targetLength; d += 1) {
    cells.push({ year: next.year, month: next.month, day: d });
  }

  return cells;
}
