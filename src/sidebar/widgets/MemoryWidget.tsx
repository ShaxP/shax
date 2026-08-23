/**
 * MemoryWidget (M13.3, restyled per design/widget-sidebar.png).
 *
 * Card layout (horizontal):
 *   - Left: small inline-SVG donut chart with used-% in the centre.
 *   - Right: "MEMORY" label above "used / total" with the used
 *     figure in accent-green (matches the design's colour language).
 *
 * Split out of the original CpuMemWidget in this design refresh.
 * Backend probe unchanged; we share `useSystemLoad()` with
 * CpuWidget (one Rust call → both cards' data).
 *
 * Rail state shows a two-character percent — same information
 * density as CPU's rail, no swap between formats.
 */

import { useMemo, type CSSProperties } from "react";
import { useSystemLoad } from "../../lib/SystemLoadContext";
import { CARD, CARD_LABEL } from "./styles";

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const RIGHT_COL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  flex: 1,
  minWidth: 0,
};

const BYTES_ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 600,
};

const USED_BYTES: CSSProperties = {
  color: "var(--green)",
};

const TOTAL_BYTES: CSSProperties = {
  color: "var(--fg-dim)",
};

// The swap line sits under the primary memory readout. Dim + small,
// because swap is context for the RAM figure rather than a peer
// reading — a user glancing at the card should land on RAM first.
const SWAP_LINE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-dim)",
  fontFamily: "var(--font-mono)",
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

export interface MemoryWidgetProps {
  visible: boolean;
}

export function MemoryWidget({ visible }: MemoryWidgetProps): React.ReactElement | null {
  const load = useSystemLoad();
  const ready = load.mem_total_bytes > 0;
  const percent = ready ? (load.mem_used_bytes / load.mem_total_bytes) * 100 : 0;
  const percentLabel = useMemo(() => `${Math.round(percent)}%`, [percent]);
  const usedLabel = useMemo(() => formatBytes(load.mem_used_bytes), [load.mem_used_bytes]);
  const totalLabel = useMemo(() => formatBytes(load.mem_total_bytes), [load.mem_total_bytes]);
  // Swap line renders only when swap is actually configured. A machine
  // with `swap_total_bytes = 0` (some Linux boxes) gets no line at
  // all — showing `swap 0.0 GB` on a machine that literally has no
  // swap subsystem would misrepresent the platform. The reading itself
  // is `used`, not `total`, per the spec: an idle Mac with 8 GB of
  // swap configured but nothing paged out reads `swap 0.0 GB`.
  const hasSwap = load.swap_total_bytes > 0;
  const swapLabel = useMemo(
    () => (hasSwap ? formatBytes(load.swap_used_bytes) : null),
    [hasSwap, load.swap_used_bytes],
  );
  const tooltip = ready
    ? hasSwap
      ? `Memory: ${usedLabel} of ${totalLabel} in use (${percentLabel}) · swap ${swapLabel ?? "0"} in use`
      : `Memory: ${usedLabel} of ${totalLabel} in use (${percentLabel})`
    : "Memory probe not available";

  if (!ready) return null;

  if (!visible) {
    return (
      <div data-testid="sidebar-memory-rail" style={RAIL_ROOT} title={tooltip}>
        {Math.round(percent).toString().padStart(2, "0")}
      </div>
    );
  }

  return (
    <div data-testid="sidebar-memory" style={CARD} title={tooltip}>
      <div style={ROW}>
        <MemoryDonut percent={percent} label={percentLabel} />
        <div style={RIGHT_COL}>
          <span style={CARD_LABEL}>Memory</span>
          <div style={BYTES_ROW}>
            <span style={USED_BYTES} data-testid="sidebar-memory-used">
              {usedLabel}
            </span>
            <span style={TOTAL_BYTES}>/ {totalLabel}</span>
          </div>
          {swapLabel !== null && (
            <span style={SWAP_LINE} data-testid="sidebar-memory-swap">
              swap {swapLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Small ring showing memory-in-use as a fraction of total, with
 *  the % rendered in the middle. Uses the stroke-dasharray trick
 *  to fill the arc — no external chart library, no per-tick DOM
 *  churn beyond the two numeric attributes. */
interface MemoryDonutProps {
  percent: number;
  label: string;
}

const DONUT_SIZE = 44;
const DONUT_STROKE = 4;
const DONUT_RADIUS = (DONUT_SIZE - DONUT_STROKE) / 2;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

function MemoryDonut({ percent, label }: MemoryDonutProps): React.ReactElement {
  const fraction = Math.min(1, Math.max(0, percent / 100));
  const dashOffset = DONUT_CIRCUMFERENCE * (1 - fraction);
  return (
    <div style={{ position: "relative", width: DONUT_SIZE, height: DONUT_SIZE, flexShrink: 0 }}>
      <svg width={DONUT_SIZE} height={DONUT_SIZE} data-testid="sidebar-memory-donut">
        {/* Track ring — always full circumference, dimmed. */}
        <circle
          cx={DONUT_SIZE / 2}
          cy={DONUT_SIZE / 2}
          r={DONUT_RADIUS}
          fill="none"
          stroke="var(--pane2)"
          strokeWidth={DONUT_STROKE}
        />
        {/* Filled arc — rotated -90° so the arc starts at 12
            o'clock rather than the SVG default 3 o'clock. */}
        <circle
          cx={DONUT_SIZE / 2}
          cy={DONUT_SIZE / 2}
          r={DONUT_RADIUS}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={DONUT_STROKE}
          strokeDasharray={DONUT_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${DONUT_SIZE / 2} ${DONUT_SIZE / 2})`}
          style={{ transition: "stroke-dashoffset 500ms ease-out" }}
        />
      </svg>
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--fg)",
          fontFamily: "var(--font-mono)",
        }}
        data-testid="sidebar-memory-percent"
      >
        {label}
      </span>
    </div>
  );
}

function formatBytes(n: number): string {
  const GIB = 1024 ** 3;
  const MIB = 1024 ** 2;
  if (n >= GIB) {
    return n >= 10 * GIB ? `${Math.round(n / GIB)} GB` : `${(n / GIB).toFixed(1)} GB`;
  }
  return `${Math.round(n / MIB)} MB`;
}
