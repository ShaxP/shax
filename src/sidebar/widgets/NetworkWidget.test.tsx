/**
 * NetworkWidget tests (M13.3).
 *
 * Covers:
 *   - online with SSID: green dot, "MyHomeWiFi" line, IP line
 *   - online no SSID (wired / macOS): green dot, "Wired" label, IP line
 *   - offline: red dot, "Offline" label, no IP line
 *   - rail: 📡 glyph + colored dot, tooltip carries state
 *   - throughput lines (M13 refinement): rendered as a pair or not
 *     at all, formatted in decimal units, sourced from the 2s
 *     system sampler rather than the 30s network poll
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { NetworkProvider, type NetworkInfo } from "../../lib/NetworkContext";
import { SystemLoadProvider } from "../../lib/SystemLoadContext";
import type { SystemLoad, SystemLoadSeries } from "../../lib/ipc";
import { formatRate, NetworkWidget } from "./NetworkWidget";

afterEach(cleanup);

function net(overrides: Partial<NetworkInfo> = {}): NetworkInfo {
  return {
    ssid: "MyHomeWiFi",
    localIp: "192.168.1.42",
    ...overrides,
  };
}

function series(overrides: Partial<SystemLoad> = {}): SystemLoadSeries {
  return {
    history: [],
    current: {
      cpu_percent: 0,
      mem_used_bytes: 0,
      mem_total_bytes: 0,
      load_average_one: null,
      core_count: null,
      net_up_bps: null,
      net_down_bps: null,
      ...overrides,
    },
  };
}

/** The widget now reads two contexts: identity from the 30s network
 *  poll, throughput from the 2s system sampler. */
function renderWidget(network: NetworkInfo, load: Partial<SystemLoad> = {}, visible = true): void {
  render(
    <SystemLoadProvider value={series(load)}>
      <NetworkProvider value={network}>
        <NetworkWidget visible={visible} />
      </NetworkProvider>
    </SystemLoadProvider>,
  );
}

describe("NetworkWidget / online with SSID (wifi)", () => {
  it("renders SSID + IP + green dot", () => {
    render(
      <NetworkProvider value={net({ ssid: "MyHomeWiFi", localIp: "192.168.1.42" })}>
        <NetworkWidget visible={true} />
      </NetworkProvider>,
    );
    expect(screen.getByTestId("sidebar-network-label").textContent).toBe("MyHomeWiFi");
    expect(screen.getByTestId("sidebar-network-ip").textContent).toBe("192.168.1.42");
    // Green dot — the background must resolve to the theme's --green.
    const dot = screen.getByTestId("sidebar-network-dot");
    expect(dot.getAttribute("style") ?? "").toContain("var(--green)");
  });

  it("tooltip carries SSID + IP", () => {
    render(
      <NetworkProvider value={net({ ssid: "OfficeGuest", localIp: "10.0.0.5" })}>
        <NetworkWidget visible={true} />
      </NetworkProvider>,
    );
    const tooltip = screen.getByTestId("sidebar-network").getAttribute("title") ?? "";
    expect(tooltip).toContain("OfficeGuest");
    expect(tooltip).toContain("10.0.0.5");
  });
});

describe("NetworkWidget / online no SSID (wired or macOS)", () => {
  it("renders 'Wired' label, IP, and a green dot", () => {
    render(
      <NetworkProvider value={net({ ssid: null, localIp: "10.0.0.100" })}>
        <NetworkWidget visible={true} />
      </NetworkProvider>,
    );
    expect(screen.getByTestId("sidebar-network-label").textContent).toBe("Wired");
    expect(screen.getByTestId("sidebar-network-ip").textContent).toBe("10.0.0.100");
    const dot = screen.getByTestId("sidebar-network-dot");
    expect(dot.getAttribute("style") ?? "").toContain("var(--green)");
  });
});

describe("NetworkWidget / offline", () => {
  it("renders 'Offline' label, red dot, no IP line", () => {
    render(
      <NetworkProvider value={net({ ssid: null, localIp: null })}>
        <NetworkWidget visible={true} />
      </NetworkProvider>,
    );
    expect(screen.getByTestId("sidebar-network-label").textContent).toBe("Offline");
    expect(screen.queryByTestId("sidebar-network-ip")).not.toBeInTheDocument();
    const dot = screen.getByTestId("sidebar-network-dot");
    expect(dot.getAttribute("style") ?? "").toContain("var(--red)");
  });

  it("offline tooltip explains the state", () => {
    render(
      <NetworkProvider value={net({ ssid: null, localIp: null })}>
        <NetworkWidget visible={true} />
      </NetworkProvider>,
    );
    const tooltip = screen.getByTestId("sidebar-network").getAttribute("title") ?? "";
    expect(tooltip).toMatch(/offline/i);
  });
});

