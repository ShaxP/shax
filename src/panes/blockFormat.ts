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

/**
 * Compact "when did this run" string. Same shape everywhere a block's
 * `started_at_ms` is surfaced (block list, search results, viewer):
 *
 *   today      → `Today at HH:MM`
 *   yesterday  → `Yesterday at HH:MM`
 *   same year  → `Mon DD HH:MM`
 *   older      → `Mon DD, YYYY`
 *
 * `nowMs` is parameterised so tests can fix "today" deterministically.
 */
export function formatTimestamp(ms: number, nowMs: number = Date.now()): string {
  const date = new Date(ms);
  const now = new Date(nowMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `Today at ${hh}:${mm}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday at ${hh}:${mm}`;
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) {
    return `${month} ${day} ${hh}:${mm}`;
  }
  return `${month} ${day}, ${date.getFullYear()}`;
}

/**
 * Compact a cwd string for display in the tab, prompt strip, and
 * statusline (M7.6).
 *
 *   `/Users/ada/dev/shax`      + `/Users/ada`  → `~/dev/shax`
 *   `/tmp/scratch`             + `/Users/ada`  → `/tmp/scratch` (unchanged)
 *   `/Users/ada`               + `/Users/ada`  → `~`
 *
 * A `maxLength` cap collapses long descendants to `~/…/<lastseg>` so a
 * deep tree doesn't blow out the chip width. The tail (last path
 * segment) is always preserved because it's the piece users recognise
 * (`shax`, not `Users`).
 *
 * `home` is `null` when the backend couldn't resolve the user's home
 * directory (rare — headless sandbox); we then just apply the length
 * cap and return the shortened absolute path.
 */
export function compactCwd(cwd: string | null, home: string | null, maxLength = 28): string {
  if (cwd === null || cwd.length === 0) return "—";
  let display = cwd;
  if (home !== null && home.length > 0) {
    const normalisedHome = home.replace(/\/+$/, "");
    if (display === normalisedHome) {
      display = "~";
    } else if (display.startsWith(normalisedHome + "/")) {
      display = "~" + display.slice(normalisedHome.length);
    }
  }
  if (display.length <= maxLength) return display;
  const slash = display.lastIndexOf("/");
  if (slash <= 0) return display; // No parent to collapse.
  const tail = display.slice(slash); // Includes the leading slash.
  // If the tail alone exceeds the cap (a very long single path
  // segment), fall back to just the tail — we can't compress an
  // atomic segment. Otherwise glue the sensible prefix in front.
  const prefix = display.startsWith("~/") ? "~/…" : "…";
  const shortened = `${prefix}${tail}`;
  return shortened.length <= display.length ? shortened : display;
}
