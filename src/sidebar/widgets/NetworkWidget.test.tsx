/**
 * NetworkWidget tests (M13 remodelling, spec §19 D5 item 3).
 *
 * The card is now a pager over addressed interfaces, joining two
 * cadences by interface name. What's worth pinning:
 *   - the join is by name, not by position
 *   - paging is bounded, wraps, and survives an interface vanishing
 *   - every value is omitted when unreadable rather than faked
 *   - the identity line never claims a medium it doesn't know
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const requestAccessMock = vi.hoisted(() => vi.fn());
const wifiInfoMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ipc", () => ({
  wifiRequestSsidAccess: requestAccessMock,
  wifiInfo: wifiInfoMock,
}));

import { NetworkProvider } from "../../lib/NetworkContext";
import { SystemLoadProvider } from "../../lib/SystemLoadContext";
import type { InterfaceRate, NetInterface, SystemLoadSeries, WifiDetail } from "../../lib/ipc";
import { detailFor, formatRate, headlineFor, identityFor, NetworkWidget } from "./NetworkWidget";

afterEach(cleanup);

beforeEach(() => {
  // The real command returns BEFORE the user answers the OS dialog,
  // so it reports the state as it stands: still undetermined.
  requestAccessMock
    .mockReset()
    .mockResolvedValue({ medium: "wi_fi", ssid: null, ssid_access: "not_determined" });
  // The answer arrives via the poll that follows.
  wifiInfoMock
    .mockReset()
    .mockResolvedValue({ medium: "wi_fi", ssid: "GrantedNet", ssid_access: "granted" });
});

const WIFI_DETAIL: WifiDetail = {
  ssid: "Hotel_Guest",
  ssid_access: "granted",
  rssi: -48,
  bars: 3,
  channel: 6,
  security: "WPA2",
  captive: false,
};

function wifi(overrides: Partial<NetInterface> = {}): NetInterface {
  return {
    name: "en0",
    ip: "10.24.9.88",
    kind: "wi_fi",
    is_primary: true,
    link: null,
    wifi: WIFI_DETAIL,
    ...overrides,
  };
}

/** A Wi-Fi interface with some of its detail unreadable. */
function wifiWith(detail: Partial<WifiDetail>): NetInterface {
  return wifi({ wifi: { ...WIFI_DETAIL, ...detail } });
}

function ethernet(overrides: Partial<NetInterface> = {}): NetInterface {
  return {
    name: "en5",
    ip: "10.0.4.117",
    kind: "ethernet",
    is_primary: false,
    wifi: null,
    link: { speed_mbps: 1000, media: "1000baseT", full_duplex: true },
    ...overrides,
  };
}

function vpn(overrides: Partial<NetInterface> = {}): NetInterface {
  return {
    name: "utun4",
    ip: "10.88.0.6",
    kind: "vpn",
    is_primary: false,
    wifi: null,
    link: null,
    ...overrides,
  };
}

function series(rates: InterfaceRate[] = []): SystemLoadSeries {
  return {
    net_rates: rates,
    history: [],
    current: {
      cpu_percent: 0,
      mem_used_bytes: 0,
      mem_total_bytes: 0,
      load_average_one: null,
      core_count: null,
    },
  };
}

function renderWidget(interfaces: NetInterface[], rates: InterfaceRate[] = [], visible = true) {
  return render(
    <SystemLoadProvider value={series(rates)}>
      <NetworkProvider value={{ interfaces }}>
        <NetworkWidget visible={visible} />
      </NetworkProvider>
    </SystemLoadProvider>,
  );
}

