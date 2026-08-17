/**
 * CpuWidget (M13.3, restyled per design/widget-sidebar.png).
 *
 * Card layout:
 *   - Header row: "CPU LOAD" label (ALL-CAPS, dimmed) + big
 *     accent-green percentage on the right.
 *   - Progress bar spanning the full card width.
 *
 * Split out of the original CpuMemWidget in this design refresh
 * — the mockup shows CPU and Memory as separate cards. Backend
 * probe unchanged (`system_cpu_and_mem()` still returns both
 * signals in one call); we split the render, not the pipeline.
 *
 * Rail state renders a two-character percent (`43`) — dense
 * numeric information beats a generic 📊 emoji for the same
 * space.
 */

import { useMemo, type CSSProperties } from "react";
import { useSystemLoad } from "../../lib/SystemLoadContext";
import { CARD, CARD_HEADER, CARD_LABEL } from "./styles";

const PERCENT_VALUE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 15,
  fontWeight: 600,
  // Green matches the design's "healthy metric" accent language.
  // A future follow-up could flip to --amber above 70% and --red
  // above 90%; keeping it green for M13.3.
  color: "var(--green)",
};

const BAR_TRACK: CSSProperties = {
  height: 4,
  borderRadius: 2,
  background: "var(--pane2)",
  overflow: "hidden",
};

const BAR_FILL_BASE: CSSProperties = {
  height: "100%",
  background: "var(--green)",
  transition: "width 500ms ease-out",
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
  const cpuLabel = useMemo(() => `${Math.round(load.cpu_percent)}%`, [load.cpu_percent]);
  const tooltip = ready ? `CPU load: ${cpuLabel}` : "CPU load probe not available";

  if (!ready) return null;

  if (!visible) {
    return (
      <div data-testid="sidebar-cpu-rail" style={RAIL_ROOT} title={tooltip}>
        {Math.round(load.cpu_percent).toString().padStart(2, "0")}
      </div>
    );
  }

  return (
    <div data-testid="sidebar-cpu" style={CARD} title={tooltip}>
      <div style={CARD_HEADER}>
        <span style={CARD_LABEL}>CPU load</span>
        <span style={PERCENT_VALUE} data-testid="sidebar-cpu-percent">
          {cpuLabel}
        </span>
      </div>
      <div style={BAR_TRACK}>
        <div style={{ ...BAR_FILL_BASE, width: `${Math.min(100, load.cpu_percent)}%` }} />
      </div>
    </div>
  );
}
