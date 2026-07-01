import { describe, expect, it } from "vitest";
import { buildPngSection } from "./png";

/** Build a minimal PNG-like blob for testing: signature, IHDR
 *  with the requested width/height/color type/bit depth, then a
 *  handful of named chunks, then IEND. Chunk CRCs are zeroed
 *  since the parser doesn't verify them. */
function makePng({
  width = 100,
  height = 50,
  bitDepth = 8,
  colorType = 6,
  interlace = 0,
  extraChunks = [],
  idatCount = 1,
}: {
  width?: number;
  height?: number;
  bitDepth?: number;
  colorType?: number;
  interlace?: number;
  extraChunks?: string[];
  idatCount?: number;
} = {}): Uint8Array {
  const parts: number[] = [];
  parts.push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  // IHDR chunk: length=13, type=IHDR, data (13 bytes), crc (4 bytes)
  parts.push(0, 0, 0, 13);
  parts.push(0x49, 0x48, 0x44, 0x52);
  parts.push((width >> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff);
  parts.push((height >> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff);
  parts.push(bitDepth, colorType, 0, 0, interlace);
  parts.push(0, 0, 0, 0);
  // IDAT chunks — length 0, no data.
  for (let i = 0; i < idatCount; i++) {
    parts.push(0, 0, 0, 0);
    parts.push(0x49, 0x44, 0x41, 0x54);
    parts.push(0, 0, 0, 0);
  }
  // Extra ancillary chunks — length 0, no data.
  for (const type of extraChunks) {
    parts.push(0, 0, 0, 0);
    for (let i = 0; i < 4; i++) parts.push(type.charCodeAt(i));
    parts.push(0, 0, 0, 0);
  }
  // IEND
  parts.push(0, 0, 0, 0);
  parts.push(0x49, 0x45, 0x4e, 0x44);
  parts.push(0, 0, 0, 0);
  return new Uint8Array(parts);
}

describe("buildPngSection", () => {
  it("returns null when the bytes don't start with the PNG signature", () => {
    const notPng = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(buildPngSection(notPng)).toBeNull();
  });

  it("returns null when the bytes are too short for IHDR", () => {
    const stub = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(buildPngSection(stub)).toBeNull();
  });

  it("extracts dimensions and RGBA color type", () => {
    const bytes = makePng({ width: 1920, height: 1080, bitDepth: 8, colorType: 6 });
    const section = buildPngSection(bytes);
    expect(section).not.toBeNull();
    expect(section?.title).toBe("PNG");
    const rows = section?.rows ?? [];
    expect(rows[0]).toMatchObject({ key: "Dimensions", value: "1920 × 1080" });
    expect(rows[1]).toMatchObject({ key: "Color", value: "RGBA (8-bit)" });
  });

  it("labels palette / grayscale / RGB correctly", () => {
    expect(buildPngSection(makePng({ colorType: 0, bitDepth: 1 }))?.rows[1]?.value).toBe(
      "grayscale (1-bit)",
    );
    expect(buildPngSection(makePng({ colorType: 2, bitDepth: 8 }))?.rows[1]?.value).toBe(
      "RGB (8-bit)",
    );
    expect(buildPngSection(makePng({ colorType: 3, bitDepth: 4 }))?.rows[1]?.value).toBe(
      "palette (4-bit)",
    );
  });

  it("reports interlace when Adam7", () => {
    const bytes = makePng({ interlace: 1 });
    expect(buildPngSection(bytes)?.rows[2]).toMatchObject({ key: "Interlaced", value: "Adam7" });
  });

  it("summarises chunk stream with IDAT×N + ancillaries", () => {
    const bytes = makePng({ idatCount: 47, extraChunks: ["tRNS", "gAMA", "tEXt"] });
    const chunks = buildPngSection(bytes)?.rows[3]?.value ?? "";
    expect(chunks).toContain("IHDR");
    expect(chunks).toContain("IDAT×47");
    expect(chunks).toContain("tRNS");
    expect(chunks).toContain("gAMA");
    expect(chunks).toContain("tEXt");
    expect(chunks).toContain("IEND");
  });
});
