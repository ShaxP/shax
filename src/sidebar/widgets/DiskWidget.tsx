/**
 * DiskWidget (M13.5.4, spec §19 D10 and design/disk-widget-1..4.png).
 *
 * A pager over mounted volumes — same visual vocabulary as
 * `NetworkWidget`, deliberately, so a user paging between the two
 * cards doesn't have to relearn the interaction:
 *   - Header: `DISK ◀ n ▶` when there is more than one volume.
 *   - Volume name (bold, left) + free space (right).
 *   - Mount point (dim, second line).
 *   - Horizontal usage bar, heat-mapped by percent used.
 *   - `NN% used of X TB · FILESYSTEM` on the bottom line.
 *
 * Selection is held by **mount point**, not by index (spec §D10).
 * A volume unmounting — an external drive ejected, a `.dmg`
 * detached — would slide the card onto a neighbour if we selected
 * by position; keying by path means the card either stays on what
 * the user paged to or falls back cleanly to the first volume when
 * the selection genuinely vanishes.
 *
 * Ephemeral: not persisted across a restart, because the set of
 * volumes can differ entirely between sessions.
 *
 * Rail state (provisional — M13.5.5 rail remodel finalises it):
 * shows the primary volume's free space as a bare figure.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useDisk } from "../../lib/DiskContext";
import type { VolumeInfo } from "../../lib/ipc";
import { CARD, CARD_HEADER, CARD_LABEL } from "./styles";

const AMBER_AT = 70;
const RED_AT = 90;

const PAGER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginLeft: "auto",
};

const PAGER_BUTTON: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--fg-dim)",
  borderRadius: 5,
  width: 18,
  height: 16,
  lineHeight: "12px",
  fontSize: 9,
  padding: 0,
  cursor: "pointer",
};

const PAGER_COUNT: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
  minWidth: 10,
  textAlign: "center",
};

const IDENTITY_ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
};

const NAME: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const FREE_VALUE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-faint)",
  flexShrink: 0,
};

const MOUNT_LINE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const BAR_TRACK: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: "var(--pane2)",
  overflow: "hidden",
  marginTop: 2,
};

const BAR_FILL_BASE: CSSProperties = {
  height: "100%",
  borderRadius: 3,
  transition: "width 300ms ease-out, background 300ms ease-out",
};

const FOOTER: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
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
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--fg-dim)",
  cursor: "default",
};

// Mini usage bar + free-space label. The bar is heat-mapped by
// percent used with the same thresholds as the expanded card, so a
// full disk shouts red in either state.
//
// Deliberately thinner (4 px) than Battery's rail bar (6 px):
// battery's bar carries a metaphor — a "fuel gauge" the eye maps
// straight to the physical battery — and reads better as a chunky
// pill. Disk's bar is a plain usage indicator, and at the rail's
// density a chunky bar started to compete with the free-space
// figure below it for the eye. 4 px keeps the fill legible without
// dominating the label.
const RAIL_BAR_TRACK: CSSProperties = {
  width: 22,
  height: 4,
  borderRadius: 2,
  background: "var(--pane2)",
  overflow: "hidden",
};

const RAIL_BAR_FILL_BASE: CSSProperties = {
  height: "100%",
  borderRadius: 2,
};

export interface DiskWidgetProps {
  visible: boolean;
}

export function DiskWidget({ visible }: DiskWidgetProps): React.ReactElement | null {
  const { volumes } = useDisk();
  const [selected, setSelected] = useState<string | null>(null);

  // Fall back to the primary (position 0) when the selected mount
  // point goes away — same failover contract as NetworkWidget.
  const found = volumes.findIndex((v) => v.mount_point === selected);
  const position = found >= 0 ? found : 0;
  const active: VolumeInfo | null = volumes[position] ?? null;

  // Keep the stored mount point in step once the selection resolves,
  // so paging from a fallback moves relative to what is actually on
  // screen.
  useEffect(() => {
    if (active !== null && active.mount_point !== selected) setSelected(active.mount_point);
  }, [active, selected]);

  const tooltip = useMemo(
    () => buildTooltip(active, volumes.length, position),
    [active, volumes.length, position],
  );

  if (volumes.length === 0 || active === null) return null;

  const step = (delta: number): void => {
    if (volumes.length === 0) return;
    const next = (position + delta + volumes.length) % volumes.length;
    setSelected(volumes[next]?.mount_point ?? null);
  };

  if (!visible) {
    // Rail: mini usage bar over the free-space figure. The bar
    // pattern matches Battery's rail (22×6 track); the label under
    // it keeps the reading users open the widget for — "how much
    // room is left" — rather than the percent the bar already
    // shows. Uses the primary (first) volume so the rail is stable
    // across paging changes made in the expanded card.
    const primary = volumes[0] ?? active;
    const railPercent =
      primary.total_bytes === 0 ? 0 : (primary.used_bytes / primary.total_bytes) * 100;
    const railFillStyle: CSSProperties = {
      ...RAIL_BAR_FILL_BASE,
      width: `${Math.max(0, Math.min(100, railPercent))}%`,
      background: usageColour(railPercent),
    };
    return (
      <div data-testid="sidebar-disk-rail" style={RAIL_ROOT} title={tooltip}>
        <div style={RAIL_BAR_TRACK} data-testid="sidebar-disk-rail-track">
          <div style={railFillStyle} data-testid="sidebar-disk-rail-fill" />
        </div>
        <span data-testid="sidebar-disk-rail-free">
          {formatFree(primary.total_bytes - primary.used_bytes, /*compactRail*/ true)}
        </span>
      </div>
    );
  }

  const percentUsed = active.total_bytes === 0 ? 0 : (active.used_bytes / active.total_bytes) * 100;
  const fillStyle: CSSProperties = {
    ...BAR_FILL_BASE,
    width: `${Math.max(0, Math.min(100, percentUsed))}%`,
    background: usageColour(percentUsed),
  };

  return (
    <div data-testid="sidebar-disk" style={CARD} title={tooltip}>
      <div style={CARD_HEADER}>
        <span style={CARD_LABEL}>Disk</span>
        {volumes.length > 1 && (
          <span style={PAGER} data-testid="sidebar-disk-pager">
            <button
              type="button"
              aria-label="Previous volume"
              data-testid="sidebar-disk-prev"
              style={PAGER_BUTTON}
              onClick={() => step(-1)}
            >
              ◀
            </button>
            <span style={PAGER_COUNT} data-testid="sidebar-disk-position">
              {position + 1}
            </span>
            <button
              type="button"
              aria-label="Next volume"
              data-testid="sidebar-disk-next"
              style={PAGER_BUTTON}
              onClick={() => step(1)}
            >
              ▶
            </button>
          </span>
        )}
      </div>

      <div style={IDENTITY_ROW}>
        <span style={NAME} data-testid="sidebar-disk-name">
          {active.name}
        </span>
        <span style={FREE_VALUE} data-testid="sidebar-disk-free">
          {formatFree(active.total_bytes - active.used_bytes, false)} free
        </span>
      </div>

      <span style={MOUNT_LINE} data-testid="sidebar-disk-mount">
        {active.mount_point}
      </span>

      <div style={BAR_TRACK} data-testid="sidebar-disk-track">
        <div style={fillStyle} data-testid="sidebar-disk-fill" />
      </div>

      <div style={FOOTER}>
        <span data-testid="sidebar-disk-usage">
          {Math.round(percentUsed)}% used of {formatTotal(active.total_bytes)}
        </span>
        <span data-testid="sidebar-disk-fs">{active.filesystem.toUpperCase()}</span>
      </div>
    </div>
  );
}

