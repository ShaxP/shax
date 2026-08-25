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
import { ClockWidget, shortTimezone } from "./ClockWidget";

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

  it("renders the OS timezone abbreviation right-aligned on the time row", () => {
    // The abbreviation itself is host-dependent (CEST here, PST on a
    // US west-coast dev, UTC+2 on a runtime that doesn't know the
    // short name). What we can assert without pinning to a host: the
    // slot renders, its content is non-empty, and it matches what the
    // exported helper resolves against the same instant.
    render(
      <ClockProvider value={at(14, 35)}>
        <ClockWidget visible={true} />
      </ClockProvider>,
    );
    const label = screen.getByTestId("sidebar-clock-timezone").textContent ?? "";
    expect(label).not.toBe("");
    expect(label).toBe(shortTimezone(at(14, 35)));
  });
});

describe("ClockWidget / shortTimezone helper", () => {
  it("returns a non-empty string for any real Date", () => {
    // Two arbitrary instants — a workday afternoon and a midnight —
    // to make sure the helper doesn't get thrown by e.g. DST edges
    // on a host that observes them.
    expect(shortTimezone(new Date(2024, 5, 15, 14, 35, 0))).not.toBe("");
    expect(shortTimezone(new Date(2024, 11, 21, 0, 0, 0))).not.toBe("");
  });

  it("falls back to the IANA zone name when Intl returned no short token", () => {
    // The helper's fallback lives behind the `parts.find(...)` line.
    // Simulate the empty-token case by monkey-patching Intl for the
    // duration of the call, then restore.
    const original = Intl.DateTimeFormat;
    class Stub extends original {
      override formatToParts(): Intl.DateTimeFormatPart[] {
        return [{ type: "hour", value: "14" }];
      }
    }
    // @ts-expect-error — deliberate replacement for this one call.
    Intl.DateTimeFormat = Stub;
    try {
      const label = shortTimezone(new Date(2024, 5, 15, 14, 35, 0));
      expect(label).not.toBe("");
      // IANA zone names always contain either `/` or read as `UTC`;
      // whatever the host is, one of these holds.
      expect(label === "UTC" || label.includes("/")).toBe(true);
    } finally {
      Intl.DateTimeFormat = original;
    }
  });
});

describe("ClockWidget / rail", () => {
  it("stacks HH over MM in the rail per M13.5.5 §D11", () => {
    // M13.1 rail showed just the hour glyph; the M13.5.5 remodel
    // stacks both halves so the eye reads a compact time on a
    // glance without expanding the sidebar.
    render(
      <ClockProvider value={at(9, 4)}>
        <ClockWidget visible={false} />
      </ClockProvider>,
    );
    expect(screen.getByTestId("sidebar-clock-rail-hour").textContent).toBe("09");
    expect(screen.getByTestId("sidebar-clock-rail-minute").textContent).toBe("04");
    // Full time still lives in the tooltip so the reader can
    // confirm a glance-read.
    expect(screen.getByTestId("sidebar-clock-rail").getAttribute("title")).toContain("09:04");
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
