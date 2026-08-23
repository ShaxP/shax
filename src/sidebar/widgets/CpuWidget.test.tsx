/**
 * CpuWidget tests (M13.3, split from CpuMemWidget in the design
 * refresh).
 *
 * Covers:
 *   - null before the sysinfo probe returns real data
 *   - expanded card: ALL-CAPS label + rounded % value + tooltip
 *   - rail: two-digit zero-padded percent
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { SystemLoadProvider } from "../../lib/SystemLoadContext";
import type { SystemLoad, SystemLoadSeries } from "../../lib/ipc";
import {
  AMBER_AT,
  CpuWidget,
  heatColour,
  MIN_BAR_PX,
  RED_AT,
  SAMPLES,
  SPARKLINE_HEIGHT,
} from "./CpuWidget";

afterEach(cleanup);

const GB = 1024 ** 3;

/** A series with no history — enough for the header, footer and rail
 *  assertions, which don't care about the sparkline. */
function load(overrides: Partial<SystemLoad> = {}, history: number[] = []): SystemLoadSeries {
  return {
    net_rates: [],
    history,
    current: {
      cpu_percent: 42.7,
      mem_used_bytes: 8 * GB,
      mem_total_bytes: 16 * GB,
      swap_used_bytes: 0,
      swap_total_bytes: 8 * GB,
      load_average_one: 1.84,
      core_count: 4,
      ...overrides,
    },
  };
}

