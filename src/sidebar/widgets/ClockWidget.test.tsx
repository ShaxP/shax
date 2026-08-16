/**
 * ClockWidget tests (M13.2).
 *
 * Covers:
 *   - expanded state: HH:MM + date line, tooltip carries the full
 *     weekday/date/time
 *   - rail state: two-digit hour glyph, tooltip carries the full
 *     time
 *   - re-renders when the ClockContext value updates
 *   - format is 24-hour to match the statusbar clock (M12.4b)
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ClockProvider } from "../../lib/ClockContext";
import { ClockWidget } from "./ClockWidget";

afterEach(cleanup);

// 2024-06-15 (Saturday) at 14:35 UTC — arbitrary fixed instant.
// The widget calls `.toLocaleTimeString([], { hour12: false })`
// which the jsdom runtime honours via the host ICU. Using a fixed
// Date keeps the assertions deterministic.
function at(hh: number, mm: number): Date {
  return new Date(2024, 5, 15, hh, mm, 0, 0);
}

describe("ClockWidget / expanded", () => {
  it("renders HH:MM in 24-hour form + a date line", () => {
    render(
      <ClockProvider value={at(14, 35)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    const clock = screen.getByTestId("sidebar-clock");
    expect(clock.textContent).toContain("14:35");
    // Date line uses the short weekday + short month + day.
    // "Sat" is the abbreviated form for a Saturday under en-US locale.
    expect(clock.textContent).toMatch(/Sat/);
  });

  it("expanded clock carries a full-time tooltip", () => {
    render(
      <ClockProvider value={at(14, 35)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    const clock = screen.getByTestId("sidebar-clock");
    // Full tooltip includes long weekday, year, and 24-hour time.
    expect(clock.getAttribute("title")).toContain("Saturday");
    expect(clock.getAttribute("title")).toContain("2024");
    expect(clock.getAttribute("title")).toContain("14:35");
  });
});

describe("ClockWidget / rail", () => {
  it("renders two-digit hour with tooltip when visible=false", () => {
    render(
      <ClockProvider value={at(9, 4)}>
        <ClockWidget visible={false} />
      </ClockProvider>,
    );
    const rail = screen.getByTestId("sidebar-clock-rail");
    // "09" — two digits, no colon.
    expect(rail.textContent).toBe("09");
    expect(rail.getAttribute("title")).toContain("09:04");
  });

  it("does not render the expanded slot when visible=false", () => {
    render(
      <ClockProvider value={at(14, 35)}>
        <ClockWidget visible={false} />
      </ClockProvider>,
    );
    expect(screen.queryByTestId("sidebar-clock")).not.toBeInTheDocument();
  });
});

describe("ClockWidget / tick", () => {
  it("re-renders when ClockProvider value updates", () => {
    const { rerender } = render(
      <ClockProvider value={at(14, 35)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    expect(screen.getByTestId("sidebar-clock").textContent).toContain("14:35");
    rerender(
      <ClockProvider value={at(14, 36)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    expect(screen.getByTestId("sidebar-clock").textContent).toContain("14:36");
  });
});
