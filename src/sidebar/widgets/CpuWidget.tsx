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
  borderRadius: 1,
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
  alignItems: "center",
  justifyContent: "center",
  height: 32,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--fg-dim)",
  cursor: "default",
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
    return (
      <div data-testid="sidebar-cpu-rail" style={RAIL_ROOT} title={tooltip}>
        {Math.round(load.cpu_percent).toString().padStart(2, "0")}
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
        {slots.map((sample, index) => (
          <div
            // Index is the right key here: slots are positional (a
            // fixed-length window over time), not identities.
            key={index}
            data-testid={sample === null ? "sidebar-cpu-bar-empty" : "sidebar-cpu-bar"}
            style={barStyle(sample, index === slots.length - 1)}
          />
        ))}
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

/** One bar. `null` is an unfilled slot and draws nothing.
 *
 *  Every bar carries its *own* load's colour, not the current one —
 *  that's what makes the history worth drawing: a red stretch behind
 *  a green newest bar says "it spiked and recovered", which a
 *  uniformly-tinted chart cannot say.
 *
 *  Recency is carried by opacity instead, so the two signals stay
 *  independent: hue is how hot, brightness is how recent. */
function barStyle(sample: number | null, isNewest: boolean): CSSProperties {
  if (sample === null) return BAR_BASE;
  return {
    ...BAR_BASE,
    height: `${Math.max(0, Math.min(100, sample))}%`,
    minHeight: MIN_BAR_PX,
    background: heatColour(sample),
    // High enough that a dimmed red still reads as red rather than
    // drifting toward the amber band.
    opacity: isNewest ? 1 : 0.65,
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
