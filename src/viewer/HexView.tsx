/**
 * xxd-style hex viewer (M4.5 slice 1).
 *
 * Three columns:
 *
 *   00000000  89 50 4E 47 0D 0A 1A 0A  00 00 00 0D 49 48 44 52   .PNG........IHDR
 *   00000010  00 00 02 00 00 00 02 00  08 06 00 00 00 F4 78 D4   ..............x.
 *
 * - 16 bytes per row.
 * - Offset column is monospace + sticky on horizontal scroll.
 * - File-signature bytes (first ~8) are highlighted so PNG /
 *   JPEG / GIF / WebP magic is visible at a glance.
 * - Non-printable bytes render as `.` in the ASCII column.
 *
 * Pure module. The renderer caps at 64 KiB by default to keep
 * even pathological binaries snappy; the cap is opt-out via the
 * `cap` prop. (The viewer modal sets it lower than the file
 * read cap so we don't try to lay out a 30 MiB file as 200 K
 * spans of two characters each.)
 */

import { useMemo, type CSSProperties } from "react";

const BYTES_PER_ROW = 16;
const DEFAULT_CAP = 64 * 1024;
const SIGNATURE_BYTES = 8;

const HOST: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  lineHeight: 1.55,
  // Match the other formatters' max-height system so the modal
  // can fill the panel via `--formatter-max-height: 100%`.
  maxHeight: "var(--formatter-max-height, 480px)",
  overflowY: "auto",
  margin: "4px 0 0 0",
  color: "var(--fg-dim)",
};

const ROW: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "9ch 1fr 18ch",
  gap: "1ch",
  padding: 0,
  whiteSpace: "pre",
};

const OFFSET: CSSProperties = {
  color: "var(--fg-faint)",
  userSelect: "none",
};

const HEX: CSSProperties = {
  color: "var(--fg-dim)",
};

const ASCII: CSSProperties = {
  color: "var(--fg-faint)",
};

const SIG: CSSProperties = {
  color: "var(--accent)",
  fontWeight: 600,
};

const FOOTER: CSSProperties = {
  padding: "8px 0 4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
};

interface HexViewProps {
  bytes: Uint8Array;
  /** Optional cap in bytes. Default 64 KiB. The view shows a
   *  one-line footer with the truncation count when active. */
  cap?: number;
  style?: CSSProperties;
}

export function HexView({ bytes, cap = DEFAULT_CAP, style }: HexViewProps): React.ReactElement {
  const truncated = bytes.length > cap;
  const view = truncated ? bytes.subarray(0, cap) : bytes;

  // Build the row array once; React renders each row as a flat
  // grid. Memo on the bytes ref so we don't re-build per click /
  // re-render.
  const rows = useMemo(() => buildRows(view), [view]);

  return (
    <div data-testid="hex-view" style={{ ...HOST, ...style }}>
      {rows.map((row) => (
        <div key={row.offset} style={ROW}>
          <span style={OFFSET}>{row.offsetHex}</span>
          <span style={HEX}>
            {row.cells.map((cell, i) => (
              <span key={i} style={cell.isSignature ? SIG : undefined}>
                {cell.text}
              </span>
            ))}
          </span>
          <span style={ASCII}>{row.ascii}</span>
        </div>
      ))}
      {truncated && (
        <div style={FOOTER} data-testid="hex-view-truncated">
          truncated at {cap.toLocaleString()} bytes — {(bytes.length - cap).toLocaleString()} more
          byte{bytes.length - cap === 1 ? "" : "s"} not shown
        </div>
      )}
    </div>
  );
}

interface HexCell {
  text: string;
  isSignature: boolean;
}

interface HexRow {
  offset: number;
  offsetHex: string;
  cells: HexCell[];
  ascii: string;
}

function buildRows(bytes: Uint8Array): HexRow[] {
  const rows: HexRow[] = [];
  for (let offset = 0; offset < bytes.length; offset += BYTES_PER_ROW) {
    rows.push(buildRow(bytes, offset));
  }
  return rows;
}

function buildRow(bytes: Uint8Array, offset: number): HexRow {
  const end = Math.min(offset + BYTES_PER_ROW, bytes.length);
  const cells: HexCell[] = [];
  let ascii = "";
  for (let i = offset; i < end; i++) {
    const byte = bytes[i] ?? 0;
    // A space between bytes, plus a wider gap at the half-row
    // (after byte 8) — the xxd / hexdump convention that makes
    // 16-byte rows scannable.
    const sep = i === offset ? "" : i - offset === 8 ? "  " : " ";
    cells.push({
      text: sep + byte.toString(16).padStart(2, "0").toUpperCase(),
      isSignature: i < SIGNATURE_BYTES,
    });
    ascii += isPrintable(byte) ? String.fromCharCode(byte) : ".";
  }
  return {
    offset,
    offsetHex: offset.toString(16).padStart(8, "0"),
    cells,
    ascii,
  };
}

function isPrintable(byte: number): boolean {
  // Standard xxd convention: printable ASCII range, no
  // control / extended chars. Saves us from needing a font with
  // every glyph and avoids RTL marks etc. in the ASCII column.
  return byte >= 0x20 && byte <= 0x7e;
}
