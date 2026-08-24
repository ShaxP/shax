/**
 * DiskContext — the machine's mounted volumes, polled at the same
 * slow cadence as `netInterfaces` and `systemBattery` in App, and
 * exposed to the sidebar Disk widget (M13.5.4, spec §19 D10).
 *
 * Empty before the first poll resolves and outside Tauri (the
 * browser dev shell has no volume enumeration to offer). Same
 * graceful-degradation shape the M13 widgets already follow —
 * absent data → widget hides itself.
 */

import { createContext, useContext } from "react";
import type { VolumeInfo } from "./ipc";

export interface DiskInfo {
  /** Mounted volumes in OS enumeration order. Empty before the
   *  first probe and outside Tauri. */
  volumes: VolumeInfo[];
}

const EMPTY: DiskInfo = { volumes: [] };

export const DiskContext = createContext<DiskInfo>(EMPTY);

export const DiskProvider = DiskContext.Provider;

export function useDisk(): DiskInfo {
  return useContext(DiskContext);
}
