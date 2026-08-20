/**
 * CpuWidget (M13.3, rebuilt to match design/widget-sidebar.png).
 *
 * Card layout, measured off the mockup:
 *   - Header row: "CPU LOAD" label (ALL-CAPS, dimmed) + green
 *     percentage on the right.
 *   - A 24-bar sparkline of recent samples, 20px tall, the newest
 *     sample picked out in green.
 *   - Footer row: one-minute load average on the left, physical core
 *     count on the right, both in dim mono.
 *
 * The sparkline replaced a single progress bar. A bar shows the
 * instantaneous number the percentage already states; the history
 * answers the question a user actually opens the sidebar for during
 * a build — "is this climbing, or did it spike and settle?"
 *
 * History lives here rather than in the backend. It is a view
 * concern, it costs one array of 24 floats, and the probe stays a
 * pure snapshot. The buffer survives ⌘B (the component stays mounted
 * across rail/expanded) and resets on reload, which is the honest
 * lifetime for "recent activity in this window".
 *
 * Rail state renders a two-character percent (`43`) — dense numeric
 * information beats a generic 📊 emoji for the same space.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { SystemLoad } from "../../lib/ipc";
import { useSystemLoad } from "../../lib/SystemLoadContext";
import { CARD, CARD_HEADER, CARD_LABEL } from "./styles";

/** Bars in the sparkline. At the 2s poll cadence this is ~48s of
 *  history, and at 6px + 2px gap it fills the card's inner width. */
export const SAMPLES = 24;

/** Shortest bar we draw for a real sample. A 0% reading would
 *  otherwise render as nothing at all and read as "no data", which is
 *  a different statement from "idle". Empty slots — genuinely no
 *  sample yet — render nothing, so the nub is unambiguous. */
export const MIN_BAR_PERCENT = 15;

const PERCENT_VALUE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 15,
  fontWeight: 600,
  // Green matches the design's "healthy metric" accent language.
  // A future follow-up could flip to --amber above 70% and --red
  // above 90%; keeping it green to match the mockup.
  color: "var(--green)",
};

const SPARKLINE: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 2,
  height: 20,
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
  const load = useSystemLoad();

  // Hide until the sysinfo probe returns something real — before
  // that mem_total_bytes is zero, which we use as the "no data yet"
  // sentinel across both CPU and Memory widgets (they share the
  // same probe, so if memory isn't ready, CPU's initial 0% is
  // equally uninformative).
  const ready = load.mem_total_bytes > 0;

  const [history, setHistory] = useState<number[]>([]);
  // App hands us a fresh object per poll, so object identity is the
  // tick. Comparing on it rather than on `cpu_percent` keeps two
  // consecutive identical readings as two samples — a flat line is
  // real history, not a dropped one — while a re-render that isn't a
  // new poll (StrictMode's double effect, a parent re-render) adds
  // nothing.
  const lastSampleRef = useRef<SystemLoad | null>(null);
  useEffect(() => {
    if (!ready || lastSampleRef.current === load) return;
    lastSampleRef.current = load;
    setHistory((previous) => [...previous, load.cpu_percent].slice(-SAMPLES));
  }, [load, ready]);

  // Left-pad with empty slots so bars fill from the right as history
  // accumulates, keeping bar width fixed. `null` means "no sample
  // yet" and draws nothing — we don't invent a reading to make the
  // card look full (fidelity contract).
  const slots = useMemo<Array<number | null>>(
    () => [...Array<number | null>(Math.max(0, SAMPLES - history.length)).fill(null), ...history],
    [history],
  );

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
        <span style={PERCENT_VALUE} data-testid="sidebar-cpu-percent">
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

/** One bar. `null` is an unfilled slot and draws nothing; the newest
 *  sample is picked out in green, matching the mockup. */
function barStyle(sample: number | null, isNewest: boolean): CSSProperties {
  if (sample === null) return BAR_BASE;
  const height = Math.max(MIN_BAR_PERCENT, Math.min(100, sample));
  return {
    ...BAR_BASE,
    height: `${height}%`,
    background: isNewest ? "var(--green)" : "var(--fg-faint)",
    // The history reads as a backdrop to the current value rather
    // than competing with it.
    opacity: isNewest ? 1 : 0.55,
  };
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
