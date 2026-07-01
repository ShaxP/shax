/**
 * JPEG metadata parser for the INFO lens.
 *
 * Walks the JPEG segment stream from SOI, extracts SOF (frame
 * header — width / height / precision / component count and
 * subsampling), and optionally a small EXIF summary from an
 * APP1 segment (camera make + model, orientation, timestamp).
 *
 * Reference: JFIF + Exif 2.3. TIFF byte-order and IFD walking
 * for EXIF. No verification of segment length invariants — the
 * goal is "look at what the file claims to be".
 *
 * Returns `null` when the bytes aren't a JPEG. Callers use
 * that to skip appending the section.
 */

import type { MetadataSection } from "../types";

export function buildJpegSection(bytes: Uint8Array): MetadataSection | null {
  if (!hasJpegSignature(bytes)) return null;
  const sof = readSofSegment(bytes);
  if (sof === null) return null;
  const rows: { key: string; value: string; hint?: string }[] = [
    {
      key: "Dimensions",
      value: `${sof.width} × ${sof.height}`,
      hint: `${(sof.width * sof.height).toLocaleString()} pixels`,
    },
    { key: "Precision", value: `${sof.precision}-bit` },
    { key: "Components", value: sof.components.toString() },
  ];
  if (sof.subsampling !== null) {
    rows.push({ key: "Subsampling", value: sof.subsampling });
  }
  const exif = readExifSummary(bytes);
  if (exif !== null) {
    for (const row of exif) rows.push(row);
  }
  return { title: "JPEG", rows };
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

interface Sof {
  width: number;
  height: number;
  precision: number;
  components: number;
  /** e.g. `4:4:4`, `4:2:2`, `4:2:0`, `4:1:1` — derived from
   *  Y-plane horizontal and vertical sampling factors when the
   *  frame has three components. `null` for greyscale, CMYK,
   *  or unsupported subsampling combinations. */
  subsampling: string | null;
}

function readSofSegment(bytes: Uint8Array): Sof | null {
  // Walk segments starting after SOI (2 bytes). Every marker
  // begins with 0xFF; the frame header markers are 0xC0..0xCF
  // except DHT (0xC4), JPG (0xC8), DAC (0xCC).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    // Skip padding 0xFF bytes.
    let marker = bytes[offset + 1] ?? 0;
    let markerOffset = offset + 1;
    while (marker === 0xff && markerOffset + 1 < bytes.length) {
      markerOffset++;
      marker = bytes[markerOffset] ?? 0;
    }
    // 0xD0..0xD7 (RST0..RST7) and 0xD8/D9 (SOI/EOI) have no
    // payload. Anything else has a 2-byte big-endian length.
    if (marker === 0xd8 || marker === 0xd9) return null;
    const segStart = markerOffset + 1;
    if (segStart + 2 > bytes.length) return null;
    const length = view.getUint16(segStart, false);
    // SOF markers we care about: SOF0 (baseline) / SOF1 /
    // SOF2 (progressive) / SOF3 / SOF9..SOF11 etc. Skip SOF4
    // (DHT), SOF8 (JPG), SOFC (DAC).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // SOF payload: precision (1) height (2) width (2) components (1)
      // followed by 3 bytes per component (id, sampling factors, quant table).
      if (segStart + 2 + 6 > bytes.length) return null;
      const precision = view.getUint8(segStart + 2);
      const height = view.getUint16(segStart + 3, false);
      const width = view.getUint16(segStart + 5, false);
      const components = view.getUint8(segStart + 7);
      let subsampling: string | null = null;
      if (components === 3 && segStart + 2 + 6 + 3 <= bytes.length) {
        const hY = (view.getUint8(segStart + 9) >> 4) & 0x0f;
        const vY = view.getUint8(segStart + 9) & 0x0f;
        subsampling = subsamplingLabel(hY, vY);
      } else if (components === 1) {
        subsampling = "grayscale";
      }
      return { width, height, precision, components, subsampling };
    }
    offset = segStart + length;
  }
  return null;
}

function subsamplingLabel(h: number, v: number): string | null {
  // Standard shorthand from Y-plane horizontal + vertical
  // sampling factors. 4:4:4 = no subsampling, 4:2:2 = half
  // horizontal, 4:2:0 = half both. Reference values from
  // libjpeg / ffmpeg.
  if (h === 1 && v === 1) return "4:4:4";
  if (h === 2 && v === 1) return "4:2:2";
  if (h === 2 && v === 2) return "4:2:0";
  if (h === 4 && v === 1) return "4:1:1";
  return null;
}

/** Very small EXIF walker: reads camera Make + Model, primary
 *  orientation, and DateTimeOriginal from the first APP1
 *  segment tagged `Exif\0\0`. Returns `null` if no EXIF is
 *  present or nothing interesting can be read. */
