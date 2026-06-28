import { describe, expect, it } from "vitest";
import { stripAnsi } from "./stripAnsi";

describe("stripAnsi", () => {
  it("removes CSI sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
    expect(stripAnsi("\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[m")).toBe("%");
  });

  it("removes OSC sequences terminated by BEL", () => {
    expect(stripAnsi("\x1b]0;some title\x07rest")).toBe("rest");
  });

  it("removes OSC sequences terminated by ST (ESC \\)", () => {
    expect(stripAnsi("\x1b]0;some title\x1b\\rest")).toBe("rest");
  });

  it("drops two bytes for unrecognised ESC sequences", () => {
    // ESC + any non-CSI / non-OSC follow byte gets stripped as a
    // two-byte sequence. Charset selects (`ESC ( B`) are actually
    // three bytes, but the trailing letter is harmless on its own
    // and we'd rather over-strip junk than risk garbage chars.
    expect(stripAnsi("\x1b=plain")).toBe("plain");
  });

  it("leaves clean text untouched", () => {
    expect(stripAnsi("hello world\n")).toBe("hello world\n");
  });

  it("is idempotent", () => {
    const dirty = "\x1b[31mred\x1b[0m";
    expect(stripAnsi(stripAnsi(dirty))).toBe(stripAnsi(dirty));
  });

  it("handles zsh's missing-newline indicator", () => {
    // The literal bytes zsh emits after a no-newline command.
    const indicator = "\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[m";
    expect(stripAnsi(`README content${indicator}`)).toBe("README content%");
  });
});
