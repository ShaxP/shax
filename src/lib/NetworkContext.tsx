/**
 * NetworkContext — SSID + default-route IP, polled at 30s in App
 * and exposed to the sidebar Network widget (M13.3).
 *
 * Both fields are optional (null when the probe fails / when the
 * host is disconnected / when macOS masks the SSID). The widget
 * hides individual lines when their field is null; if both are null
 * the widget renders an "offline" state (single red dot).
 *
 * `localIp` here mirrors the App-level useState that also feeds the
 * statusbar chip via props (M12.4b). Same source, two consumption
 * paths — no divergence.
 */

import { createContext, useContext } from "react";
import type { NetInterface } from "./ipc";

export interface NetworkInfo {
  /** Every interface that is up and holds an address, primary first.
   *  Empty before the first probe resolves, and outside Tauri. */
  interfaces: NetInterface[];
}

const OFFLINE: NetworkInfo = { interfaces: [] };

/** The machine's addressed interfaces, refreshed at 30s.
 *
 *  Throughput is deliberately NOT here — it is a delta, lives on the
 *  2s sampler, and the Network card joins the two by interface name
 *  (spec §19 D5 item 3). */
export const NetworkContext = createContext<NetworkInfo>(OFFLINE);

export const NetworkProvider = NetworkContext.Provider;

export function useNetwork(): NetworkInfo {
  return useContext(NetworkContext);
}
