/**
 * SystemLoadContext — CPU% + memory-in-use, polled at 2s in App
 * and exposed to the sidebar CpuMem widget (M13.3).
 *
 * Split from NetworkContext because the two probes tick at
 * different cadences (2s vs 30s). A combined context would
 * re-render network consumers every 2s and CPU consumers every
 * 30s along with the other's tick. Two thin contexts keep each
 * subscriber's re-render surface honest.
 *
 * Same shape as ClockContext / FocusedPaneContext.
 */

import { createContext, useContext } from "react";
import type { SystemLoad, SystemLoadSeries } from "./ipc";

const ZERO: SystemLoadSeries = {
  current: {
    cpu_percent: 0,
    mem_used_bytes: 0,
    mem_total_bytes: 0,
    load_average_one: null,
    core_count: null,
  },
  net_rates: [],
  history: [],
};

/** Latest CPU + memory snapshot and the recent CPU history behind it.
 *  Consumers get a valid shape immediately (ZERO before the first
 *  read resolves).
 *
 *  Both halves come from the backend's single sampler rather than a
 *  per-window poll, so every window agrees — see `SystemLoadSeries`
 *  in `status.rs`. */
export const SystemLoadContext = createContext<SystemLoadSeries>(ZERO);

export const SystemLoadProvider = SystemLoadContext.Provider;

/** The whole series. Only the CPU card needs the history. */
export function useSystemLoadSeries(): SystemLoadSeries {
  return useContext(SystemLoadContext);
}

/** Just the latest snapshot, for consumers that don't care about
 *  history (the Memory card). */
export function useSystemLoad(): SystemLoad {
  return useContext(SystemLoadContext).current;
}
