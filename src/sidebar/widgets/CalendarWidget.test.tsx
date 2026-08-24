/**
 * CalendarWidget tests (M13.5.3, spec §19 D8).
 *
 * The card is meant to be a hollow month grid — no probes, no
 * events, no persistence — so most of what's worth pinning is the
 * grid math and the today-preservation on nav.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ClockProvider } from "../../lib/ClockContext";
import { buildMonthGrid, CalendarWidget } from "./CalendarWidget";

afterEach(cleanup);

/** A fixed date so the "today" cell is deterministic across host
 *  locales. Chose 2024-06-15 (Saturday) — same pivot the Clock
 *  tests use. */
function at(year: number, month: number, day: number): Date {
  return new Date(year, month, day, 12, 0, 0, 0);
}

describe("CalendarWidget / expanded", () => {
  it("renders the current month's name in the header", () => {
    render(
      <ClockProvider value={at(2024, 5, 15)}>
        <CalendarWidget visible={true} />
      </ClockProvider>,
    );
    const label = screen.getByTestId("sidebar-calendar-month").textContent ?? "";
    expect(label).toContain("June");
    expect(label).toContain("2024");
  });

  it("highlights today in the accent circle", () => {
    render(
      <ClockProvider value={at(2024, 5, 15)}>
        <CalendarWidget visible={true} />
      </ClockProvider>,
    );
    const today = screen.getByTestId("sidebar-calendar-today");
    expect(today.textContent).toBe("15");
    // Accent background is the whole point of the highlight — pin it
    // so a future restyle can't quietly drop the visual anchor.
    expect(today.style.background).toContain("--accent");
  });

  it("renders seven weekday header cells (M-first)", () => {
    render(
      <ClockProvider value={at(2024, 5, 15)}>
        <CalendarWidget visible={true} />
      </ClockProvider>,
    );
    const heads = screen.getAllByRole("columnheader");
    expect(heads).toHaveLength(7);
    expect(heads[0]?.textContent).toBe("M");
    expect(heads[6]?.textContent).toBe("S");
  });

  it("greys days that fall outside the current month", () => {
    // June 2024 starts on a Saturday and ends on a Sunday, so both
    // ends of the grid spill into neighbouring months.
    render(
      <ClockProvider value={at(2024, 5, 15)}>
        <CalendarWidget visible={true} />
      </ClockProvider>,
    );
    const spillover = screen.getAllByTestId("sidebar-calendar-day-other");
    expect(spillover.length).toBeGreaterThan(0);
  });

  it("navigates months without losing the today reference on return", () => {
    render(
      <ClockProvider value={at(2024, 5, 15)}>
        <CalendarWidget visible={true} />
      </ClockProvider>,
    );
    // Forward one month.
    fireEvent.click(screen.getByTestId("sidebar-calendar-next"));
    let month = screen.getByTestId("sidebar-calendar-month").textContent ?? "";
    expect(month).toContain("July");
    // July doesn't contain "today" — the accent circle should be gone.
    expect(screen.queryByTestId("sidebar-calendar-today")).not.toBeInTheDocument();
    // Back to June — the accent circle is on 15 again.
    fireEvent.click(screen.getByTestId("sidebar-calendar-prev"));
    month = screen.getByTestId("sidebar-calendar-month").textContent ?? "";
    expect(month).toContain("June");
    expect(screen.getByTestId("sidebar-calendar-today").textContent).toBe("15");
  });

  it("wraps year on January prev / December next", () => {
    render(
      <ClockProvider value={at(2024, 0, 15)}>
        <CalendarWidget visible={true} />
      </ClockProvider>,
    );
    fireEvent.click(screen.getByTestId("sidebar-calendar-prev"));
    // Prev from January 2024 → December 2023.
    expect(screen.getByTestId("sidebar-calendar-month").textContent).toContain("December");
    expect(screen.getByTestId("sidebar-calendar-month").textContent).toContain("2023");
  });
});

describe("CalendarWidget / rail", () => {
  it("stacks a three-letter month over the day in an accent circle", () => {
    render(
      <ClockProvider value={at(2024, 5, 15)}>
        <CalendarWidget visible={false} />
      </ClockProvider>,
    );
    expect(screen.getByTestId("sidebar-calendar-rail-month").textContent).toBe("JUN");
    expect(screen.getByTestId("sidebar-calendar-rail-day").textContent).toBe("15");
  });

  it("hides the expanded card when collapsed", () => {
    render(
      <ClockProvider value={at(2024, 5, 15)}>
        <CalendarWidget visible={false} />
      </ClockProvider>,
    );
    expect(screen.queryByTestId("sidebar-calendar")).not.toBeInTheDocument();
  });
});

describe("buildMonthGrid helper", () => {
  it("always returns a 6-row × 7-col grid (42 cells)", () => {
    // Fixed row count means the widget's height doesn't jump between
    // months where the natural row count differs (5 vs 6).
    for (const [year, month] of [
      [2024, 0], // Jan 2024 (Mon-first: fits in 5 rows naturally)
      [2024, 5], // Jun 2024 (fits in 6 rows)
      [2024, 1], // Feb 2024 (leap-year; starts Thu)
      [2023, 1], // Feb 2023 (non-leap; starts Wed)
    ] as const) {
      expect(buildMonthGrid(year, month)).toHaveLength(42);
    }
  });

  it("places the 1st of the month on the correct weekday column (Monday-first)", () => {
    // June 2024 1st is a Saturday. In Monday-first, Sat is column 5.
    const cells = buildMonthGrid(2024, 5);
    const firstDayIndex = cells.findIndex((c) => c.month === 5 && c.day === 1);
    expect(firstDayIndex).toBe(5);
  });

  it("fills the front pad with the tail of the previous month", () => {
    // May 2024 ends on the 31st. The June grid front-pad should
    // count up TO 31, not down from 1.
    const cells = buildMonthGrid(2024, 5);
    // First cell is May 27 (a Monday) in the M-first layout.
    expect(cells[0]).toEqual({ year: 2024, month: 4, day: 27 });
    expect(cells[4]).toEqual({ year: 2024, month: 4, day: 31 });
  });

  it("fills the back pad with the head of the next month", () => {
    // June 2024's last day is Sun 30. The remaining 42 - (5 + 30) =
    // 7 cells at the tail come from July 2024, starting at 1.
    const cells = buildMonthGrid(2024, 5);
    const tail = cells.slice(35);
    expect(tail[0]).toEqual({ year: 2024, month: 6, day: 1 });
    expect(tail[6]).toEqual({ year: 2024, month: 6, day: 7 });
  });

  it("wraps year at January (front pad reaches into December of prev year)", () => {
    // Jan 2024 starts on a Monday, so no front pad from Dec 2023 —
    // pick Jan 2023 which starts on a Sunday (front-padded).
    const cells = buildMonthGrid(2023, 0);
    const first = cells[0];
    if (first === undefined) throw new Error("grid must have at least one cell");
    expect(first.year).toBe(2022);
    expect(first.month).toBe(11); // December (0-indexed)
  });
});
