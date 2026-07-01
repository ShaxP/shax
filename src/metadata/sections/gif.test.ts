import { describe, expect, it } from "vitest";
import { buildGifSection } from "./gif";

function makeGif({
  version = "GIF89a",
  width = 200,
  height = 100,
  hasGct = true,
  gctBits = 3,
  frames = 1,
  loopCount = null as number | null,
}): Uint8Array {
  const parts: number[] = [];
  for (const c of version) parts.push(c.charCodeAt(0));
  parts.push(width & 0xff, (width >> 8) & 0xff);
  parts.push(height & 0xff, (height >> 8) & 0xff);
  const packed = (hasGct ? 0x80 : 0) | gctBits;
  parts.push(packed, 0, 0);
  if (hasGct) {
    const size = 2 << gctBits;
    for (let i = 0; i < size; i++) parts.push(0, 0, 0);
  }
  // Optional NETSCAPE2.0 loop extension.
  if (loopCount !== null) {
    parts.push(0x21, 0xff, 11);
    for (const c of "NETSCAPE2.0") parts.push(c.charCodeAt(0));
    parts.push(3, 1, loopCount & 0xff, (loopCount >> 8) & 0xff, 0);
  }
  for (let i = 0; i < frames; i++) {
    parts.push(0x2c);
    parts.push(0, 0, 0, 0, width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff);
    parts.push(0);
    parts.push(1); // LZW min code size.
    parts.push(0); // no sub-blocks — 0-byte terminator.
  }
  parts.push(0x3b); // trailer
  return new Uint8Array(parts);
}

describe("buildGifSection", () => {
  it("returns null when the bytes aren't a GIF", () => {
    expect(buildGifSection(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("reads a single-frame GIF89a", () => {
    const bytes = makeGif({ version: "GIF89a", width: 640, height: 480, gctBits: 7 });
    const section = buildGifSection(bytes);
    expect(section?.title).toBe("GIF");
    expect(section?.rows[0]).toMatchObject({ key: "Dimensions", value: "640 × 480" });
    expect(section?.rows[1]).toMatchObject({ key: "Version", value: "GIF89a" });
    expect(section?.rows[2]?.value).toContain("256 colors");
    expect(section?.rows[3]).toMatchObject({ key: "Frames", value: "1" });
  });

  it("counts frames in an animated GIF", () => {
    const bytes = makeGif({ frames: 12 });
    expect(buildGifSection(bytes)?.rows[3]).toMatchObject({ key: "Frames", value: "12" });
  });

  it("picks up the NETSCAPE2.0 loop count", () => {
    const bytes = makeGif({ frames: 4, loopCount: 0 });
    const rows = buildGifSection(bytes)?.rows ?? [];
    const loop = rows.find((r) => r.key === "Loop");
    expect(loop).toMatchObject({ key: "Loop", value: "infinite" });
  });

  it("labels a finite loop count", () => {
    const bytes = makeGif({ frames: 4, loopCount: 3 });
    const rows = buildGifSection(bytes)?.rows ?? [];
    const loop = rows.find((r) => r.key === "Loop");
    expect(loop).toMatchObject({ key: "Loop", value: "3x" });
  });

  it("labels the palette as absent when the header says no GCT", () => {
    const bytes = makeGif({ hasGct: false });
    expect(buildGifSection(bytes)?.rows[2]?.value).toContain("no global color table");
  });
});
