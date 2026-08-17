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
import { CpuWidget } from "./CpuWidget";

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
