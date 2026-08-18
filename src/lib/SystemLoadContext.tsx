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
import type { SystemLoad } from "./ipc";

const ZERO: SystemLoad = {
  cpu_percent: 0,
  mem_used_bytes: 0,
  mem_total_bytes: 0,
  load_average_one: null,
  core_count: null,
};

/** Latest CPU + memory snapshot. Consumers get a valid `SystemLoad`
 *  shape immediately (ZERO before the first probe resolves). */
export const SystemLoadContext = createContext<SystemLoad>(ZERO);

export const SystemLoadProvider = SystemLoadContext.Provider;

export function useSystemLoad(): SystemLoad {
  return useContext(SystemLoadContext);
}
