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

export interface NetworkInfo {
  /** Wi-Fi SSID name; null when disconnected, probe fails, or on
   *  macOS (always — see `system_ssid` doc). */
  ssid: string | null;
  /** IPv4 of the default-route interface; null when offline / probe
   *  fails. Same value the statusbar chip reads via props. */
  localIp: string | null;
}

const OFFLINE: NetworkInfo = { ssid: null, localIp: null };

export const NetworkContext = createContext<NetworkInfo>(OFFLINE);

export const NetworkProvider = NetworkContext.Provider;

export function useNetwork(): NetworkInfo {
  return useContext(NetworkContext);
}
