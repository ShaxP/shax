import { describe, expect, it } from "vitest";
import {
  detectContentType,
  extensionOf,
  firstFilenameArg,
  imageFromMagicBytes,
  looksLikeSvg,
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
});
