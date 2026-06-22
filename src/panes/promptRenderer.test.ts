/**
 * Unit tests for the tiny single-line VT renderer that drives the
 * M1.9 PromptStrip.
 *
 * Each test feeds a hand-crafted byte stream (the same shape the shell
 * would emit) and verifies the resulting line buffer + cursor position.
 * The renderer is pure, so tests run without any DOM or async wait.
 */

import { describe, it, expect } from "vitest";
import { feed, emptyPromptLine } from "./promptRenderer";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("promptRenderer / printable text", () => {
  it("appends printable ASCII characters", () => {
    const r = feed(emptyPromptLine, bytes("hello"));
    expect(r).toEqual({ text: "hello", cursor: 5 });
  });

  it("handles UTF-8 multi-byte characters", () => {
    const r = feed(emptyPromptLine, bytes("héllo ✦"));
    expect(r.text).toBe("héllo ✦");
    expect(r.cursor).toBe(r.text.length);
  });

  it("REPLACE semantics: writing at a mid-line cursor overwrites existing chars", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, new Uint8Array([0x08, 0x08, 0x08])); // BS BS BS
    expect(r).toEqual({ text: "abcdef", cursor: 3 });
    r = feed(r, bytes("XYZ"));
    expect(r).toEqual({ text: "abcXYZ", cursor: 6 });
  });

  it("extends the line when overwrite runs past the end", () => {
    let r = feed(emptyPromptLine, bytes("abc"));
    r = feed(r, new Uint8Array([0x08])); // BS
    r = feed(r, bytes("XY")); // cursor was 2, write XY → "abXY"
    expect(r).toEqual({ text: "abXY", cursor: 4 });
  });
});

describe("promptRenderer / cursor controls", () => {
  it("CR resets cursor to column 0 without clearing text", () => {
    const r = feed(emptyPromptLine, bytes("hello\r"));
    expect(r).toEqual({ text: "hello", cursor: 0 });
  });

  it("LF clears the line and resets the cursor (single-line)", () => {
    const r = feed(emptyPromptLine, bytes("hello\n"));
    expect(r).toEqual({ text: "", cursor: 0 });
  });

  it("BS moves the cursor left; clamps at 0", () => {
    let r = feed(emptyPromptLine, bytes("ab"));
    r = feed(r, new Uint8Array([0x08, 0x08, 0x08, 0x08])); // BS x4
    expect(r.cursor).toBe(0);
  });

  it("DEL (0x7f) is treated as a backspace", () => {
    let r = feed(emptyPromptLine, bytes("abc"));
    r = feed(r, new Uint8Array([0x7f]));
    expect(r.cursor).toBe(2);
  });

  it("BEL is ignored", () => {
    const r = feed(emptyPromptLine, new Uint8Array([0x07]));
    expect(r).toEqual({ text: "", cursor: 0 });
  });
});

describe("promptRenderer / CSI cursor moves", () => {
  it("CSI C moves the cursor forward N (clamped to text length)", () => {
    let r = feed(emptyPromptLine, bytes("hello"));
    r = feed(r, bytes("\r")); // cursor=0
    r = feed(r, bytes("\x1b[2C"));
    expect(r.cursor).toBe(2);
    r = feed(r, bytes("\x1b[99C"));
    expect(r.cursor).toBe(5);
  });

  it("CSI D moves the cursor backward N (clamped to 0)", () => {
    let r = feed(emptyPromptLine, bytes("hello"));
    r = feed(r, bytes("\x1b[2D"));
    expect(r.cursor).toBe(3);
    r = feed(r, bytes("\x1b[99D"));
    expect(r.cursor).toBe(0);
  });

  it("CSI G sets the cursor to an absolute column (1-indexed)", () => {
    let r = feed(emptyPromptLine, bytes("hello"));
    r = feed(r, bytes("\x1b[3G"));
    expect(r.cursor).toBe(2);
  });
});

describe("promptRenderer / erase line", () => {
  it("CSI K (default) erases from cursor to end of line", () => {
    let r = feed(emptyPromptLine, bytes("hello world"));
    r = feed(r, bytes("\r\x1b[5C")); // cursor=5 (between "hello" and " world")
    r = feed(r, bytes("\x1b[K"));
    expect(r).toEqual({ text: "hello", cursor: 5 });
  });

  it("CSI 1 K erases from start of line to cursor (replacing with spaces)", () => {
    let r = feed(emptyPromptLine, bytes("hello world"));
    r = feed(r, bytes("\r\x1b[6C")); // cursor=6
    r = feed(r, bytes("\x1b[1K"));
    expect(r.text).toBe("      world");
    expect(r.cursor).toBe(6);
  });

  it("CSI 2 K erases the entire line, leaving the cursor in place", () => {
    let r = feed(emptyPromptLine, bytes("hello"));
    r = feed(r, bytes("\x1b[2K"));
    expect(r).toEqual({ text: "", cursor: 5 });
  });
});

describe("promptRenderer / insert/delete", () => {
  it("CSI @ inserts N blank characters at cursor", () => {
    let r = feed(emptyPromptLine, bytes("ab"));
    r = feed(r, bytes("\x1b[1D\x1b[2@")); // cursor=1, then insert 2 spaces
    expect(r.text).toBe("a  b");
    expect(r.cursor).toBe(1);
  });

  it("CSI P deletes N characters at cursor", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, bytes("\r\x1b[2C\x1b[2P")); // cursor=2, delete 2
    expect(r).toEqual({ text: "abef", cursor: 2 });
  });
});

describe("promptRenderer / ignored sequences", () => {
  it("SGR (color) sequences are consumed without affecting text", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[31mred\x1b[0m"));
    expect(r).toEqual({ text: "red", cursor: 3 });
  });

  it("OSC sequences (title, hyperlinks) are ignored", () => {
    const r = feed(emptyPromptLine, bytes("\x1b]0;window title\x07after"));
    expect(r).toEqual({ text: "after", cursor: 5 });
  });

  it("unknown CSI finals are consumed but do not crash or corrupt text", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[5Sabc"));
    expect(r).toEqual({ text: "abc", cursor: 3 });
  });
});

describe("promptRenderer / shell-typing flows", () => {
  it("typing a command then pressing Backspace (CSI K style) drops the last char", () => {
    // User types "ls -la", then presses Backspace. Readline's redisplay
    // moves the cursor left, then erases to end of line.
    let r = feed(emptyPromptLine, bytes("ls -la"));
    r = feed(r, bytes("\x1b[1D\x1b[K"));
    expect(r).toEqual({ text: "ls -l", cursor: 5 });
  });

  it("history navigation: CR + new text + CSI K reshapes the line", () => {
    // Shell shows "echo hi", user presses ↑, shell rewrites with the
    // previous command "ls -la" using CR + write + erase-to-end.
    let r = feed(emptyPromptLine, bytes("echo hi"));
    r = feed(r, bytes("\rls -la\x1b[K"));
    expect(r).toEqual({ text: "ls -la", cursor: 6 });
  });

  it("Tab completion: writing more chars at the end extends the line", () => {
    let r = feed(emptyPromptLine, bytes("cd src/"));
    r = feed(r, bytes("panes/"));
    expect(r).toEqual({ text: "cd src/panes/", cursor: 13 });
  });
});
