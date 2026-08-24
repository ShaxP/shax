/**
 * BatteryContext — the machine's power state, polled at 30s in App
 * and exposed to the sidebar Battery widget (M13.5.3) alongside the
 * existing statusbar chip (M12.4b).
 *
 * Two consumers, one source: App owns the state, both the statusbar
 * and the sidebar read from it. The statusbar's `battery` prop path
 * is preserved for now — D9 of the spec defers the "what does the
 * statusbar carry once the sidebar has it too?" consolidation to a
 * separate follow-up. When that lands, one of the two will drop.
 *
 * The context defaults to the absent sentinel so any widget that
 * mounts outside a `BatteryProvider` (e.g. component tests that
 * don't wrap) renders the same "no battery" state a desktop machine
 * would show — never crashes, never invents a reading.
 */

import { createContext, useContext } from "react";
import type { BatteryStatus } from "./ipc";

const BATTERY_ABSENT: BatteryStatus = {
  present: false,
  percent: null,
  on_ac_power: false,
  charging: false,
  seconds_remaining: null,
};

export const BatteryContext = createContext<BatteryStatus>(BATTERY_ABSENT);

export const BatteryProvider = BatteryContext.Provider;

export function useBattery(): BatteryStatus {
  return useContext(BatteryContext);
}