describe("NetworkWidget / rail", () => {
  it("renders 📡 + colored dot with a tooltip when visible=false", () => {
    render(
      <NetworkProvider value={net({ ssid: "Home", localIp: "192.168.1.1" })}>
        <NetworkWidget visible={false} />
      </NetworkProvider>,
    );
    const rail = screen.getByTestId("sidebar-network-rail");
    expect(rail.textContent).toContain("📡");
    expect(rail.getAttribute("title")).toContain("Home");
  });

  it("rail dot goes red when offline", () => {
    render(
      <NetworkProvider value={net({ ssid: null, localIp: null })}>
        <NetworkWidget visible={false} />
      </NetworkProvider>,
    );
    const rail = screen.getByTestId("sidebar-network-rail");
    // The dot is a span inside the rail — find it via its inline style.
    const dot = rail.querySelector("span[aria-hidden='true']");
    expect(dot?.getAttribute("style") ?? "").toContain("var(--red)");
  });
});

describe("NetworkWidget / throughput", () => {
  it("renders both rates from the system sampler", () => {
    renderWidget(net(), { net_up_bps: 1_200_000, net_down_bps: 240_000 });
    expect(screen.getByTestId("sidebar-network-up").textContent).toContain("1.2 MB/s");
    expect(screen.getByTestId("sidebar-network-down").textContent).toContain("240 KB/s");
  });

  it("colours up green and down cyan, matching the mockup", () => {
    renderWidget(net(), { net_up_bps: 1_000, net_down_bps: 2_000 });
    expect(screen.getByTestId("sidebar-network-up").getAttribute("style") ?? "").toContain(
      "var(--green)",
    );
    expect(screen.getByTestId("sidebar-network-down").getAttribute("style") ?? "").toContain(
      "var(--cyan)",
    );
  });

  it("shows neither rate when the sampler has none yet", () => {
    // The first sample has no interval to divide by. Showing one
    // arrow alone would read as "the other direction is idle" rather
    // than "not measured yet".
    renderWidget(net(), { net_up_bps: null, net_down_bps: null });
    expect(screen.queryByTestId("sidebar-network-throughput")).not.toBeInTheDocument();
  });

  it("shows neither rate when only one direction is known", () => {
    renderWidget(net(), { net_up_bps: 1_000, net_down_bps: null });
    expect(screen.queryByTestId("sidebar-network-throughput")).not.toBeInTheDocument();
  });

  it("keeps the identity lines it already had", () => {
    // Option 2: throughput is additive. Nothing the M13.3 SSID probe
    // earned is given up to gain it.
    renderWidget(net({ ssid: "MyHomeWiFi" }), { net_up_bps: 0, net_down_bps: 0 });
    expect(screen.getByTestId("sidebar-network-label").textContent).toBe("MyHomeWiFi");
    expect(screen.getByTestId("sidebar-network-ip").textContent).toBe("192.168.1.42");
    expect(screen.getByTestId("sidebar-network-throughput")).toBeInTheDocument();
  });

  it("names the interface scope in the tooltip", () => {
    // The rate describes the link the shown IP is on, not every
    // adapter on the machine.
    renderWidget(net(), { net_up_bps: 1_000, net_down_bps: 1_000 });
    expect(screen.getByTestId("sidebar-network").getAttribute("title") ?? "").toContain(
      "on this interface",
    );
  });
});

describe("NetworkWidget / rate formatting", () => {
  it.each([
    [0, "0 B/s"],
    [999, "999 B/s"],
    [1_000, "1 KB/s"],
    [240_000, "240 KB/s"],
    [1_200_000, "1.2 MB/s"],
    [12_000_000, "12 MB/s"],
  ])("%s B/s reads as %s", (bytes, expected) => {
    expect(formatRate(bytes)).toBe(expected);
  });

  it("uses decimal units, not the binary ones memory uses", () => {
    // Link rates are quoted in decimal everywhere else; using MiB
    // here would put a different number beside the same wire.
    expect(formatRate(1_000_000)).toBe("1.0 MB/s");
    expect(formatRate(1_048_576)).toBe("1.0 MB/s");
  });

  it("never renders a negative rate", () => {
    expect(formatRate(-5)).toBe("0 B/s");
  });
});
