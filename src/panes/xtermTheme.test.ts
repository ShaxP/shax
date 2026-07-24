/**
 * Unit tests for the xterm theme derivation helper.
 *
 * jsdom's `getComputedStyle` does not resolve CSS custom
 * properties (real browsers do). So we can't verify the token→rgb
 * conversion here — that needs a real browser and is covered by
 * manual smoke and Playwright. What we CAN pin in jsdom:
 *
 *  - The helper returns an ITheme with every expected key,
 *    including all 16 ANSI roles + `cursor`, `cursorAccent`,
 *    `selectionBackground`, `foreground`, `background`.
 *  - The probe element is cleaned up after each call so we don't
 *    leak DOM nodes.
 */

import { describe, expect, it } from "vitest";
import { readXtermTheme } from "./xtermTheme";

describe("readXtermTheme", () => {
  it("returns an ITheme populated for every ANSI role plus core colours", () => {
    const theme = readXtermTheme();
    expect(theme).not.toBeNull();
    if (theme === null) return;

    const expectedKeys = [
      "background",
      "foreground",
      "cursor",
      "cursorAccent",
      "selectionBackground",
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const;
    for (const key of expectedKeys) {
      expect(theme).toHaveProperty(key);
    }
  });

  it("does not leak the probe element used to read computed styles", () => {
    const before = document.body.childElementCount;
    readXtermTheme();
    readXtermTheme();
    expect(document.body.childElementCount).toBe(before);
  });
});
