/**
 * ClockContext — the App-level 1s tick, shared with any surface
 * that needs a live time signal.
 *
 * Consumers receive the raw `Date` and format as they see fit —
 * the statusbar shows HH:MM:SS, the sidebar clock shows HH:MM,
 * both compute their own labels via useMemo. Keeping the shape
 * to a Date (not a pre-formatted string) means one context for
 * every current and future consumer without a widening rewrite
 * each time a new caller wants a different format.
 *
 * The provider is set up once in App.tsx around the same
 * setInterval that has driven the statusbar clock since M12.4b.
 *
 * Same shape as `AssistantDockContext` / `HomeDirContext`.
 */

import { createContext, useContext } from "react";

/** Wall-clock time, refreshed every 1s. */
export const ClockContext = createContext<Date>(new Date(0));

export const ClockProvider = ClockContext.Provider;

/** Subscribe to the App-level 1s tick. Consumers re-render every
 *  second — cheap when the consumer's tree is small, and the
 *  natural cost of showing a live clock. */
export function useClock(): Date {
  return useContext(ClockContext);
}
