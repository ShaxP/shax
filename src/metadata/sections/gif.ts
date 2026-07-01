/**
 * GIF metadata parser for the INFO lens.
 *
 * Reads the GIF89a / GIF87a header, walks the block stream,
 * counts image descriptors (= frames) and picks up the
 * NETSCAPE2.0 loop count if present.
 *
 * Reference: GIF89a spec. Returns `null` when the bytes aren't
 * a GIF.
 */

import type { MetadataSection } from "../types";

export function buildGifSection(bytes: Uint8Array): MetadataSection | null {
  if (!hasGifSignature(bytes)) return null;
  const header = readHeader(bytes);
  if (header === null) return null;
  const parsed = walkBlocks(bytes, header.afterGlobalColorTable);
  const rows: { key: string; value: string; hint?: string }[] = [
    {
      key: "Dimensions",
      value: `${header.width} × ${header.height}`,
      hint: `${(header.width * header.height).toLocaleString()} pixels`,
    },
    { key: "Version", value: header.version },
    {
      key: "Palette",
      value: header.hasGlobalColorTable
        ? `${header.globalColorTableSize} colors`
        : "no global color table",
    },
    { key: "Frames", value: parsed.frames.toString() },
  ];
  if (parsed.loopCount !== null) {
    rows.push({
      key: "Loop",
      value: parsed.loopCount === 0 ? "infinite" : `${parsed.loopCount}x`,
    });
  }
  return { title: "GIF", rows };
}

function hasGifSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

interface Header {
  width: number;
  height: number;
  version: string;
  hasGlobalColorTable: boolean;
  globalColorTableSize: number;
  afterGlobalColorTable: number;
}

function readHeader(bytes: Uint8Array): Header | null {
  if (bytes.length < 13) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[4] === 0x39 ? "GIF89a" : "GIF87a";
  const width = view.getUint16(6, true); // little-endian
  const height = view.getUint16(8, true);
  const packed = view.getUint8(10);
  const hasGlobalColorTable = (packed & 0x80) !== 0;
  const globalColorTableSize = hasGlobalColorTable ? 2 << (packed & 0x07) : 0;
  const afterGlobalColorTable = 13 + (hasGlobalColorTable ? 3 * globalColorTableSize : 0);
  return {
    width,
    height,
    version,
    hasGlobalColorTable,
    globalColorTableSize,
    afterGlobalColorTable,
  };
}

interface Walk {
  frames: number;
  loopCount: number | null;
}

function walkBlocks(bytes: Uint8Array, start: number): Walk {
  let frames = 0;
  let loopCount: number | null = null;
  let offset = start;
  while (offset < bytes.length) {
    const marker = bytes[offset] ?? 0;
    if (marker === 0x3b) break; // Trailer.
    if (marker === 0x2c) {
      // Image descriptor.
      frames++;
      offset = skipImageDescriptor(bytes, offset);
      if (offset === -1) break;
      continue;
    }
    if (marker === 0x21) {
      // Extension. Sub-marker byte then a sequence of
      // length-prefixed sub-blocks terminated by 0x00.
      if (offset + 2 >= bytes.length) break;
      const subMarker = bytes[offset + 1] ?? 0;
      const dataStart = offset + 2;
      if (
        subMarker === 0xff &&
        bytes[dataStart] === 11 &&
        dataStart + 11 <= bytes.length &&
        matchesAscii(bytes, dataStart + 1, "NETSCAPE2.0")
      ) {
        // NETSCAPE2.0 loop-count extension. First sub-block
        // after the 11-byte identifier: 3 bytes = [1, loopLo, loopHi].
        const loopStart = dataStart + 12;
        if (loopStart + 3 <= bytes.length && bytes[loopStart] === 3) {
          const lo = bytes[loopStart + 2] ?? 0;
          const hi = bytes[loopStart + 3] ?? 0;
          loopCount = lo | (hi << 8);
        }
      }
      offset = skipSubBlocks(bytes, dataStart + (subMarker === 0xff ? 12 : 0));
      if (offset === -1) break;
      continue;
    }
    // Unknown block — stop scanning rather than misreport.
    break;
  }
  return { frames, loopCount };
}

function skipImageDescriptor(bytes: Uint8Array, start: number): number {
  // 1 byte marker + 8 bytes descriptor + optional local color
  // table + LZW min code size (1) + sub-blocks.
  if (start + 10 > bytes.length) return -1;
  const packed = bytes[start + 9] ?? 0;
  const hasLct = (packed & 0x80) !== 0;
  const lctSize = hasLct ? 2 << (packed & 0x07) : 0;
  const afterLct = start + 10 + (hasLct ? 3 * lctSize : 0);
  if (afterLct + 1 > bytes.length) return -1;
  return skipSubBlocks(bytes, afterLct + 1);
}

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset] ?? 0;
    if (size === 0) return offset + 1;
    offset += 1 + size;
  }
  return -1;
}

function matchesAscii(bytes: Uint8Array, start: number, s: string): boolean {
  if (start + s.length > bytes.length) return false;
  for (let i = 0; i < s.length; i++) {
    if (bytes[start + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}
