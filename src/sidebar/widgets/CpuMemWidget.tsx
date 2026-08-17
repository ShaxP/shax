/**
 * CpuMemWidget (M13.3, spec §19 D5).
 *
 * Two stacked rows — CPU % and Memory % — each with a slim horizontal
 * bar and a numeric label. Subscribes to `useSystemLoad()`; App polls
 * the underlying probe at 2s per spec §D5.
 *
 * Renders:
 *   - Expanded: two rows ("CPU 42%" + bar / "Mem 8.1 GB / 16.0 GB" + bar)
 *   - Rail: a single 📊 glyph with a tooltip carrying both percentages
 *
 * The first probe response after startup returns cpu_percent = 0
 * unconditionally — `sysinfo` needs a delta between two refreshes to
 * compute usage. This is expected; the second poll (2s later) has
 * the first real number.
 */

import { useMemo, type CSSProperties } from "react";
import { useSystemLoad } from "../../lib/SystemLoadContext";

const EXPANDED_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "6px 10px",
  fontSize: 11,
  color: "var(--fg)",
};

const ROW: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const ROW_HEADER: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  color: "var(--fg-dim)",
};

const ROW_LABEL: CSSProperties = {
  fontSize: 10.5,
  letterSpacing: 0.3,
  textTransform: "uppercase",
};

const ROW_VALUE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg)",
};

const BAR_TRACK: CSSProperties = {
  height: 4,
  borderRadius: 2,
  background: "var(--surface)",
  overflow: "hidden",
};

const BAR_FILL_BASE: CSSProperties = {
  height: "100%",
  background: "var(--accent)",
  transition: "width 500ms ease-out",
};

const RAIL_ROOT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 32,
  fontSize: 14,
  color: "var(--fg-dim)",
  cursor: "default",
};

export interface CpuMemWidgetProps {
  visible: boolean;
}

export function CpuMemWidget({ visible }: CpuMemWidgetProps): React.ReactElement | null {
  const load = useSystemLoad();

  // Widget hides itself before the first probe returns real memory —
  // rendering "0.0 GB / 0.0 GB" would be a lie. sysinfo returns
  // mem_total_bytes > 0 on the very first call, so once we see that
  // we're safe. This handles both the "not-in-Tauri browser dev"
  // case (SYSTEM_LOAD_ZERO forever) and the "boot race" (App renders
  // once before the poll resolves).
  const memReady = load.mem_total_bytes > 0;
  const cpuLabel = useMemo(() => `${Math.round(load.cpu_percent)}%`, [load.cpu_percent]);
  const memLabel = useMemo(
    () => formatMem(load.mem_used_bytes, load.mem_total_bytes),
    [load.mem_used_bytes, load.mem_total_bytes],
  );
  const memPercent = memReady ? (load.mem_used_bytes / load.mem_total_bytes) * 100 : 0;
  const tooltip = memReady
    ? `CPU ${cpuLabel} · Memory ${memLabel} (${Math.round(memPercent)}%)`
    : "System load probe not available";

  if (!memReady) return null;

  if (!visible) {
    return (
      <div data-testid="sidebar-cpumem-rail" style={RAIL_ROOT} title={tooltip}>
        📊
      </div>
    );
  }

  return (
    <div data-testid="sidebar-cpumem" style={EXPANDED_ROOT} title={tooltip}>
      <div style={ROW}>
        <div style={ROW_HEADER}>
          <span style={ROW_LABEL}>CPU</span>
          <span style={ROW_VALUE} data-testid="sidebar-cpumem-cpu">
            {cpuLabel}
          </span>
        </div>
        <div style={BAR_TRACK}>
          <div style={{ ...BAR_FILL_BASE, width: `${Math.min(100, load.cpu_percent)}%` }} />
        </div>
      </div>
      <div style={ROW}>
        <div style={ROW_HEADER}>
          <span style={ROW_LABEL}>Mem</span>
          <span style={ROW_VALUE} data-testid="sidebar-cpumem-mem">
            {memLabel}
          </span>
        </div>
        <div style={BAR_TRACK}>
          <div style={{ ...BAR_FILL_BASE, width: `${Math.min(100, memPercent)}%` }} />
        </div>
      </div>
    </div>
  );
}

/** Byte-count formatter using binary units (GiB / MiB) — matches how
 *  `top` / `htop` display memory. Precision drops after the top two
 *  significant figures so the widget's mono column stays narrow. */
function formatMem(used: number, total: number): string {
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

function formatBytes(n: number): string {
  const GIB = 1024 ** 3;
  const MIB = 1024 ** 2;
  if (n >= GIB) {
    // Show one decimal for the low GiB range, none for two-digit GiB.
    return n >= 10 * GIB ? `${Math.round(n / GIB)} GB` : `${(n / GIB).toFixed(1)} GB`;
  }
  return `${Math.round(n / MIB)} MB`;
}
