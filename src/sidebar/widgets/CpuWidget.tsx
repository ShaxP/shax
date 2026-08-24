/**
 * CpuWidget (M13.3, rebuilt to match design/widget-sidebar.png).
 *
 * Card layout, measured off the mockup:
 *   - Header row: "CPU LOAD" label (ALL-CAPS, dimmed) + green
 *     percentage on the right.
 *   - A 24-bar sparkline of recent samples, each bar coloured by its
 *     own load (green / amber / red). Taller than the mockup's 20px
 *     — at that height a 100% bar reads as a stub rather than a
 *     spike, and the whole point of the sparkline is the shape of
 *     the trend.
 *   - Footer row: one-minute load average on the left, physical core
 *     count on the right, both in dim mono.
 *
 * The sparkline replaced a single progress bar. A bar shows the
 * instantaneous number the percentage already states; the history
 * answers the question a user actually opens the sidebar for during
 * a build — "is this climbing, or did it spike and settle?"
 *
 * History comes from the backend, not from a buffer kept here. It
 * started life in this component and moved when two open windows
 * showed different charts for one machine: they sampled at different
 * instants, and each poll reset the shared `System`'s delta baseline
 * for the others. CPU usage is host-global (spec §19 D3), so one
 * sampler owns the cadence and every window renders what it is
 * given.
 *
 * Rail state renders a two-character percent (`43`) — dense numeric
 * information beats a generic 📊 emoji for the same space.
 */

import { useMemo, type CSSProperties } from "react";
import type { SystemLoad } from "../../lib/ipc";
import { useSystemLoadSeries } from "../../lib/SystemLoadContext";
import { CARD, CARD_HEADER, CARD_LABEL } from "./styles";

/** Slots in the sparkline. Must match `status.rs`'s `HISTORY_LEN` —
 *  the backend decides how much history exists; this is how many
 *  places we have to draw it. At the sampler's 2s cadence that is
 *  ~48s, and at 6px + 2px gap it fills the card's inner width. */
export const SAMPLES = 24;

/** Sparkline height. Deliberately taller than the mockup's 20px:
 *  a full-scale bar needs the room to read as a spike. */
export const SPARKLINE_HEIGHT = 50;

/** Shortest bar we draw for a real sample. A 0% reading would
 *  otherwise render as nothing at all and read as "no data", which is
 *  a different statement from "idle". Empty slots — genuinely no
 *  sample yet — render nothing, so the nub is unambiguous.
 *
 *  In pixels, not a percentage of the track: as a percentage it
 *  scales with the height, so making the sparkline taller would
 *  silently inflate every idle reading. Bar height should map to the
 *  value, and the floor should only rescue zero from invisibility. */
export const MIN_BAR_PX = 3;

/** Load at or above which a bar turns amber, then red.
 *
 *  Boundaries are inclusive on the hotter side: exactly 50 reads
 *  amber, exactly 80 reads red. CPU readings are fractional, so
 *  "below 50 / 51-79 / above 80" has to close its gaps somewhere, and
 *  erring hot means a machine under pressure is never flattered. */
export const AMBER_AT = 50;
export const RED_AT = 80;

const PERCENT_VALUE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 15,
  fontWeight: 600,
};

const SPARKLINE: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 2,
  height: SPARKLINE_HEIGHT,
};

const BAR_BASE: CSSProperties = {
  flex: 1,
  // Rounded top corners only. Bars grow up from the shared baseline
  // (`alignItems: flex-end` on the sparkline), so the top is the
  // growing edge and rounding it softens the row of tips per
  // `design/sidebar-extended.png`. The bottom sits on the baseline
  // where rounding would either be invisible or, worse, chip a
  // pixel off the edge of the sparkline's frame.
  borderTopLeftRadius: 2,
  borderTopRightRadius: 2,
  minWidth: 0,
};

const FOOTER: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
};

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  cursor: "default",
};

// Mini sparkline sits above the percent (§D11) — same bar treatment
// as the extended CPU card, scaled to the rail's ~40 px content
// area. The extended card shows 24 samples (SAMPLES); the rail
// shows the newest RAIL_SAMPLES per the design brief. Six bars in
// a 40 px track leaves ~5.8 px per bar with a 1 px gap — wide
// enough that a 1 px inter-bar gap reads as real separation
// rather than eating into a hairline, which is why the gap comes
// back at this density (versus the earlier 12-bar no-gap tune).
export const RAIL_SAMPLES = 6;

const RAIL_SPARKLINE: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 1,
  width: 40,
  // Doubled from the initial 12 px: at 12 px a 100 % reading was a
  // stub that read as a bar rather than a spike, and a full-scale
  // reading is exactly what the eye wants the rail to shout about.
  // 24 px still leaves plenty of vertical room for the percent
  // label underneath before the card starts pushing on its
  // neighbours (the widget slot is scrollable).
  height: 24,
};

