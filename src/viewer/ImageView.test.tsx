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

describe("ImageView · raster", () => {
  it("renders an <img> with a data URL using the right MIME", () => {
    render(<ImageView bytes={PNG_BYTES} kind="raster" filenameHint="photo.png" />);
    const img = screen.getByTestId("image-view-img");
    if (!(img instanceof HTMLImageElement)) throw new Error("expected <img>");
    expect(img.src.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("picks JPEG MIME from a `.jpg` hint", () => {
    render(<ImageView bytes={PNG_BYTES} kind="raster" filenameHint="cat.jpg" />);
    const img = screen.getByTestId("image-view-img");
    if (!(img instanceof HTMLImageElement)) throw new Error("expected <img>");
    expect(img.src.startsWith("data:image/jpeg;base64,")).toBe(true);
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
