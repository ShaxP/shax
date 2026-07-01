import { describe, expect, it } from "vitest";
import { hasSgr, parseAnsi } from "./sgr";

const ESC = "";

describe("hasSgr", () => {
  it("returns false on plain text", () => {
    expect(hasSgr("hello world")).toBe(false);
  });

  it("returns true when an ESC byte is present", () => {
    expect(hasSgr(`${ESC}[31mred${ESC}[0m`)).toBe(true);
  });
});

describe("parseAnsi", () => {
  it("returns a single span for plain text", () => {
    const spans = parseAnsi("hello");
    expect(spans).toEqual([{ text: "hello", style: {} }]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseAnsi("")).toEqual([]);
  });

  it("applies fg colour to the following run only", () => {
    const spans = parseAnsi(`plain ${ESC}[31mred${ESC}[0m tail`);
    expect(spans.map((s) => s.text)).toEqual(["plain ", "red", " tail"]);
    expect(spans[0]?.style).toEqual({});
    expect(spans[1]?.style.fg).toEqual({ kind: "palette", name: "red" });
    expect(spans[2]?.style).toEqual({});
  });

  it("carries style across spans until reset or override", () => {
    const spans = parseAnsi(`${ESC}[1mbold ${ESC}[31mred${ESC}[0m end`);
    expect(spans[0]?.style).toEqual({ bold: true });
    expect(spans[1]?.style).toEqual({ bold: true, fg: { kind: "palette", name: "red" } });
    expect(spans[2]?.style).toEqual({});
  });

  it("understands SGR 22 clearing both bold and dim without touching colour", () => {
    const spans = parseAnsi(`${ESC}[1;2;31mboth${ESC}[22m mid${ESC}[0m end`);
    expect(spans[0]?.style).toEqual({
      bold: true,
      dim: true,
      fg: { kind: "palette", name: "red" },
    });
    expect(spans[1]?.style).toEqual({ fg: { kind: "palette", name: "red" } });
    expect(spans[2]?.style).toEqual({});
  });

  it("handles 8-bright fg range (90-97)", () => {
    const spans = parseAnsi(`${ESC}[92mgreen`);
    expect(spans[0]?.style.fg).toEqual({ kind: "palette", name: "bright-green" });
  });

  it("handles 8-bright bg range (100-107)", () => {
    const spans = parseAnsi(`${ESC}[105mbg`);
    expect(spans[0]?.style.bg).toEqual({ kind: "palette", name: "bright-magenta" });
  });

  it("parses 256-color palette indices (38;5;n)", () => {
    const spans = parseAnsi(`${ESC}[38;5;13mmagenta`);
    // Index 13 is bright-magenta in the standard mapping.
    expect(spans[0]?.style.fg).toEqual({ kind: "palette", name: "bright-magenta" });
  });

  it("parses 256-color cube indices to concrete rgb", () => {
    // Index 196 is pure red in the 6x6x6 cube (r=5, g=0, b=0).
    const spans = parseAnsi(`${ESC}[38;5;196mred`);
    expect(spans[0]?.style.fg).toEqual({ kind: "rgb", r: 255, g: 0, b: 0 });
  });

  it("parses 256-color grayscale ramp", () => {
    // Index 232 is level 8; 255 is level 8 + 23*10 = 238.
    const spans = parseAnsi(`${ESC}[38;5;232mgray${ESC}[38;5;255mlight`);
    expect(spans[0]?.style.fg).toEqual({ kind: "rgb", r: 8, g: 8, b: 8 });
    expect(spans[1]?.style.fg).toEqual({ kind: "rgb", r: 238, g: 238, b: 238 });
  });

  it("parses 24-bit truecolor (38;2;r;g;b)", () => {
    const spans = parseAnsi(`${ESC}[38;2;10;20;30mtruecolor`);
    expect(spans[0]?.style.fg).toEqual({ kind: "rgb", r: 10, g: 20, b: 30 });
  });

  it("handles bg truecolor (48;2;r;g;b) independently of fg", () => {
    const spans = parseAnsi(`${ESC}[31;48;2;5;5;5mmix`);
    expect(spans[0]?.style.fg).toEqual({ kind: "palette", name: "red" });
    expect(spans[0]?.style.bg).toEqual({ kind: "rgb", r: 5, g: 5, b: 5 });
  });

  it("understands 39 / 49 as defaults (drops fg / bg)", () => {
    const spans = parseAnsi(`${ESC}[31;41mred${ESC}[39mfg-only${ESC}[49mplain`);
    expect(spans[0]?.style.fg).toEqual({ kind: "palette", name: "red" });
    expect(spans[0]?.style.bg).toEqual({ kind: "palette", name: "red" });
    expect(spans[1]?.style.fg).toBeUndefined();
    expect(spans[1]?.style.bg).toEqual({ kind: "palette", name: "red" });
    expect(spans[2]?.style.fg).toBeUndefined();
    expect(spans[2]?.style.bg).toBeUndefined();
  });

  it("drops non-SGR CSI sequences without emitting them as text", () => {
    // `ESC[2K` erases the line; we don't simulate the terminal
    // but must not emit `[2K` as literal. Same-style runs on
    // either side merge into a single span.
    const spans = parseAnsi(`before${ESC}[2Kafter`);
    expect(spans).toEqual([{ text: "beforeafter", style: {} }]);
  });

  it("drops OSC sequences (title set) including the BEL terminator", () => {
    const spans = parseAnsi(`pre${ESC}]0;window titlepost`);
    expect(spans.map((s) => s.text).join("")).toBe("prepost");
  });

  it("drops OSC sequences terminated by ST (`ESC \\`)", () => {
    const spans = parseAnsi(`pre${ESC}]52;c;abc${ESC}\\post`);
    expect(spans.map((s) => s.text).join("")).toBe("prepost");
  });

  it("survives an unterminated CSI at end-of-input", () => {
    const spans = parseAnsi(`ok${ESC}[31`);
    expect(spans).toEqual([{ text: "ok", style: {} }]);
  });

  it("empty SGR (`ESC[m`) resets everything", () => {
    const spans = parseAnsi(`${ESC}[1;31mred${ESC}[mtail`);
    expect(spans[0]?.style).toEqual({ bold: true, fg: { kind: "palette", name: "red" } });
    expect(spans[1]?.style).toEqual({});
  });

  it("handles italic / underline / strikethrough toggle codes", () => {
    const spans = parseAnsi(`${ESC}[3;4;9mfancy${ESC}[23muni-${ESC}[24mp-${ESC}[29mplain`);
    expect(spans[0]?.style).toEqual({ italic: true, underline: true, strikethrough: true });
    expect(spans[1]?.style).toEqual({ underline: true, strikethrough: true });
    expect(spans[2]?.style).toEqual({ strikethrough: true });
    expect(spans[3]?.style).toEqual({});
  });

  it("clamps truecolor components to [0, 255]", () => {
    const spans = parseAnsi(`${ESC}[38;2;500;-1;127mmix`);
    expect(spans[0]?.style.fg).toEqual({ kind: "rgb", r: 255, g: 0, b: 127 });
  });

  it("survives malformed 38 without mode selector", () => {
    // `38m` alone doesn't select fg — the mode subparam is
    // required. We should silently drop the sequence rather
    // than eating the next unrelated code.
    const spans = parseAnsi(`${ESC}[38mfollowed`);
    expect(spans).toEqual([{ text: "followed", style: {} }]);
  });
});