const RAIL_BAR_BASE: CSSProperties = {
  flex: 1,
  // `minWidth: 1` (not 0) so browsers don't collapse a narrow bar
  // to zero on sub-pixel rounding. At RAIL_SAMPLES = 6 in a 40 px
  // track (~5.8 px per bar) this is never binding, but it defends
  // the invariant against future tuning.
  minWidth: 1,
  borderTopLeftRadius: 1,
  borderTopRightRadius: 1,
};

const RAIL_PERCENT: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 600,
  color: "var(--fg-dim)",
};

export interface CpuWidgetProps {
  visible: boolean;
}

export function CpuWidget({ visible }: CpuWidgetProps): React.ReactElement | null {
  const { current: load, history } = useSystemLoadSeries();

  // Hide until the sysinfo probe returns something real — before
  // that mem_total_bytes is zero, which we use as the "no data yet"
  // sentinel across both CPU and Memory widgets (they share the
  // same probe, so if memory isn't ready, CPU's initial 0% is
  // equally uninformative).
  const ready = load.mem_total_bytes > 0;

  // Left-pad with empty slots so bars fill from the right as history
  // accumulates, keeping bar width fixed. `null` means "no sample
  // yet" and draws nothing — we don't invent a reading to make the
  // card look full (fidelity contract).
  const slots = useMemo<Array<number | null>>(() => {
    // Defensive trim: the backend bounds this, but the widget should
    // not blow out the card's layout if the two ever disagree.
    const recent = history.slice(-SAMPLES);
    return [...Array<number | null>(Math.max(0, SAMPLES - recent.length)).fill(null), ...recent];
  }, [history]);

  const cpuLabel = useMemo(() => `${Math.round(load.cpu_percent)}%`, [load.cpu_percent]);
  const tooltip = useMemo(
    () => (ready ? buildTooltip(cpuLabel, load) : "CPU load probe not available"),
    [ready, cpuLabel, load],
  );

  if (!ready) return null;

  if (!visible) {
    // Rail: newest `RAIL_SAMPLES` slots from the shared history,
    // same bar treatment as the extended sparkline. Historical
    // bars render `--fg-faint` with the recency-gradient opacity;
    // newest takes its heat colour at full opacity.
    //
    // Left-pad with empty slots if we don't yet have RAIL_SAMPLES
    // real samples so the bars grow in from the right rather than
    // spreading and jumping widths as history builds.
    const railTail = slots.slice(-RAIL_SAMPLES);
    const railSlots: Array<number | null> = [
      ...Array<number | null>(Math.max(0, RAIL_SAMPLES - railTail.length)).fill(null),
      ...railTail,
    ];
    return (
      <div data-testid="sidebar-cpu-rail" style={RAIL_ROOT} title={tooltip}>
        <div style={RAIL_SPARKLINE} data-testid="sidebar-cpu-rail-sparkline">
          {railSlots.map((sample, index) => {
            const isNewest = index === railSlots.length - 1;
            const maxHistoricalIndex = Math.max(1, railSlots.length - 2);
            const historicalT = Math.min(1, index / maxHistoricalIndex);
            return (
              <div
                key={index}
                data-testid={
                  sample === null ? "sidebar-cpu-rail-bar-empty" : "sidebar-cpu-rail-bar"
                }
                style={railBarStyle(sample, isNewest, historicalT)}
              />
            );
          })}
        </div>
        <span
          style={{ ...RAIL_PERCENT, color: heatColour(load.cpu_percent) }}
          data-testid="sidebar-cpu-rail-percent"
        >
          {Math.round(load.cpu_percent).toString().padStart(2, "0")}
        </span>
      </div>
    );
  }

  const loadLabel =
    load.load_average_one === null ? null : `load ${load.load_average_one.toFixed(2)}`;
  const coreLabel = coreCountLabel(load.core_count);

  return (
    <div data-testid="sidebar-cpu" style={CARD} title={tooltip}>
      <div style={CARD_HEADER}>
        <span style={CARD_LABEL}>CPU load</span>
        <span
          style={{ ...PERCENT_VALUE, color: heatColour(load.cpu_percent) }}
          data-testid="sidebar-cpu-percent"
        >
          {cpuLabel}
        </span>
      </div>
      <div style={SPARKLINE} data-testid="sidebar-cpu-sparkline" aria-hidden="true">
        {slots.map((sample, index) => {
          const isNewest = index === slots.length - 1;
          // Gradient position over the historical bars: 0 at the
          // oldest, 1 at the newest historical (the one just before
          // the current). The newest bar itself ignores this — it
          // uses the heat colour at full opacity.
          const maxHistoricalIndex = Math.max(1, slots.length - 2);
          const historicalT = Math.min(1, index / maxHistoricalIndex);
          return (
            <div
              // Index is the right key here: slots are positional (a
              // fixed-length window over time), not identities.
              key={index}
              data-testid={sample === null ? "sidebar-cpu-bar-empty" : "sidebar-cpu-bar"}
              style={barStyle(sample, isNewest, historicalT)}
            />
          );
        })}
      </div>
      {(loadLabel !== null || coreLabel !== null) && (
        <div style={FOOTER}>
          <span data-testid="sidebar-cpu-loadavg">{loadLabel ?? ""}</span>
          <span data-testid="sidebar-cpu-cores">{coreLabel ?? ""}</span>
        </div>
      )}
    </div>
  );
}

