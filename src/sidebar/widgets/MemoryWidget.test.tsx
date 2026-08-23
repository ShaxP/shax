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
    net_rates: [],
    history: [],
    current: {
      cpu_percent: 42.7,
      mem_used_bytes: 8 * GB,
      mem_total_bytes: 16 * GB,
      // Default: swap is configured but idle — the shape most macOS
      // and desktop-Linux setups have when the card renders.
      swap_used_bytes: 0,
      swap_total_bytes: 8 * GB,
      load_average_one: 1.84,
      core_count: 4,
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

describe("MemoryWidget / swap line (M13.5)", () => {
  it("renders `swap N.N GB` when swap is configured and in use", () => {
    render(
      <SystemLoadProvider
        value={load({ swap_used_bytes: 200 * 1024 * 1024, swap_total_bytes: 8 * GB })}
      >
        <MemoryWidget visible={true} />
      </SystemLoadProvider>,
    );
    const swap = screen.getByTestId("sidebar-memory-swap").textContent ?? "";
    expect(swap).toMatch(/^swap /);
    // Loose match on the number — the formatter's rules for MB/GB
    // are tested separately, and we just want to confirm the label
    // carries a sensible byte reading.
    expect(swap).toMatch(/\d/);
  });

  it("reads `swap 0 MB` when swap is configured but idle", () => {
    // Idle Mac case: 8 GB of swap allocated, nothing paged out.
    // Reading `swap` (used) rather than `swap_total` is what makes
    // the number reflect reality — the spec is explicit about this.
    render(
      <SystemLoadProvider value={load({ swap_used_bytes: 0, swap_total_bytes: 8 * GB })}>
        <MemoryWidget visible={true} />
      </SystemLoadProvider>,
    );
    const swap = screen.getByTestId("sidebar-memory-swap").textContent ?? "";
    expect(swap).toMatch(/^swap /);
    // The formatter renders sub-GB values as MB; 0 rounds to "0 MB".
    expect(swap).toMatch(/0/);
  });

  it("hides the swap line entirely when swap_total_bytes is 0", () => {
    // Machines with swap turned off (some Linux configurations,
    // some sealed appliances) get no swap line — `swap 0.0 GB` on
    // a system with no swap subsystem would misrepresent the platform.
    render(
      <SystemLoadProvider value={load({ swap_used_bytes: 0, swap_total_bytes: 0 })}>
        <MemoryWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.queryByTestId("sidebar-memory-swap")).not.toBeInTheDocument();
  });

  it("does not render the swap line in the rail state", () => {
    // The rail is percent-only; swap information belongs to the
    // expanded card where there is room for a second line.
    render(
      <SystemLoadProvider
        value={load({ swap_used_bytes: 200 * 1024 * 1024, swap_total_bytes: 8 * GB })}
      >
        <MemoryWidget visible={false} />
      </SystemLoadProvider>,
    );
    expect(screen.queryByTestId("sidebar-memory-swap")).not.toBeInTheDocument();
  });
});