/** Heat colour for the usage bar: teal / green under 70%, amber up
 *  to 90%, red at or above. Inverted from the CPU heat map (higher
 *  is worse for disk), threshold constants named separately from
 *  Battery / CPU so a change to one signal doesn't move the others.
 *
 *  Exported so tests can pin each branch directly. */
export function usageColour(percentUsed: number): string {
  if (percentUsed >= RED_AT) return "var(--red)";
  if (percentUsed >= AMBER_AT) return "var(--amber)";
  return "var(--accent)";
}

/** `412GB` / `1.2TB` / `950MB`. Free space is what the user cares
 *  about most, so it's typically the largest reading and gets
 *  integer units above 100 GB, one decimal below.
 *
 *  `compactRail` drops the unit suffix and uses whole GB for
 *  everything in the rail — space is at a premium there.
 *
 *  Exported so the two branches can be tested directly. */
export function formatFree(bytes: number, compactRail: boolean): string {
  const TB = 1024 ** 4;
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (compactRail) {
    // Rail: just a number. GB unless we're above 1 TB where we
    // switch to TB to keep the digits under four wide.
    if (bytes >= TB) return `${Math.round(bytes / TB)}T`;
    return `${Math.round(bytes / GB)}G`;
  }
  if (bytes >= TB) {
    return bytes >= 10 * TB ? `${Math.round(bytes / TB)}TB` : `${(bytes / TB).toFixed(1)}TB`;
  }
  if (bytes >= GB) {
    // Integer above 10 GB (the case for any real hard drive / SSD /
    // decent SD card), one decimal below (small thumbdrives). Same
    // shape as the Memory formatter's threshold — the two
    // widget-side byte formatters agree on what "reads as whole".
    return bytes >= 10 * GB ? `${Math.round(bytes / GB)}GB` : `${(bytes / GB).toFixed(1)}GB`;
  }
  return `${Math.round(bytes / MB)}MB`;
}

/** Total-capacity render — always in the bigger unit so the reading
 *  isn't dwarfed by a big MB / small GB combination in the same
 *  line. `1 TB` reads better than `1024 GB`.
 *
 *  Exported for the same reason as `formatFree`. */
export function formatTotal(bytes: number): string {
  const TB = 1024 ** 4;
  const GB = 1024 ** 3;
  if (bytes >= TB) {
    return bytes >= 10 * TB ? `${Math.round(bytes / TB)} TB` : `${(bytes / TB).toFixed(1)} TB`;
  }
  return `${Math.round(bytes / GB)} GB`;
}

function buildTooltip(active: VolumeInfo | null, total: number, position: number): string {
  if (active === null) return "No disk volumes found";
  const parts: string[] = [active.name];
  parts.push(active.mount_point);
  parts.push(`${active.filesystem.toUpperCase()}`);
  const percentUsed = active.total_bytes === 0 ? 0 : (active.used_bytes / active.total_bytes) * 100;
  parts.push(
    `${formatFree(active.total_bytes - active.used_bytes, false)} free of ${formatTotal(active.total_bytes)}`,
  );
  parts.push(`${Math.round(percentUsed)}% used`);
  if (total > 1) parts.push(`Volume ${position + 1} of ${total}`);
  return parts.join(" · ");
}