/** Opacity for the oldest historical bar. Above 0 so the bar still
 *  reads as a bar rather than as an empty slot; low enough that the
 *  gradient toward the newest bar is visible.
 *
 *  These two constants define the gradient the mockup shows: older
 *  bars are dimmer, newer historical bars are brighter, and the
 *  newest bar (heat-coloured) sits at full opacity above them. */
const HISTORICAL_MIN_OPACITY = 0.4;
const HISTORICAL_MAX_OPACITY = 0.9;

/** One bar. `null` is an unfilled slot and draws nothing.
 *
 *  Historical bars render in a monochrome faint colour with an
 *  opacity gradient from oldest (dim) to newest historical (bright);
 *  only the newest bar itself carries its heat colour — the current
 *  reading. This matches `design/sidebar-extended.png`.
 *
 *  Earlier drafts heat-mapped every bar (with opacity for recency)
 *  so a red stretch behind a green newest bar read as "it spiked
 *  and recovered". The refreshed mockup deliberately trades that
 *  magnitude signal for a calmer visual: history is shape-only
 *  (activity vs quiet), magnitude comes from the current bar plus
 *  the header percent, and recency is carried by the gradient
 *  brightness alone. Spec §19 D5 item 2 is amended for the change. */
function barStyle(sample: number | null, isNewest: boolean, historicalT: number): CSSProperties {
  return sharedBarStyle(BAR_BASE, sample, isNewest, historicalT, MIN_BAR_PX);
}

/** Rail-state bar. Same rules as `barStyle` but uses the smaller
 *  `RAIL_BAR_BASE` and a 1-pixel minimum height — the rail's
 *  sparkline is short, so a 3 px idle floor would eat half the
 *  chart. */
function railBarStyle(
  sample: number | null,
  isNewest: boolean,
  historicalT: number,
): CSSProperties {
  return sharedBarStyle(RAIL_BAR_BASE, sample, isNewest, historicalT, 1);
}

/** The shared rule used by both extended and rail sparkline bars.
 *  Null → empty slot; newest → heat colour at full opacity; older
 *  → monochrome `--fg-faint` with a left-to-right opacity gradient.
 *  Split out so the two callers agree on the treatment and a tuning
 *  change to the recency gradient moves both in lockstep. */
function sharedBarStyle(
  base: CSSProperties,
  sample: number | null,
  isNewest: boolean,
  historicalT: number,
  minHeightPx: number,
): CSSProperties {
  if (sample === null) return base;
  const height = `${Math.max(0, Math.min(100, sample))}%`;
  if (isNewest) {
    return {
      ...base,
      height,
      minHeight: minHeightPx,
      background: heatColour(sample),
    };
  }
  const opacity =
    HISTORICAL_MIN_OPACITY + (HISTORICAL_MAX_OPACITY - HISTORICAL_MIN_OPACITY) * historicalT;
  return {
    ...base,
    height,
    minHeight: minHeightPx,
    background: "var(--fg-faint)",
    opacity,
  };
}

/** Green below `AMBER_AT`, amber below `RED_AT`, red at or above it. */
export function heatColour(percent: number): string {
  if (percent >= RED_AT) return "var(--red)";
  if (percent >= AMBER_AT) return "var(--amber)";
  return "var(--green)";
}

/** `4 cores` / `1 core`, or null when the platform won't say. */
function coreCountLabel(cores: number | null): string | null {
  if (cores === null || cores <= 0) return null;
  return `${cores} ${cores === 1 ? "core" : "cores"}`;
}

function buildTooltip(cpuLabel: string, load: SystemLoad): string {
  const parts = [`CPU load: ${cpuLabel}`];
  if (load.load_average_one !== null) {
    parts.push(`1-min load average: ${load.load_average_one.toFixed(2)}`);
  }
  const cores = coreCountLabel(load.core_count);
  if (cores !== null) parts.push(cores);
  return parts.join(" · ");
}
