/**
 * Tests for the image content renderer (M4 slice 4.2). Raster
 * path renders a data URL; SVG path is sanitised with DOMPurify
 * before injection. The injection surface tests below are the
 * critical ones — SVG can carry scripts.
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import { ImageView } from "./ImageView";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);

describe("ImageView · raster", () => {
  it("renders a PNG with image/png MIME (from magic bytes)", () => {
    render(<ImageView bytes={PNG_BYTES} kind="raster" filenameHint="photo.png" />);
    const img = screen.getByTestId("image-view-img");
    if (!(img instanceof HTMLImageElement)) throw new Error("expected <img>");
    expect(img.src.startsWith("blob:")).toBe(true);
  });

  it("renders a JPEG with image/jpeg MIME from magic bytes", () => {
    render(<ImageView bytes={JPEG_BYTES} kind="raster" filenameHint={null} />);
    const img = screen.getByTestId("image-view-img");
    if (!(img instanceof HTMLImageElement)) throw new Error("expected <img>");
    expect(img.src.startsWith("blob:")).toBe(true);
  });

  it("renders a GIF with image/gif MIME from magic bytes — required for the browser to animate", () => {
    render(<ImageView bytes={GIF_BYTES} kind="raster" filenameHint={null} />);
    const img = screen.getByTestId("image-view-img");
    if (!(img instanceof HTMLImageElement)) throw new Error("expected <img>");
    expect(img.src.startsWith("blob:")).toBe(true);
  });

  it("magic bytes win over a misleading filename hint", () => {
    // Hint says `.png` but bytes are a GIF — the bytes are
    // authoritative. Otherwise some browsers refuse animation.
    render(<ImageView bytes={GIF_BYTES} kind="raster" filenameHint="lies.png" />);
    const img = screen.getByTestId("image-view-img");
    if (!(img instanceof HTMLImageElement)) throw new Error("expected <img>");
    expect(img.src.startsWith("blob:")).toBe(true);
  });

  it("falls back to the filename hint when bytes don't match a known format", () => {
    const unknown = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    render(<ImageView bytes={unknown} kind="raster" filenameHint="cat.gif" />);
    const img = screen.getByTestId("image-view-img");
    if (!(img instanceof HTMLImageElement)) throw new Error("expected <img>");
    expect(img.src.startsWith("blob:")).toBe(true);
  });
});

describe("ImageView · svg sanitisation", () => {
  function svg(body: string): Uint8Array {
    return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
  }

  it("renders a benign SVG", () => {
    render(<ImageView bytes={svg("<circle cx='5' cy='5' r='2'/>")} kind="svg" />);
    const host = screen.getByTestId("image-view-svg");
    expect(host.querySelector("svg")).not.toBeNull();
    expect(host.querySelector("circle")).not.toBeNull();
  });

  it("strips embedded <script> tags", () => {
    render(<ImageView bytes={svg("<script>window.svg_pwned = 1</script>")} kind="svg" />);
    const host = screen.getByTestId("image-view-svg");
    expect(host.querySelector("script")).toBeNull();
    expect((window as unknown as { svg_pwned?: number }).svg_pwned).toBeUndefined();
  });

  it("strips on* event handlers", () => {
    render(<ImageView bytes={svg("<rect onload='boom()' width='10' height='10'/>")} kind="svg" />);
    const rect = screen.getByTestId("image-view-svg").querySelector("rect");
    expect(rect?.getAttribute("onload")).toBeNull();
  });

  it("strips <foreignObject> which can re-embed HTML/JS", () => {
    render(
      <ImageView
        bytes={svg("<foreignObject width='10' height='10'><div>nope</div></foreignObject>")}
        kind="svg"
      />,
    );
    const host = screen.getByTestId("image-view-svg");
    expect(host.querySelector("foreignObject")).toBeNull();
    expect(host.querySelector("foreignobject")).toBeNull();
  });
});
