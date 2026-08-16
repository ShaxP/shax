/**
 * NetworkWidget tests (M13.3).
 *
 * Covers:
 *   - online with SSID: green dot, "MyHomeWiFi" line, IP line
 *   - online no SSID (wired / macOS): green dot, "Wired" label, IP line
 *   - offline: red dot, "Offline" label, no IP line
 *   - rail: 📡 glyph + colored dot, tooltip carries state
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

import { NetworkProvider, type NetworkInfo } from "../../lib/NetworkContext";
import { NetworkWidget } from "./NetworkWidget";

afterEach(cleanup);

function net(overrides: Partial<NetworkInfo> = {}): NetworkInfo {
  return {
    ssid: "MyHomeWiFi",
    localIp: "192.168.1.42",
    ...overrides,
  };
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
