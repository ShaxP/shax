import { describe, expect, it } from "vitest";
import {
  detectContentType,
  extensionOf,
  firstFilenameArg,
  imageFromMagicBytes,
  looksLikeSvg,
  pdfFromMagicBytes,
} from "./detectContentType";

describe("extensionOf", () => {
  it("returns lower-cased trailing extension", () => {
    expect(extensionOf("README.md")).toBe("md");
    expect(extensionOf("photo.PNG")).toBe("png");
    expect(extensionOf("path/to/foo.tsx")).toBe("tsx");
  });

  it("returns null when no extension is present", () => {
    expect(extensionOf("Makefile")).toBeNull();
    expect(extensionOf("path/to/Dockerfile")).toBeNull();
  });

  it("does not treat dotfiles as having an extension", () => {
    expect(extensionOf(".bashrc")).toBeNull();
    expect(extensionOf("/home/me/.zshrc")).toBeNull();
  });

  it("returns null on a trailing dot", () => {
    expect(extensionOf("foo.")).toBeNull();
  });
});

describe("firstFilenameArg", () => {
  it("returns the first non-flag positional past the program name", () => {
    expect(firstFilenameArg(["cat", "README.md"])).toBe("README.md");
    expect(firstFilenameArg(["bat", "--paging=never", "src/lib.rs"])).toBe("src/lib.rs");
  });

  it("returns null when only the program name is present", () => {
    expect(firstFilenameArg(["ls"])).toBeNull();
  });
});

describe("imageFromMagicBytes", () => {
  it("detects PNG", () => {
    expect(imageFromMagicBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image");
  });

  it("detects JPEG", () => {
    expect(imageFromMagicBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image");
  });

  it("detects GIF89a", () => {
    expect(imageFromMagicBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image");
  });

  it("detects WebP", () => {
    const bytes = new Uint8Array(12);
    bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(imageFromMagicBytes(bytes)).toBe("image");
  });

  it("returns null for non-image bytes", () => {
    expect(imageFromMagicBytes(new Uint8Array([0x68, 0x69, 0x21]))).toBeNull();
  });
});

describe("pdfFromMagicBytes", () => {
  it("detects the %PDF- header (v1.4)", () => {
    // "%PDF-1.4" — the header a normal PDF starts with.
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    expect(pdfFromMagicBytes(bytes)).toBe("pdf");
  });

  it("detects PDF 2.0 headers the same way (four-byte sniff)", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32, 0x2e, 0x30]);
    expect(pdfFromMagicBytes(bytes)).toBe("pdf");
  });

  it("returns null for a PNG header", () => {
    expect(pdfFromMagicBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("returns null for plaintext that starts with a %", () => {
    // A shell script starting with `%comment` should NOT
    // register — the second byte must be `P` (0x50).
    expect(pdfFromMagicBytes(new Uint8Array([0x25, 0x20, 0x63, 0x6f]))).toBeNull();
  });

  it("returns null for empty / too-short input", () => {
    expect(pdfFromMagicBytes(new Uint8Array([]))).toBeNull();
    expect(pdfFromMagicBytes(new Uint8Array([0x25, 0x50, 0x44]))).toBeNull();
  });
});

describe("looksLikeSvg", () => {
  it("matches an inline <svg> root", () => {
    expect(looksLikeSvg("<svg xmlns='http://www.w3.org/2000/svg'><circle r='1'/></svg>")).toBe(
      true,
    );
  });

  it("matches XML declaration followed by <svg>", () => {
    expect(looksLikeSvg('<?xml version="1.0"?>\n<svg></svg>')).toBe(true);
  });

  it("rejects plain text", () => {
    expect(looksLikeSvg("hello world")).toBe(false);
  });
});

describe("detectContentType pipeline", () => {
  it("classifies markdown by extension", () => {
    expect(detectContentType({ argv: ["cat", "README.md"] })).toBe("markdown");
  });

  it("classifies images by extension", () => {
    expect(detectContentType({ argv: ["cat", "photo.png"] })).toBe("image");
    expect(detectContentType({ argv: ["cat", "art.svg"] })).toBe("svg");
  });

  it("falls back to magic bytes when filename is absent", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(detectContentType({ bytes: png })).toBe("image");
  });

  it("falls back to SVG text sniff when both filename and magic bytes miss", () => {
    expect(detectContentType({ text: "<svg></svg>" })).toBe("svg");
  });

  it("defaults to code", () => {
    expect(detectContentType({ argv: ["cat", "main.rs"], text: "fn main() {}" })).toBe("code");
    expect(detectContentType({ text: "plain text" })).toBe("code");
  });

  // M11.1 — PDF entry paths
  it("classifies PDF by extension", () => {
    expect(detectContentType({ argv: ["cat", "invoice.pdf"] })).toBe("pdf");
  });

  it("classifies PDF by magic bytes when filename is absent", () => {
    // "%PDF-1.4" — a bare byte sniff, e.g. `curl -sO ... && cat`
    // where the argv doesn't carry a filename hint.
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    expect(detectContentType({ bytes })).toBe("pdf");
  });

  it("classifies PDF by magic bytes even when the filename lies", () => {
    // A file named `foo.txt` that actually holds PDF bytes.
    // The extension check hits `foo.txt` → no map entry → falls
    // through to the magic-byte sniff → pdf.
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x37]);
    expect(detectContentType({ argv: ["cat", "foo.txt"], bytes })).toBe("pdf");
  });
});