describe("CpuWidget / hidden", () => {
  it("renders nothing until the probe returns real data (mem_total_bytes>0)", () => {
    render(
      <SystemLoadProvider value={load({ mem_total_bytes: 0 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.queryByTestId("sidebar-cpu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-cpu-rail")).not.toBeInTheDocument();
  });
});

describe("CpuWidget / expanded", () => {
  it("renders rounded CPU % in the header value slot", () => {
    render(
      <SystemLoadProvider value={load({ cpu_percent: 42.7 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-cpu-percent").textContent).toBe("43%");
  });

  it("carries a CPU-load tooltip on the card root", () => {
    render(
      <SystemLoadProvider value={load({ cpu_percent: 12.4 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    const tooltip = screen.getByTestId("sidebar-cpu").getAttribute("title") ?? "";
    expect(tooltip).toContain("12%");
  });
});

describe("CpuWidget / sparkline", () => {
  it("draws one bar per sample and pads the rest as empty slots", () => {
    render(
      <SystemLoadProvider value={load({}, [10, 20, 30])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")).toHaveLength(3);
    expect(screen.getAllByTestId("sidebar-cpu-bar-empty")).toHaveLength(SAMPLES - 3);
  });

  it("renders whatever history the backend hands it, without accumulating", () => {
    // The widget is a view now. Accumulation moved to the backend so
    // every window agrees; a widget that also buffered would drift
    // from its siblings again the moment the two disagreed.
    const { rerender } = render(
      <SystemLoadProvider value={load({}, [10, 20, 30])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    rerender(
      <SystemLoadProvider value={load({}, [40])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")).toHaveLength(1);
  });

  it("fills the window exactly when the backend sends a full history", () => {
    const full = Array.from({ length: SAMPLES }, (_, i) => i);
    render(
      <SystemLoadProvider value={load({}, full)}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")).toHaveLength(SAMPLES);
    expect(screen.queryAllByTestId("sidebar-cpu-bar-empty")).toHaveLength(0);
  });

  it("trims defensively if the backend ever sends more than fits", () => {
    // The backend bounds this, but a mismatch between the two
    // constants should not blow out the card's layout.
    const overlong = Array.from({ length: SAMPLES + 6 }, (_, i) => i);
    render(
      <SystemLoadProvider value={load({}, overlong)}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")).toHaveLength(SAMPLES);
  });

  it("draws a visible nub for a 0% sample, distinct from an empty slot", () => {
    // "Idle" and "no reading yet" are different statements; a
    // zero-height bar would collapse them into the same pixels.
    render(
      <SystemLoadProvider value={load({}, [0])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    const bar = screen.getAllByTestId("sidebar-cpu-bar")[0];
    expect(bar?.style.height).toBe("0%");
    expect(bar?.style.minHeight).toBe(`${MIN_BAR_PX}px`);
    const empty = screen.getAllByTestId("sidebar-cpu-bar-empty")[0];
    expect(empty?.style.height).toBe("");
    expect(empty?.style.minHeight).toBe("");
  });

  it("keeps the idle floor a fixed few pixels, not a share of the height", () => {
    // Regression guard for making the sparkline taller: as a
    // percentage, the floor would scale with the track and quietly
    // inflate every low reading.
    render(
      <SystemLoadProvider value={load({}, [0])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(MIN_BAR_PX / SPARKLINE_HEIGHT).toBeLessThan(0.1);
    expect(screen.getAllByTestId("sidebar-cpu-bar")[0]?.style.minHeight).toBe(`${MIN_BAR_PX}px`);
  });

  it("gives a 100% sample the full height of the track", () => {
    render(
      <SystemLoadProvider value={load({}, [100])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")[0]?.style.height).toBe("100%");
    expect(screen.getByTestId("sidebar-cpu-sparkline").style.height).toBe(`${SPARKLINE_HEIGHT}px`);
  });

  it("colours only the newest bar with the heat scale; historical bars are monochrome", () => {
    // Match `design/sidebar-extended.png`: the chart is shape-only
    // for history (activity vs quiet) and only the current bar
    // carries the heat colour that answers "how hot right now?".
    // Trades the earlier "red stretch behind a green newest bar
    // says it spiked and recovered" signal for a calmer visual.
    render(
      <SystemLoadProvider value={load({ cpu_percent: 5 }, [95, 5])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    const bars = screen.getAllByTestId("sidebar-cpu-bar");
    // Historical bar (at 95% load) does NOT render as red — it's
    // in the shared monochrome tier.
    expect(bars[0]?.style.background).not.toBe("var(--red)");
    expect(bars[0]?.style.background).toBe("var(--fg-faint)");
    // Newest bar (at 5% load = green) carries its own heat colour.
    expect(bars[bars.length - 1]?.style.background).toBe("var(--green)");
  });

  it("gives every historical bar the same monochrome colour (only opacity varies)", () => {
    // Regression guard: if a future refactor accidentally re-enables
    // heat-per-bar for history, the two mixed-load past samples here
    // would render as different colours and this test would catch it.
    // Opacity is allowed to vary (the recency gradient uses it) —
    // hue must not.
    render(
      <SystemLoadProvider value={load({}, [10, 50, 85, 95])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    const bars = screen.getAllByTestId("sidebar-cpu-bar");
    const historical = bars.slice(0, -1);
    for (const bar of historical) {
      expect(bar.style.background).toBe("var(--fg-faint)");
    }
  });

  it("fades historical bars from dim (oldest) to bright (newest historical)", () => {
    // Matches `design/sidebar-extended.png`: the sparkline reads as
    // a gentle left-to-right rise in brightness, hinting at "just
    // happened" vs "a while ago" without shouting. The newest
    // heat-coloured bar sits above the top of the gradient.
    render(
      <SystemLoadProvider value={load({}, [30, 30, 30, 30, 30, 30, 30, 30])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    const bars = screen.getAllByTestId("sidebar-cpu-bar");
    const historical = bars.slice(0, -1);
    // Pin the direction rather than exact values (values depend on
    // the total window size). Oldest strictly dimmer than newest
    // historical, and the sequence is monotonically increasing.
    const opacities = historical.map((b) => Number(b.style.opacity));
    expect(opacities[0]).toBeLessThan(opacities[opacities.length - 1] ?? 0);
    for (let i = 1; i < opacities.length; i += 1) {
      expect(opacities[i]).toBeGreaterThanOrEqual(opacities[i - 1] ?? 0);
    }
    // Newest bar (heat-coloured) sits at full opacity above the
    // gradient's ceiling.
    expect(
      bars[bars.length - 1]?.style.opacity === "" || bars[bars.length - 1]?.style.opacity === "1",
    ).toBe(true);
  });
});

describe("CpuWidget / heat map", () => {
  it.each([
    [0, "var(--green)"],
    [49.9, "var(--green)"],
    [AMBER_AT, "var(--amber)"],
    [79.9, "var(--amber)"],
    [RED_AT, "var(--red)"],
    [100, "var(--red)"],
  ])("%s%% is %s", (percent, expected) => {
    // Boundaries are inclusive on the hotter side, so a machine under
    // pressure is never flattered by a rounding choice.
    expect(heatColour(percent)).toBe(expected);
  });

  it("colours the header percentage and the newest bar on the same scale", () => {
    // A red percentage above a green newest bar (or vice versa)
    // would be incoherent — both come from the current reading and
    // must agree. Only history is monochrome; the current sample
    // takes the same heat colour the percent uses.
    render(
      <SystemLoadProvider value={load({ cpu_percent: 91 }, [91])}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-cpu-percent").style.color).toBe("var(--red)");
    const bars = screen.getAllByTestId("sidebar-cpu-bar");
    expect(bars[bars.length - 1]?.style.background).toBe("var(--red)");
  });
});

describe("CpuWidget / footer", () => {
  it("shows the load average and core count from the probe", () => {
    render(
      <SystemLoadProvider value={load({ load_average_one: 1.84, core_count: 4 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-cpu-loadavg").textContent).toBe("load 1.84");
    expect(screen.getByTestId("sidebar-cpu-cores").textContent).toBe("4 cores");
  });

  it("omits the load average where the platform has none (Windows)", () => {
    // `sysinfo` returns zeros on Windows rather than failing, so
    // printing the number would be a fabricated reading, not a
    // missing one.
    render(
      <SystemLoadProvider value={load({ load_average_one: null })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-cpu-loadavg").textContent).toBe("");
    expect(screen.getByTestId("sidebar-cpu").getAttribute("title") ?? "").not.toContain(
      "load average",
    );
  });

  it("singularises a one-core machine", () => {
    render(
      <SystemLoadProvider value={load({ core_count: 1 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-cpu-cores").textContent).toBe("1 core");
  });

  it("drops the whole footer when the platform reports neither", () => {
    render(
      <SystemLoadProvider value={load({ load_average_one: null, core_count: null })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.queryByTestId("sidebar-cpu-loadavg")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-cpu-cores")).not.toBeInTheDocument();
  });
});

describe("CpuWidget / rail", () => {
  it("renders a two-digit zero-padded percent when visible=false", () => {
    render(
      <SystemLoadProvider value={load({ cpu_percent: 5 })}>
        <CpuWidget visible={false} />
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-cpu-rail").textContent).toBe("05");
  });

  it("stays hidden in the rail when mem_total_bytes is 0", () => {
    render(
      <SystemLoadProvider value={load({ mem_total_bytes: 0 })}>
        <CpuWidget visible={false} />
      </SystemLoadProvider>,
    );
    expect(screen.queryByTestId("sidebar-cpu-rail")).not.toBeInTheDocument();
  });
});
