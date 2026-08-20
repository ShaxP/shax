/**
 * MemoryWidget tests (M13.3, split from CpuMemWidget in the design
 * refresh).
 *
 * Covers:
 *   - null before the probe returns (mem_total_bytes = 0)
 *   - expanded card: donut chart + "used / total" label pair
 *   - donut arc dashoffset tracks the fraction
 *   - byte formatter (GB with decimals for low-single-digit, integer
 *     for ≥10; MB below 1 GB)
 *   - rail: two-digit zero-padded percent
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { SystemLoadProvider } from "../../lib/SystemLoadContext";
import type { SystemLoad, SystemLoadSeries } from "../../lib/ipc";
import { MemoryWidget } from "./MemoryWidget";

afterEach(cleanup);

const GB = 1024 ** 3;

function load(overrides: Partial<SystemLoad> = {}): SystemLoadSeries {
  return {
    history: [],
    current: {
      cpu_percent: 42.7,
      mem_used_bytes: 8 * GB,
      mem_total_bytes: 16 * GB,
      load_average_one: 1.84,
      core_count: 4,
      net_up_bps: null,
      net_down_bps: null,
      ...overrides,
    },
  };
}

describe("MemoryWidget / hidden", () => {
  it("renders nothing before the probe returns (mem_total_bytes=0)", () => {
    render(
      <SystemLoadProvider value={load({ mem_total_bytes: 0 })}>
        <MemoryWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.queryByTestId("sidebar-memory")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-memory-rail")).not.toBeInTheDocument();
  });
});

describe("MemoryWidget / expanded", () => {
  it("renders donut + used/total labels with the rounded percent inside", () => {
    render(
      <SystemLoadProvider value={load({ mem_used_bytes: 4 * GB, mem_total_bytes: 16 * GB })}>
        <MemoryWidget visible={true} />
      </SystemLoadProvider>,
    );
    // 4 / 16 = 25%.
    expect(screen.getByTestId("sidebar-memory-percent").textContent).toBe("25%");
    expect(screen.getByTestId("sidebar-memory-used").textContent).toBe("4.0 GB");
    expect(screen.getByTestId("sidebar-memory")).toHaveTextContent("/ 16 GB");
  });

  it("carries a memory-in-use tooltip on the card root", () => {
    render(
      <SystemLoadProvider value={load({ mem_used_bytes: 4 * GB, mem_total_bytes: 16 * GB })}>
        <MemoryWidget visible={true} />
      </SystemLoadProvider>,
    );
    const tooltip = screen.getByTestId("sidebar-memory").getAttribute("title") ?? "";
    expect(tooltip).toContain("4.0 GB");
    expect(tooltip).toContain("16 GB");
    expect(tooltip).toContain("25%");
  });

  it("shows MB for sub-1-GB memory (formatter branch)", () => {
    render(
      <SystemLoadProvider
        value={load({
          mem_used_bytes: 512 * 1024 * 1024,
          mem_total_bytes: 800 * 1024 * 1024,
        })}
      >
        <MemoryWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-memory-used").textContent).toBe("512 MB");
    expect(screen.getByTestId("sidebar-memory")).toHaveTextContent("/ 800 MB");
  });

  it("donut arc offset tracks the used fraction", () => {
    function arcOffset(): number {
      const circles = screen.getByTestId("sidebar-memory-donut").querySelectorAll("circle");
      const arc = circles[1]; // [0] = track, [1] = filled arc
      if (arc === undefined) throw new Error("filled-arc circle missing from donut");
      return parseFloat(arc.getAttribute("stroke-dashoffset") ?? "NaN");
    }
    // Fully-filled ring — dashoffset should be 0 (full circle drawn).
    const { rerender } = render(
      <SystemLoadProvider value={load({ mem_used_bytes: 16 * GB, mem_total_bytes: 16 * GB })}>
        <MemoryWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(arcOffset()).toBe(0);

    // 50% — dashoffset should be half of circumference.
    rerender(
      <SystemLoadProvider value={load({ mem_used_bytes: 8 * GB, mem_total_bytes: 16 * GB })}>
        <MemoryWidget visible={true} />
      </SystemLoadProvider>,
    );
    const halfCircumference = 2 * Math.PI * ((44 - 4) / 2) * 0.5;
    expect(arcOffset()).toBeCloseTo(halfCircumference, 5);
  });
});

describe("MemoryWidget / rail", () => {
  it("renders a two-digit zero-padded percent when visible=false", () => {
    render(
      <SystemLoadProvider value={load({ mem_used_bytes: 1 * GB, mem_total_bytes: 16 * GB })}>
        <MemoryWidget visible={false} />
      </SystemLoadProvider>,
    );
    // 1 / 16 ≈ 6% → "06".
    expect(screen.getByTestId("sidebar-memory-rail").textContent).toBe("06");
  });
});