function readExifSummary(bytes: Uint8Array): { key: string; value: string }[] | null {
  // Find APP1 (0xFFE1) segment starting with "Exif\0\0".
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1] ?? 0;
    let markerOffset = offset + 1;
    while (marker === 0xff && markerOffset + 1 < bytes.length) {
      markerOffset++;
      marker = bytes[markerOffset] ?? 0;
    }
    if (marker === 0xd8 || marker === 0xd9) return null;
    const segStart = markerOffset + 1;
    if (segStart + 2 > bytes.length) return null;
    const length = view.getUint16(segStart, false);
    if (marker === 0xe1 && segStart + 2 + 6 <= bytes.length) {
      // Check for "Exif\0\0" header.
      if (
        bytes[segStart + 2] === 0x45 &&
        bytes[segStart + 3] === 0x78 &&
        bytes[segStart + 4] === 0x69 &&
        bytes[segStart + 5] === 0x66 &&
        bytes[segStart + 6] === 0x00 &&
        bytes[segStart + 7] === 0x00
      ) {
        const exifStart = segStart + 8;
        return parseExifIfd(bytes, exifStart, segStart + length);
      }
    }
    offset = segStart + length;
  }
  return null;
}

/** Walk the first IFD in a TIFF-in-EXIF blob and pluck a few
 *  tags. Returns an empty array if nothing interesting was
 *  found (caller treats that as "no summary"). */
function parseExifIfd(
  bytes: Uint8Array,
  start: number,
  end: number,
): { key: string; value: string }[] | null {
  if (start + 8 > end) return null;
  // TIFF header: "II" (little-endian) or "MM" (big-endian).
  const byte0 = bytes[start];
  const byte1 = bytes[start + 1];
  let littleEndian: boolean;
  if (byte0 === 0x49 && byte1 === 0x49) {
    littleEndian = true;
  } else if (byte0 === 0x4d && byte1 === 0x4d) {
    littleEndian = false;
  } else {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Magic (2 bytes) must equal 42.
  const magic = view.getUint16(start + 2, littleEndian);
  if (magic !== 42) return null;
  const firstIfdOffset = view.getUint32(start + 4, littleEndian);
  const ifdStart = start + firstIfdOffset;
  if (ifdStart + 2 > end) return null;
  const entryCount = view.getUint16(ifdStart, littleEndian);
  const summary: Record<string, string> = {};
  for (let i = 0; i < entryCount; i++) {
    const entry = ifdStart + 2 + i * 12;
    if (entry + 12 > end) break;
    const tag = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const count = view.getUint32(entry + 4, littleEndian);
    // ASCII (type 2), SHORT (type 3), LONG (type 4).
    if (type === 2) {
      const valueOrOffset = view.getUint32(entry + 8, littleEndian);
      const strStart = count <= 4 ? entry + 8 : start + valueOrOffset;
      const strEnd = strStart + count - 1; // trailing NUL.
      if (strStart >= 0 && strEnd <= end) {
        const value = decodeAscii(bytes, strStart, strEnd);
        if (tag === 0x010f) summary["Make"] = value;
        if (tag === 0x0110) summary["Model"] = value;
        if (tag === 0x0132) summary["Taken"] = value;
        if (tag === 0x9003) summary["Taken"] = value;
      }
    } else if (type === 3) {
      const value = view.getUint16(entry + 8, littleEndian);
      if (tag === 0x0112) summary["Orientation"] = humanOrientation(value);
    }
  }
  const rows: { key: string; value: string }[] = [];
  if (summary["Make"] !== undefined || summary["Model"] !== undefined) {
    const camera = [summary["Make"], summary["Model"]].filter(Boolean).join(" ");
    if (camera.length > 0) rows.push({ key: "Camera", value: camera });
  }
  if (summary["Orientation"] !== undefined) {
    rows.push({ key: "Orientation", value: summary["Orientation"] });
  }
  if (summary["Taken"] !== undefined) {
    rows.push({ key: "Taken", value: summary["Taken"] });
  }
  return rows.length > 0 ? rows : null;
}

function decodeAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    const b = bytes[i] ?? 0;
    if (b === 0) break;
    if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
  }
  return out.trim();
}

function humanOrientation(value: number): string {
  // EXIF orientation values 1..8; only the common cases have
  // pithy labels.
  switch (value) {
    case 1:
      return "normal";
    case 2:
      return "mirrored horizontal";
    case 3:
      return "rotated 180°";
    case 4:
      return "mirrored vertical";
    case 5:
      return "rotated 90° ccw + mirrored";
    case 6:
      return "rotated 90° cw";
    case 7:
      return "rotated 90° cw + mirrored";
    case 8:
      return "rotated 90° ccw";
    default:
      return `unknown (${value})`;
  }
}
