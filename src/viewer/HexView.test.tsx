/**
 * Tests for the hex viewer (M4.5 slice 1). Focused on the
 * structural correctness of the rendered rows — actual layout
 * is a CSS grid that jsdom doesn't measure.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { HexView } from "./HexView";

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("HexView", () => {
  it("renders the file-signature row for a PNG header", () => {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    render(<HexView bytes={png} />);
    const view = screen.getByTestId("hex-view");
    expect(view).toHaveTextContent("00000000");
    expect(view).toHaveTextContent("89");
    expect(view).toHaveTextContent("50");
    expect(view).toHaveTextContent("4E");
    expect(view).toHaveTextContent("47");
    // Printable ASCII column — PNG header has `.PNG.....` (the
    // first `.` is the non-printable 0x89; `PNG` is 0x50 0x4e
    // 0x47; remaining bytes are non-printable so render as `.`).
    expect(view).toHaveTextContent(".PNG");
  });

  it("renders multiple rows for content over 16 bytes", () => {
    const data = bytes(Array.from({ length: 40 }, (_, i) => i));
    render(<HexView bytes={data} />);
    const view = screen.getByTestId("hex-view");
    expect(view).toHaveTextContent("00000000");
    expect(view).toHaveTextContent("00000010");
    expect(view).toHaveTextContent("00000020");
  });

  it("renders an empty container for zero bytes", () => {
    render(<HexView bytes={bytes([])} />);
    const view = screen.getByTestId("hex-view");
    expect(view).toBeInTheDocument();
    expect(view).not.toHaveTextContent("00000000");
  });

  it("truncates and shows the footer when content exceeds the cap", () => {
    const big = bytes(Array.from({ length: 100 }, () => 0x41));
    render(<HexView bytes={big} cap={32} />);
    const footer = screen.getByTestId("hex-view-truncated");
    expect(footer).toHaveTextContent("truncated at 32 bytes");
    expect(footer).toHaveTextContent("68 more bytes not shown");
  });

  it("doesn't show the footer when content fits", () => {
    render(<HexView bytes={bytes([0x41, 0x42])} cap={1024} />);
    expect(screen.queryByTestId("hex-view-truncated")).toBeNull();
  });

  it("renders non-printable bytes as `.` in the ASCII column", () => {
    // Control bytes mixed with printable ones.
    const data = bytes([0x00, 0x09, 0x0a, 0x41, 0x42, 0x7f]);
    render(<HexView bytes={data} />);
    const view = screen.getByTestId("hex-view");
    // The ASCII column shows `...AB.` — three controls, then
    // `A` `B`, then DEL.
    expect(view).toHaveTextContent("...AB.");
  });
});
