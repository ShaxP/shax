/**
 * ClockWidget tests (M13.2, updated for the design refresh).
 *
 * Covers:
 *   - expanded card: HH:MM (large, mono), separate SS accent, full
 *     weekday-day-month date line, full tooltip.
 *   - rail: two-digit hour, tooltip carries the full time.
 *   - re-renders when the ClockContext value updates.
 *   - 24-hour format matches the statusbar clock (M12.4b).
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ClockProvider } from "../../lib/ClockContext";
import { ClockWidget } from "./ClockWidget";

afterEach(cleanup);

// 2024-06-15 (Saturday) — arbitrary fixed instant. Using a fixed
// Date keeps assertions deterministic across host locales.
function at(hh: number, mm: number, ss: number = 0): Date {
  return new Date(2024, 5, 15, hh, mm, ss, 0);
}

describe("ClockWidget / expanded", () => {
  it("renders HH:MM in 24-hour form and a matching seconds accent", () => {
    render(
      <ClockProvider value={at(14, 35, 42)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    expect(screen.getByTestId("sidebar-clock-time").textContent).toBe("14:35");
    expect(screen.getByTestId("sidebar-clock-seconds").textContent).toBe("42");
  });

  it("renders the full weekday-day-month date line", () => {
    render(
      <ClockProvider value={at(14, 35)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    const date = screen.getByTestId("sidebar-clock-date").textContent ?? "";
    // Long weekday + day + month — under en-US that's e.g.
    // "Saturday, June 15" (comma placement varies by locale).
    expect(date).toMatch(/Saturday/);
    expect(date).toMatch(/June/);
    expect(date).toMatch(/15/);
  });

  it("expanded card carries a full-time tooltip", () => {
    render(
      <ClockProvider value={at(14, 35)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    const tooltip = screen.getByTestId("sidebar-clock").getAttribute("title") ?? "";
    expect(tooltip).toContain("Saturday");
    expect(tooltip).toContain("2024");
    expect(tooltip).toContain("14:35");
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
    expect(rail.textContent).toBe("09");
    expect(rail.getAttribute("title")).toContain("09:04");
  });

  it("does not render the expanded card when visible=false", () => {
    render(
      <ClockProvider value={at(14, 35)}>
        <ClockWidget visible={false} />
      </ClockProvider>,
    );
    expect(screen.queryByTestId("sidebar-clock")).not.toBeInTheDocument();
  });
});

describe("ClockWidget / tick", () => {
  it("re-renders time and seconds when ClockProvider value updates", () => {
    const { rerender } = render(
      <ClockProvider value={at(14, 35, 10)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    expect(screen.getByTestId("sidebar-clock-time").textContent).toBe("14:35");
    expect(screen.getByTestId("sidebar-clock-seconds").textContent).toBe("10");
    rerender(
      <ClockProvider value={at(14, 36, 5)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    expect(screen.getByTestId("sidebar-clock-time").textContent).toBe("14:36");
    expect(screen.getByTestId("sidebar-clock-seconds").textContent).toBe("05");
  });
});
