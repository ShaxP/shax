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
import type { SystemLoad } from "../../lib/ipc";
import { CpuWidget, MIN_BAR_PERCENT, SAMPLES } from "./CpuWidget";

afterEach(cleanup);

const GB = 1024 ** 3;

function load(overrides: Partial<SystemLoad> = {}): SystemLoad {
  return {
    cpu_percent: 42.7,
    mem_used_bytes: 8 * GB,
    mem_total_bytes: 16 * GB,
    load_average_one: 1.84,
    core_count: 4,
    ...overrides,
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
  it("adds one bar per poll and pads the rest as empty slots", () => {
    const { rerender } = render(
      <SystemLoadProvider value={load({ cpu_percent: 10 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")).toHaveLength(1);
    expect(screen.getAllByTestId("sidebar-cpu-bar-empty")).toHaveLength(SAMPLES - 1);

    // A fresh object is what App hands us per poll — the identity IS
    // the tick.
    rerender(
      <SystemLoadProvider value={load({ cpu_percent: 20 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")).toHaveLength(2);
  });

  it("counts two identical readings as two samples", () => {
    // A flat line is real history. Deduping on value would silently
    // drop it and make an idle machine look like a stalled probe.
    const { rerender } = render(
      <SystemLoadProvider value={load({ cpu_percent: 30 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    rerender(
      <SystemLoadProvider value={load({ cpu_percent: 30 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")).toHaveLength(2);
  });

  it("does not add a bar when the same snapshot re-renders", () => {
    const snapshot = load({ cpu_percent: 30 });
    const { rerender } = render(
      <SystemLoadProvider value={snapshot}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    rerender(
      <SystemLoadProvider value={snapshot}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")).toHaveLength(1);
  });

  it("never grows past the window, dropping the oldest sample", () => {
    const { rerender } = render(
      <SystemLoadProvider value={load({ cpu_percent: 0 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    for (let i = 1; i < SAMPLES + 8; i += 1) {
      rerender(
        <SystemLoadProvider value={load({ cpu_percent: i })}>
          <CpuWidget visible={true} />
        </SystemLoadProvider>,
      );
    }
    expect(screen.getAllByTestId("sidebar-cpu-bar")).toHaveLength(SAMPLES);
    expect(screen.queryAllByTestId("sidebar-cpu-bar-empty")).toHaveLength(0);
  });

  it("draws a visible nub for a 0% sample, distinct from an empty slot", () => {
    // "Idle" and "no reading yet" are different statements; a
    // zero-height bar would collapse them into the same pixels.
    render(
      <SystemLoadProvider value={load({ cpu_percent: 0 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getAllByTestId("sidebar-cpu-bar")[0]?.style.height).toBe(`${MIN_BAR_PERCENT}%`);
    expect(screen.getAllByTestId("sidebar-cpu-bar-empty")[0]?.style.height).toBe("");
  });

  it("picks out the newest sample in green and dims the history", () => {
    const { rerender } = render(
      <SystemLoadProvider value={load({ cpu_percent: 10 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    rerender(
      <SystemLoadProvider value={load({ cpu_percent: 90 })}>
        <CpuWidget visible={true} />
      </SystemLoadProvider>,
    );
    const bars = screen.getAllByTestId("sidebar-cpu-bar");
    expect(bars).toHaveLength(2);
    expect(bars[bars.length - 1]?.style.background).toBe("var(--green)");
    expect(bars[0]?.style.background).toBe("var(--fg-faint)");
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
