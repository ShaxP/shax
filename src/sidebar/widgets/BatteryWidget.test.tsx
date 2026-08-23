/**
 * BatteryWidget tests (M13.5.3, spec §19 D9).
 *
 * Covers:
 *   - hides itself when no battery (desktop / probe fail)
 *   - the four colour branches (charging beats percent; low is amber;
 *     comfortable is green; fully-charged-on-AC is dim)
 *   - the `4h 20m` remaining-time formatter and its "null → hidden"
 *     honesty rule
 *   - both expanded and rail states render the same colour/percent
 *   - the tooltip disambiguates the four states
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { BatteryProvider } from "../../lib/BatteryContext";
import type { BatteryStatus } from "../../lib/ipc";
import { barColour, BatteryWidget, formatRemaining } from "./BatteryWidget";

afterEach(cleanup);

function status(overrides: Partial<BatteryStatus> = {}): BatteryStatus {
  return {
    present: true,
    percent: 82,
    on_ac_power: false,
    charging: false,
    seconds_remaining: 4 * 3600 + 20 * 60,
    ...overrides,
  };
}

describe("BatteryWidget / hidden", () => {
  it("renders nothing at all when no battery is present", () => {
    // Desktop machine or a probe failure both surface as present=false.
    // Either way, no card and no rail — never a placeholder.
    render(
      <BatteryProvider value={status({ present: false })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.queryByTestId("sidebar-battery")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-battery-rail")).not.toBeInTheDocument();
  });

  it("still hides when collapsed and battery is absent", () => {
    render(
      <BatteryProvider value={status({ present: false })}>
        <BatteryWidget visible={false} />
      </BatteryProvider>,
    );
    expect(screen.queryByTestId("sidebar-battery-rail")).not.toBeInTheDocument();
  });
});

describe("BatteryWidget / expanded", () => {
  it("renders `82% · 4h 20m` in the header and a filled bar", () => {
    render(
      <BatteryProvider value={status()}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.getByTestId("sidebar-battery-percent").textContent).toBe("82%");
    expect(screen.getByTestId("sidebar-battery-remaining").textContent).toBe("· 4h 20m");
    // Fill width tracks the percent so the bar reads the same reading
    // as the number to its right.
    expect(screen.getByTestId("sidebar-battery-fill").style.width).toBe("82%");
  });

  it("hides the remaining-time label when the OS didn't estimate one", () => {
    // Fully-charged-on-AC or an unknown state → no time-remaining.
    // The widget hides the estimate rather than inventing one.
    render(
      <BatteryProvider value={status({ seconds_remaining: null, on_ac_power: true })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.queryByTestId("sidebar-battery-remaining")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-battery-percent").textContent).toBe("82%");
  });

  it("hides the percent label if the OS reported a null percent", () => {
    // Firmware may momentarily report present=true but no numeric
    // percent. The bar falls back to 0-width but the number label is
    // suppressed rather than lying `0%`.
    render(
      <BatteryProvider value={status({ percent: null })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.queryByTestId("sidebar-battery-percent")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-battery-fill").style.width).toBe("0%");
  });
});

describe("BatteryWidget / colour rules (barColour helper)", () => {
  it("charging is accent-blue — regardless of percent", () => {
    // A low-percent charging battery reads as "on its way up," not
    // "in trouble." Accent overrides amber.
    expect(barColour({ percent: 10, on_ac_power: true, charging: true })).toBe("var(--accent)");
    expect(barColour({ percent: 82, on_ac_power: true, charging: true })).toBe("var(--accent)");
  });

  it("discharging low is amber (< 20%)", () => {
    expect(barColour({ percent: 15, on_ac_power: false, charging: false })).toBe("var(--amber)");
    expect(barColour({ percent: 0, on_ac_power: false, charging: false })).toBe("var(--amber)");
  });

  it("discharging comfortable is green (>= 20%)", () => {
    expect(barColour({ percent: 20, on_ac_power: false, charging: false })).toBe("var(--green)");
    expect(barColour({ percent: 100, on_ac_power: false, charging: false })).toBe("var(--green)");
  });

  it("fully charged on AC (at rest) is dim, not green", () => {
    // Plugged in at 100%, macOS reports charging=false. Green here
    // would falsely say "healthy discharging"; the battery isn't
    // discharging, so `--fg-faint` says "nothing happening here."
    expect(barColour({ percent: 100, on_ac_power: true, charging: false })).toBe("var(--fg-faint)");
  });
});

describe("BatteryWidget / formatRemaining helper", () => {
  it("`4h 20m` for hours plus minutes", () => {
    expect(formatRemaining({ seconds_remaining: 4 * 3600 + 20 * 60 })).toBe("4h 20m");
  });

  it("zero-pads the minutes past the first hour", () => {
    // Regression guard — a fixed-width `Nh NNm` shape means the
    // reader's eye doesn't jump between `1h 5m` and `1h 45m`.
    expect(formatRemaining({ seconds_remaining: 3600 + 5 * 60 })).toBe("1h 05m");
  });

  it("`45m` for under one hour", () => {
    expect(formatRemaining({ seconds_remaining: 45 * 60 })).toBe("45m");
  });

  it("null → null (never invents an estimate)", () => {
    expect(formatRemaining({ seconds_remaining: null })).toBeNull();
  });

  it("negative → null (defensive, some firmware reports rubbish)", () => {
    expect(formatRemaining({ seconds_remaining: -1 })).toBeNull();
  });
});

describe("BatteryWidget / rail", () => {
  it("renders a mini bar + percent when collapsed", () => {
    render(
      <BatteryProvider value={status()}>
        <BatteryWidget visible={false} />
      </BatteryProvider>,
    );
    expect(screen.getByTestId("sidebar-battery-rail")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-battery-rail-percent").textContent).toBe("82");
    expect(screen.getByTestId("sidebar-battery-rail-fill").style.width).toBe("82%");
  });
});

describe("BatteryWidget / tooltip", () => {
  it("names the state, percent, and remaining time when charging", () => {
    render(
      <BatteryProvider
        value={status({ charging: true, on_ac_power: true, percent: 45, seconds_remaining: 3600 })}
      >
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    const tooltip = screen.getByTestId("sidebar-battery").getAttribute("title") ?? "";
    expect(tooltip).toContain("Charging");
    expect(tooltip).toContain("45%");
    expect(tooltip).toContain("1h 00m");
    expect(tooltip).toContain("to full");
  });

  it("names the state, percent, and remaining time when discharging", () => {
    render(
      <BatteryProvider value={status()}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    const tooltip = screen.getByTestId("sidebar-battery").getAttribute("title") ?? "";
    expect(tooltip).toContain("On battery");
    expect(tooltip).toContain("82%");
    expect(tooltip).toContain("4h 20m");
    expect(tooltip).toContain("left");
  });
});
