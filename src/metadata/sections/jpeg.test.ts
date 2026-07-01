import { describe, expect, it } from "vitest";
import { buildJpegSection } from "./jpeg";

/** Build a JPEG-shaped byte string with SOI + SOF0 for the
 *  requested dimensions and subsampling. */
function makeJpeg({
  width = 800,
  height = 600,
  hSample = 1,
  vSample = 1,
  components = 3,
}: {
  width?: number;
  height?: number;
  hSample?: number;
  vSample?: number;
  components?: number;
} = {}): Uint8Array {
  const parts: number[] = [];
  parts.push(0xff, 0xd8); // SOI
  // SOF0 marker
  parts.push(0xff, 0xc0);
  // Length: 2 (length itself) + 6 (SOF fixed fields) + 3 * components.
  const length = 8 + 3 * components;
  parts.push((length >> 8) & 0xff, length & 0xff);
  parts.push(8); // 8-bit precision
  parts.push((height >> 8) & 0xff, height & 0xff);
  parts.push((width >> 8) & 0xff, width & 0xff);
  parts.push(components);
  parts.push(1, (hSample << 4) | vSample, 0);
  for (let i = 1; i < components; i++) parts.push(i + 1, 0x11, 0);
  parts.push(0xff, 0xd9); // EOI
  return new Uint8Array(parts);
}

describe("buildJpegSection", () => {
  it("returns null when the bytes aren't a JPEG", () => {
    expect(buildJpegSection(new Uint8Array([0x00, 0x01]))).toBeNull();
  });

  it("extracts baseline SOF0 dimensions and precision", () => {
    const bytes = makeJpeg({ width: 1920, height: 1080 });
    const section = buildJpegSection(bytes);
    expect(section?.title).toBe("JPEG");
    expect(section?.rows[0]).toMatchObject({ key: "Dimensions", value: "1920 × 1080" });
    expect(section?.rows[1]).toMatchObject({ key: "Precision", value: "8-bit" });
    expect(section?.rows[2]).toMatchObject({ key: "Components", value: "3" });
  });

  it("labels chroma subsampling from the Y sampling factors", () => {
    const s = (bytes: Uint8Array): string | undefined =>
      buildJpegSection(bytes)?.rows.find((r) => r.key === "Subsampling")?.value;
    expect(s(makeJpeg({ hSample: 1, vSample: 1 }))).toBe("4:4:4");
    expect(s(makeJpeg({ hSample: 2, vSample: 1 }))).toBe("4:2:2");
    expect(s(makeJpeg({ hSample: 2, vSample: 2 }))).toBe("4:2:0");
  });

  it("labels grayscale JPEG (single component)", () => {
    const section = buildJpegSection(makeJpeg({ components: 1 }));
    const sub = section?.rows.find((r) => r.key === "Subsampling")?.value;
    expect(sub).toBe("grayscale");
  });
});