describe("NetworkWidget / the three reference screenshots", () => {
  it("renders the Wi-Fi card", () => {
    renderWidget([wifi()], [{ name: "en0", up_bps: 88_000, down_bps: 12_000 }]);
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("WI-FI");
    expect(screen.getByTestId("sidebar-network-label").textContent).toBe("Hotel_Guest");
    expect(screen.getByTestId("sidebar-network-detail").textContent).toBe("ch 6 · WPA2");
    expect(screen.getByTestId("sidebar-network-ip").textContent).toBe("10.24.9.88");
    expect(screen.getByTestId("sidebar-network-iface").textContent).toBe("en0");
    expect(screen.getByTestId("sidebar-network-up").textContent).toContain("88 KB/s");
    expect(screen.getByTestId("sidebar-network-down").textContent).toContain("12 KB/s");
  });

  it("renders the Ethernet card", () => {
    renderWidget([ethernet()], [{ name: "en5", up_bps: 4_800_000, down_bps: 1_100_000 }]);
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("ETHERNET");
    expect(screen.getByTestId("sidebar-network-label").textContent).toBe("Wired LAN");
    expect(screen.getByTestId("sidebar-network-headline").textContent).toBe("1 Gb/s");
    expect(screen.getByTestId("sidebar-network-detail").textContent).toBe(
      "1000BASET · full duplex",
    );
    expect(screen.getByTestId("sidebar-network-up").textContent).toContain("4.8 MB/s");
  });

  it("renders the VPN card, without the values we ruled out", () => {
    renderWidget([vpn()], [{ name: "utun4", up_bps: 320_000, down_bps: 96_000 }]);
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("VPN");
    expect(screen.getByTestId("sidebar-network-ip").textContent).toBe("10.88.0.6");
    // Latency, handshake age and protocol name were all found
    // unobtainable and dropped by decision — no placeholders.
    expect(screen.queryByTestId("sidebar-network-headline")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-network-detail")).not.toBeInTheDocument();
  });

  it("shows a captive chip only when the OS actually detected one", () => {
    renderWidget([wifiWith({ captive: true })]);
    expect(screen.getByTestId("sidebar-network-detail").textContent).toContain("captive");
  });
});

describe("NetworkWidget / paging", () => {
  it("hides the pager when there is only one interface", () => {
    renderWidget([wifi()]);
    expect(screen.queryByTestId("sidebar-network-pager")).not.toBeInTheDocument();
  });

  it("shows which interface you are on, not how many there are", () => {
    // A fixed total between the arrows tells you nothing about where
    // you are in the sequence; the position does. The total moves to
    // the tooltip.
    renderWidget([wifi(), ethernet(), vpn()]);
    expect(screen.getByTestId("sidebar-network-position").textContent).toBe("1");
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("WI-FI");

    fireEvent.click(screen.getByTestId("sidebar-network-next"));
    expect(screen.getByTestId("sidebar-network-position").textContent).toBe("2");
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("ETHERNET");

    fireEvent.click(screen.getByTestId("sidebar-network-next"));
    expect(screen.getByTestId("sidebar-network-position").textContent).toBe("3");
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("VPN");
  });

  it("counts from 1, not from 0", () => {
    renderWidget([wifi(), ethernet()]);
    expect(screen.getByTestId("sidebar-network-position").textContent).toBe("1");
  });

  it("keeps the total in the tooltip", () => {
    renderWidget([wifi(), ethernet(), vpn()]);
    expect(screen.getByTestId("sidebar-network").getAttribute("title") ?? "").toContain(
      "interface 1 of 3",
    );
  });

  it("wraps the position along with the card", () => {
    renderWidget([wifi(), ethernet()]);
    fireEvent.click(screen.getByTestId("sidebar-network-prev"));
    expect(screen.getByTestId("sidebar-network-position").textContent).toBe("2");
  });

  it("wraps in both directions rather than dead-ending", () => {
    renderWidget([wifi(), ethernet()]);
    fireEvent.click(screen.getByTestId("sidebar-network-prev"));
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("ETHERNET");
    fireEvent.click(screen.getByTestId("sidebar-network-next"));
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("WI-FI");
  });

  it("recovers when the selected interface disappears", () => {
    // A cable is unplugged or a VPN drops while the user is looking at
    // it. A stale index would render nothing — or worse, a different
    // link than the one they paged to.
    const { rerender } = renderWidget([wifi(), ethernet(), vpn()]);
    fireEvent.click(screen.getByTestId("sidebar-network-next"));
    fireEvent.click(screen.getByTestId("sidebar-network-next"));
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("VPN");

    rerender(
      <SystemLoadProvider value={series()}>
        <NetworkProvider value={{ interfaces: [wifi()] }}>
          <NetworkWidget visible={true} />
        </NetworkProvider>
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("WI-FI");
    // Down to one interface, so the pager goes too — there is nothing
    // left to page between.
    expect(screen.queryByTestId("sidebar-network-pager")).not.toBeInTheDocument();
  });

  it("stays on the same interface when one EARLIER in the list vanishes", () => {
    // The reason selection is by name. With an index, removing the
    // first interface would slide the card onto a neighbour while the
    // user was looking at it — describing the wrong link with no
    // visible cue.
    const { rerender } = renderWidget([wifi(), ethernet(), vpn()]);
    fireEvent.click(screen.getByTestId("sidebar-network-next"));
    fireEvent.click(screen.getByTestId("sidebar-network-next"));
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("VPN");

    rerender(
      <SystemLoadProvider value={series()}>
        <NetworkProvider value={{ interfaces: [ethernet(), vpn()] }}>
          <NetworkWidget visible={true} />
        </NetworkProvider>
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("VPN");
    expect(screen.getByTestId("sidebar-network-position").textContent).toBe("2");
  });

  it("survives the list being reordered underneath it", () => {
    // The 30s refresh can return a different order — a new primary,
    // for instance. Selection must follow the interface, not the slot.
    const { rerender } = renderWidget([wifi(), ethernet()]);
    fireEvent.click(screen.getByTestId("sidebar-network-next"));
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("ETHERNET");

    rerender(
      <SystemLoadProvider value={series()}>
        <NetworkProvider value={{ interfaces: [ethernet(), wifi()] }}>
          <NetworkWidget visible={true} />
        </NetworkProvider>
      </SystemLoadProvider>,
    );
    expect(screen.getByTestId("sidebar-network-pill").textContent).toBe("ETHERNET");
    expect(screen.getByTestId("sidebar-network-position").textContent).toBe("1");
  });

  it("renders an offline card when nothing holds an address", () => {
    renderWidget([]);
    expect(screen.getByTestId("sidebar-network-label").textContent).toBe("Offline");
    expect(screen.queryByTestId("sidebar-network-ip")).not.toBeInTheDocument();
  });
});

describe("NetworkWidget / joining the two cadences", () => {
  it("matches rates to the interface by NAME, not by position", () => {
    // The two sources refresh on different timers and can disagree
    // about ordering. Matching positionally would silently attribute
    // one interface's traffic to another.
    renderWidget(
      [wifi(), ethernet()],
      [
        { name: "en5", up_bps: 4_800_000, down_bps: 1_100_000 },
        { name: "en0", up_bps: 88_000, down_bps: 12_000 },
      ],
    );
    expect(screen.getByTestId("sidebar-network-up").textContent).toContain("88 KB/s");
    fireEvent.click(screen.getByTestId("sidebar-network-next"));
    expect(screen.getByTestId("sidebar-network-up").textContent).toContain("4.8 MB/s");
  });

  it("omits throughput entirely when the sampler has no rate for it", () => {
    // The first sample carries no rates at all. Showing 0 B/s would
    // claim an idle link rather than an unmeasured one.
    renderWidget([wifi()], []);
    expect(screen.queryByTestId("sidebar-network-throughput")).not.toBeInTheDocument();
  });
});

describe("NetworkWidget / never claiming what it can't read", () => {
  it("falls back to 'Wi-Fi' when the name is unavailable", () => {
    expect(identityFor(wifiWith({ ssid: null }), null)).toBe("Wi-Fi");
  });

  it("names an unclassifiable interface by its device name", () => {
    // The `Wired` bug in one assertion: an interface we can't
    // characterise must not be labelled a medium we don't know it is.
    const other = wifi({ kind: "other", name: "bridge100", wifi: null });
    expect(identityFor(other, null)).toBe("bridge100");
    expect(identityFor(other, null)).not.toBe("Wired LAN");
  });

  it("omits the detail line when nothing was readable", () => {
    expect(detailFor(wifiWith({ channel: null, security: null, captive: false }))).toBeNull();
  });

  it("builds the detail line from whatever was readable", () => {
    expect(detailFor(wifiWith({ security: null }))).toBe("ch 6");
  });

  it("omits the link speed when the port reports none", () => {
    // Every wired port on the development machine reads `media: none`.
    const dark = ethernet({ link: { speed_mbps: null, media: null, full_duplex: null } });
    expect(headlineFor(dark)).toBeNull();
  });

  it("formats sub-gigabit speeds in Mb/s", () => {
    const fast = ethernet({ link: { speed_mbps: 100, media: null, full_duplex: null } });
    expect(headlineFor(fast)).toBe("100 Mb/s");
  });

  it("renders no signal bars when there is no reading", () => {
    renderWidget([wifiWith({ bars: null, rssi: null })]);
    expect(screen.queryByTestId("sidebar-network-bars")).not.toBeInTheDocument();
  });

  it("fills exactly as many bars as the reading supports", () => {
    renderWidget([wifi()]);
    expect(screen.getByTestId("sidebar-network-bars").getAttribute("data-bars")).toBe("3");
  });
});

describe("NetworkWidget / asking for the name (macOS)", () => {
  it("offers the prompt only when it would help", () => {
    renderWidget([wifiWith({ ssid: null, ssid_access: "not_determined" })]);
    expect(screen.getByTestId("sidebar-network-grant")).toBeInTheDocument();
    expect(requestAccessMock).not.toHaveBeenCalled();
  });

  it("waits for the OS dialog to be answered, then shows the name", async () => {
    // The regression this replaced: `wifiRequestSsidAccess` returns
    // before the user has answered, so using its return value as the
    // answer meant the click always resolved to "no name" and the
    // button looked dead.
    renderWidget([wifiWith({ ssid: null, ssid_access: "not_determined" })]);
    fireEvent.click(screen.getByTestId("sidebar-network-grant"));
    await waitFor(
      () => expect(screen.getByTestId("sidebar-network-label").textContent).toBe("GrantedNet"),
      { timeout: 4000 },
    );
    expect(wifiInfoMock).toHaveBeenCalled();
  });

  it("says it is waiting rather than looking inert", async () => {
    renderWidget([wifiWith({ ssid: null, ssid_access: "not_determined" })]);
    const button = screen.getByTestId("sidebar-network-grant");
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toContain("Waiting"));
    expect(button).toBeDisabled();
  });

  it("does not stack requests when clicked repeatedly", async () => {
    renderWidget([wifiWith({ ssid: null, ssid_access: "not_determined" })]);
    const button = screen.getByTestId("sidebar-network-grant");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(requestAccessMock).toHaveBeenCalledTimes(1));
  });

  it("leaves the card unchanged when the user never answers", async () => {
    // A prompt the user walks away from must not leave the button
    // spinning forever, nor invent a name.
    wifiInfoMock.mockResolvedValue({
      medium: "wi_fi",
      ssid: null,
      ssid_access: "not_determined",
    });
    renderWidget([wifiWith({ ssid: null, ssid_access: "not_determined" })]);
    fireEvent.click(screen.getByTestId("sidebar-network-grant"));
    await waitFor(() => expect(wifiInfoMock).toHaveBeenCalled());
    expect(screen.getByTestId("sidebar-network-label").textContent).toBe("Wi-Fi");
  });

  it("never offers it on a wired link", () => {
    renderWidget([ethernet()]);
    expect(screen.queryByTestId("sidebar-network-grant")).not.toBeInTheDocument();
  });

  it("never offers it once declined", () => {
    renderWidget([wifiWith({ ssid: null, ssid_access: "denied" })]);
    expect(screen.queryByTestId("sidebar-network-grant")).not.toBeInTheDocument();
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
    expect(formatRate(1_048_576)).toBe("1.0 MB/s");
  });
});

describe("NetworkWidget / rail", () => {
  it("shows a glyph and no card", () => {
    renderWidget([wifi()], [], false);
    expect(screen.getByTestId("sidebar-network-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-network")).not.toBeInTheDocument();
  });
});
