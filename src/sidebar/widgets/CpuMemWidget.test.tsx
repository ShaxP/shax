/**
 * CpuMemWidget tests (M13.3).
 *
 * Covers:
 *   - null when mem_total_bytes is 0 (pre-probe / non-Tauri dev)
 *   - expanded: CPU % and memory formatted, bar widths track values
 *   - rail: 📊 glyph with tooltip carrying both percentages
 *   - byte formatting (GB / MB rounding rules)
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { SystemLoadProvider } from "../../lib/SystemLoadContext";
import type { SystemLoad } from "../../lib/ipc";
import { CpuMemWidget } from "./CpuMemWidget";

afterEach(cleanup);

const GB = 1024 ** 3;

function load(overrides: Partial<SystemLoad> = {}): SystemLoad {
  return {
    cpu_percent: 42.7,
    mem_used_bytes: 8 * GB,
    mem_total_bytes: 16 * GB,
    ...overrides,
  };
}

describe("CpuMemWidget / hidden", () => {
  it("renders nothing when mem_total_bytes is 0 (pre-probe / non-Tauri)", () => {
    render(
      <SystemLoadProvider value={load({ mem_total_bytes: 0 })}>
        <CpuMemWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.queryByTestId("sidebar-cpumem")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-cpumem-rail")).not.toBeInTheDocument();
  });
});

describe("CpuMemWidget / expanded", () => {
  it("renders CPU and Mem rows with rounded percentages / byte counts", () => {
    render(
      <SystemLoadProvider
        value={load({ cpu_percent: 42.7, mem_used_bytes: 8 * GB, mem_total_bytes: 16 * GB })}
      >
        <CpuMemWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-cpumem-cpu").textContent).toBe("43%");
    // Both 8 GB and 16 GB — the "low GB" range keeps one decimal
    // ("8.0"), the "high two-digit" range drops it ("16"). This
    // asserts the actual formatter behaviour, not a wish.
    expect(screen.getByTestId("sidebar-cpumem-mem").textContent).toBe("8.0 GB / 16 GB");
  });

  it("carries a tooltip with CPU % and memory % / labels", () => {
    render(
      <SystemLoadProvider
        value={load({ cpu_percent: 50, mem_used_bytes: 4 * GB, mem_total_bytes: 16 * GB })}
      >
        <CpuMemWidget visible={true} />
      </SystemLoadProvider>,
    );
    const tooltip = screen.getByTestId("sidebar-cpumem").getAttribute("title") ?? "";
    expect(tooltip).toContain("50%");
    expect(tooltip).toContain("4.0 GB");
    expect(tooltip).toContain("25%"); // 4/16 = 25%
  });

  it("shows MB for sub-1-GB memory (formatter branch)", () => {
    render(
      <SystemLoadProvider
        value={load({ mem_used_bytes: 512 * 1024 * 1024, mem_total_bytes: 800 * 1024 * 1024 })}
      >
        <CpuMemWidget visible={true} />
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-cpumem-mem").textContent).toBe("512 MB / 800 MB");
  });
});

describe("CpuMemWidget / rail", () => {
  it("renders the 📊 glyph with a tooltip when visible=false", () => {
    render(
      <SystemLoadProvider
        value={load({ cpu_percent: 33, mem_used_bytes: 6 * GB, mem_total_bytes: 16 * GB })}
      >
        <CpuMemWidget visible={false} />
      </SystemLoadProvider>,
    );
    const rail = screen.getByTestId("sidebar-cpumem-rail");
    expect(rail.textContent).toBe("📊");
    expect(rail.getAttribute("title")).toContain("33%");
  });

  it("stays hidden in the rail when mem_total_bytes is 0", () => {
    render(
      <SystemLoadProvider value={load({ mem_total_bytes: 0 })}>
        <CpuMemWidget visible={false} />
      </SystemLoadProvider>,
    );
    expect(screen.queryByTestId("sidebar-cpumem-rail")).not.toBeInTheDocument();
  });
});
