/**
 * PNG metadata parser for the INFO lens.
 *
 * Walks the PNG chunk stream from the header signature onward.
 * Extracts IHDR (width / height / bit depth / colour type /
 * interlace flag) and a summary of chunks present (which
 * IDATs, tRNS, gAMA, pHYs, tEXt / iTXt / zTXt, sRGB, iCCP).
 *
 * Reference: PNG spec §5 (structure) and §11 (chunk types).
 * No CRC verification — the goal is "look at what the file
 * claims to be", not "prove the file is valid".
 *
 * Returns `null` when the bytes aren't a PNG. Callers use that
 * to skip appending the section (metadata builders are
 * best-effort).
 */

import type { MetadataSection } from "../types";

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function buildPngSection(bytes: Uint8Array): MetadataSection | null {
  if (!hasSignature(bytes)) return null;
  const ihdr = readIhdr(bytes);
  if (ihdr === null) return null;
  const chunks = summariseChunks(bytes);
  const rows: { key: string; value: string; hint?: string }[] = [
    {
      key: "Dimensions",
      value: `${ihdr.width} × ${ihdr.height}`,
      hint: `${(ihdr.width * ihdr.height).toLocaleString()} pixels`,
    },
    { key: "Color", value: humanColorType(ihdr.colorType, ihdr.bitDepth) },
    { key: "Interlaced", value: ihdr.interlace === 1 ? "Adam7" : "no" },
    { key: "Chunks", value: chunks },
  ];
  return { title: "PNG", rows };
}

function hasSignature(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE.length) return false;
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) return false;
  }
  return true;
}

interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

function readIhdr(bytes: Uint8Array): Ihdr | null {
  // Signature (8) + chunk length (4) + type (4) + IHDR data (13).
  if (bytes.length < 8 + 4 + 4 + 13) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Chunk length at offset 8. IHDR type at offset 12 ('I','H','D','R').
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const width = view.getUint32(16, false); // big-endian
  const height = view.getUint32(20, false);
  const bitDepth = view.getUint8(24);
  const colorType = view.getUint8(25);
  // Compression, filter at 26 and 27 — always 0 in a valid PNG.
  const interlace = view.getUint8(28);
  return { width, height, bitDepth, colorType, interlace };
}

function humanColorType(colorType: number, bitDepth: number): string {
  switch (colorType) {
    case 0:
      return `grayscale (${bitDepth}-bit)`;
    case 2:
      return `RGB (${bitDepth}-bit)`;
    case 3:
      return `palette (${bitDepth}-bit)`;
    case 4:
      return `grayscale + alpha (${bitDepth}-bit)`;
    case 6:
      return `RGBA (${bitDepth}-bit)`;
    default:
      return `unknown type ${colorType} (${bitDepth}-bit)`;
  }
}

/** Walk every chunk after IHDR, tally IDATs, list unique
 *  other-chunk types in the order they first appear. Returns a
 *  compact string like `IHDR · IDAT×47 · tRNS · IEND`. */
function summariseChunks(bytes: Uint8Array): string {
  const parts: string[] = ["IHDR"];
  const seen = new Set<string>(["IHDR"]);
  let idatCount = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Skip signature (8) + IHDR chunk (length 4 + type 4 + data 13 + crc 4 = 25 → 33).
  let offset = 33;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const typeStart = offset + 4;
    const type = String.fromCharCode(
      bytes[typeStart] ?? 0,
      bytes[typeStart + 1] ?? 0,
      bytes[typeStart + 2] ?? 0,
      bytes[typeStart + 3] ?? 0,
    );
    if (type === "IDAT") {
      idatCount++;
    } else if (!seen.has(type)) {
      seen.add(type);
      parts.push(type);
    }
    if (type === "IEND") break;
    // Guard: pathological length would run us off the file.
    // Just stop summarising in that case.
    const next = typeStart + 4 + length + 4;
    if (next <= offset) break; // no progress
    offset = next;
  }
  if (idatCount > 0) {
    // Insert IDAT after IHDR so the order reads chunk-graph-ish.
    parts.splice(1, 0, `IDAT×${idatCount}`);
  }
  return parts.join(" · ");
}
