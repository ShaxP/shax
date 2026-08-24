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
 *   - the bolt tracks the cable, not `charging` (the M13.5.3 bug)
 *   - the tooltip disambiguates the four states
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { BatteryProvider } from "../../lib/BatteryContext";
import type { BatteryStatus } from "../../lib/ipc";
import {
  barColour,
  batteryHeatColour,
  BatteryWidget,
  ESTIMATING_LABEL,
  formatRemaining,
  powerDetail,
  powerLabel,
} from "./BatteryWidget";

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

/** A plugged-in snapshot. `charging` never arrives without
 *  `on_ac_power` on the wire — the backend derives them from one
 *  reading — so charging fixtures set both, or they'd be testing a
 *  state the probe cannot produce. */
function onAc(overrides: Partial<BatteryStatus> = {}): BatteryStatus {
  return status({ on_ac_power: true, ...overrides });
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

  it("hides the inline remaining-time label whenever we're on AC", () => {
    // On the cable the wording moves under the bar, so the inline
    // slot is empty regardless of what the OS estimated.
    render(
      <BatteryProvider value={status({ seconds_remaining: null, on_ac_power: true })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.queryByTestId("sidebar-battery-remaining")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-battery-percent").textContent).toBe("82%");
  });

  it("reads `estimating…` on battery while the OS has no figure yet", () => {
    // Measured on a real unplug: IOKit reports the `65535`-minute
    // sentinel (`pmset`: `(no estimate)`) for the first polls after
    // the power source changes, and the backend filters it to null.
    // Unplugging at 100 % hits this every time. Never invent a
    // number — but don't render an empty slot either.
    render(
      <BatteryProvider value={status({ on_ac_power: false, seconds_remaining: null })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.getByTestId("sidebar-battery-remaining").textContent).toBe("· estimating…");
  });

  it("replaces `estimating…` with the real figure once the OS answers", () => {
    // The recovery half of the same case — 483 minutes is the
    // reading this machine produced once macOS had recalculated.
    render(
      <BatteryProvider value={status({ on_ac_power: false, seconds_remaining: 483 * 60 })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    const label = screen.getByTestId("sidebar-battery-remaining").textContent ?? "";
    expect(label).toBe("· 8h 03m");
    expect(label).not.toContain(ESTIMATING_LABEL);
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
  it("delegates to the heat map at every percent", () => {
    expect(barColour({ percent: 5 })).toBe("var(--red)");
    expect(barColour({ percent: 15 })).toBe("var(--amber)");
    expect(barColour({ percent: 82 })).toBe("var(--green)");
  });

  it("null percent falls back to green rather than fabricating a state", () => {
    // Firmware may momentarily report present=true with no numeric
    // percent. Painting red on a `null` reading would be a false
    // alarm; green is the honest default.
    expect(barColour({ percent: null })).toBe("var(--green)");
  });

  it("does NOT paint anything special for charging — that's the icon's job", () => {
    // Earlier drafts painted accent-blue on charging so the bar
    // itself carried the signal. The charging mockup uses an icon +
    // the "charging · N to full" line beneath the bar, so the bar
    // colour is free to stay on its one job: how much charge is in
    // there right now. Nothing here mentions `charging`.
    expect(barColour({ percent: 82 })).toBe("var(--green)");
    expect(barColour({ percent: 15 })).toBe("var(--amber)");
  });
});

describe("BatteryWidget / heat map (batteryHeatColour)", () => {
  it.each([
    [0, "var(--red)"],
    [9.9, "var(--red)"],
    [10, "var(--amber)"],
    [19.9, "var(--amber)"],
    [20, "var(--green)"],
    [50, "var(--green)"],
    [100, "var(--green)"],
  ])("%s%% is %s", (percent, expected) => {
    // Boundaries are inclusive on the *safer* side (`10` and `20`
    // are amber and green respectively), so a battery on the cusp
    // isn't flattered by rounding into a hotter tier.
    expect(batteryHeatColour(percent)).toBe(expected);
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

  it("shows a lightning-bolt glyph to the LEFT of the percent when charging", () => {
    render(
      <BatteryProvider value={onAc({ charging: true })}>
        <BatteryWidget visible={false} />
      </BatteryProvider>,
    );
    const bolt = screen.getByTestId("sidebar-battery-rail-charging");
    const percent = screen.getByTestId("sidebar-battery-rail-percent");
    expect(bolt).toBeInTheDocument();
    // Bolt and percent share a flex-row parent, and the bolt sits
    // before the percent in DOM order — flex row maps that to
    // visual left. Pinned per `design/battery-charging-collapsed.png`:
    // the charging indicator qualifies the number ("this many
    // percent, and it's growing"), not the bar above.
    expect(bolt.parentElement).toBe(percent.parentElement);
    const parent = bolt.parentElement;
    if (parent === null) throw new Error("bolt and percent share a flex-row parent");
    const children = Array.from(parent.children);
    expect(children.indexOf(bolt)).toBeLessThan(children.indexOf(percent));
  });

  it("hides the bolt in the rail when running on battery", () => {
    render(
      <BatteryProvider value={status({ on_ac_power: false, charging: false })}>
        <BatteryWidget visible={false} />
      </BatteryProvider>,
    );
    expect(screen.queryByTestId("sidebar-battery-rail-charging")).not.toBeInTheDocument();
  });

  it("keeps the bolt in the rail at 100 % on the cable", () => {
    // The collapsed half of the reported bug — same cause, same fix.
    render(
      <BatteryProvider value={onAc({ charging: false, percent: 100, seconds_remaining: null })}>
        <BatteryWidget visible={false} />
      </BatteryProvider>,
    );
    expect(screen.getByTestId("sidebar-battery-rail-charging")).toBeInTheDocument();
  });
});

describe("BatteryWidget / charging visuals (M13.5.3 follow-up)", () => {
  // Per `design/battery-charging-expanded.png`: an icon in the
  // header + a `charging · N to full` line beneath the bar.

  it("shows the charging badge in the header when charging", () => {
    render(
      <BatteryProvider value={onAc({ charging: true })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.getByTestId("sidebar-battery-charging-badge")).toBeInTheDocument();
  });

  it("does not render the charging badge when running on battery", () => {
    render(
      <BatteryProvider value={status({ on_ac_power: false, charging: false })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.queryByTestId("sidebar-battery-charging-badge")).not.toBeInTheDocument();
  });

  it("moves the time estimate under the bar as `charging · N to full`", () => {
    render(
      <BatteryProvider value={onAc({ charging: true, seconds_remaining: 3600 + 5 * 60 })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    const line = screen.getByTestId("sidebar-battery-charging-line").textContent ?? "";
    expect(line).toBe("charging · 1h 05m to full");
    // And the inline `· N` next to the percent is gone — the estimate
    // lives in exactly one place, not two.
    expect(screen.queryByTestId("sidebar-battery-remaining")).not.toBeInTheDocument();
  });

  it("still renders the charging line when the OS didn't estimate a time (bare `charging`)", () => {
    // Charging is real state even without an ETA — hide the estimate
    // suffix but not the line itself.
    render(
      <BatteryProvider value={onAc({ charging: true, seconds_remaining: null })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.getByTestId("sidebar-battery-charging-line").textContent).toBe("charging");
  });

  it("hides the charging line entirely when discharging", () => {
    render(
      <BatteryProvider value={status({ on_ac_power: false, charging: false })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.queryByTestId("sidebar-battery-charging-line")).not.toBeInTheDocument();
    // And the discharging layout keeps the estimate inline with
    // the percent, matching the earlier mockup.
    expect(screen.getByTestId("sidebar-battery-remaining")).toBeInTheDocument();
  });

  it("keeps the bar heat-coloured when charging (no accent override)", () => {
    // The bar's job is unchanged when charging — how much charge is
    // in there. The icon in the header + the line beneath carry the
    // "actively charging" signal. Triple-encoding it on the bar too
    // would be waste of ink.
    render(
      <BatteryProvider value={onAc({ charging: true, percent: 82 })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.getByTestId("sidebar-battery-fill").style.background).toBe("var(--green)");
    expect(screen.getByTestId("sidebar-battery-fill").style.background).not.toContain("--accent");
  });
});

describe("BatteryWidget / plugged in but not charging (M13.5.3 bug)", () => {
  // The reported bug: plugged in at 100 %, no bolt. macOS reports
  // `charged` (`IsCharging=false`) the moment the battery fills, so a
  // bolt gated on `charging` disappears at exactly the percentage
  // where the cable is most obviously still in. The bolt tracks
  // `on_ac_power` instead; the line under the bar carries which of
  // the three plugged-in states we're actually in.

  it("shows the bolt at 100 % on the cable, where macOS reports `charged`", () => {
    render(
      <BatteryProvider value={onAc({ charging: false, percent: 100, seconds_remaining: null })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.getByTestId("sidebar-battery-charging-badge")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-battery-charging-line").textContent).toBe("charged");
  });

  it("shows the bolt while macOS holds the charge below 100 %", () => {
    // Optimised battery charging parks at 80 %: on AC, not charging,
    // not full. The cable is in, so the bolt is lit — and the line
    // says why the number isn't moving.
    render(
      <BatteryProvider value={onAc({ charging: false, percent: 80, seconds_remaining: null })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    expect(screen.getByTestId("sidebar-battery-charging-badge")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-battery-charging-line").textContent).toBe(
      "on AC · not charging",
    );
  });

  it("the bolt's label distinguishes the states it does not distinguish visually", () => {
    // One glyph, three states — so the accessible name and tooltip
    // are what keep "filling" from reading identical to "idle".
    expect(powerLabel({ on_ac_power: true, charging: true })).toBe("Charging");
    expect(powerLabel({ on_ac_power: true, charging: false })).toBe("On AC power");
    expect(powerLabel({ on_ac_power: false, charging: false })).toBe("On battery");
  });

  it("powerDetail phrases each plugged-in state", () => {
    expect(powerDetail({ on_ac_power: true, charging: true, percent: 45 }, "1h 05m")).toBe(
      "charging · 1h 05m to full",
    );
    expect(powerDetail({ on_ac_power: true, charging: true, percent: 45 }, null)).toBe("charging");
    expect(powerDetail({ on_ac_power: true, charging: false, percent: 100 }, null)).toBe("charged");
    expect(powerDetail({ on_ac_power: true, charging: false, percent: 80 }, null)).toBe(
      "on AC · not charging",
    );
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

  it("says Charged rather than Charging at 100 % on the cable", () => {
    // The bolt is the same glyph in both states, so the tooltip is
    // where the difference has to be stated outright.
    render(
      <BatteryProvider value={onAc({ charging: false, percent: 100, seconds_remaining: null })}>
        <BatteryWidget visible={true} />
      </BatteryProvider>,
    );
    const tooltip = screen.getByTestId("sidebar-battery").getAttribute("title") ?? "";
    expect(tooltip).toContain("Charged");
    expect(tooltip).not.toContain("Charging");
    expect(tooltip).toContain("100%");
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
