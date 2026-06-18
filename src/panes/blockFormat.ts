/**
 * Small pure helpers for rendering block metadata.
 *
 * Kept separate from the React components so they can be tested in isolation
 * without rendering, and reused by future block surfaces (search results,
 * widget headers, etc.).
 */

/**
 * Humanize a millisecond duration the way a developer skims it:
 *   - `12ms` below 1s
 *   - `1.84s` below 60s
 *   - `1:23` for 1 minute and beyond (mm:ss)
 *   - `1:02:03` for an hour and beyond
 *
 * Negative or NaN inputs render as `--`.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return "--";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const padded = (n: number): string => n.toString().padStart(2, "0");
  if (hours > 0) return `${hours}:${padded(minutes)}:${padded(secs)}`;
  return `${minutes}:${padded(secs)}`;
}
