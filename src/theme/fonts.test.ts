import { describe, expect, it } from "vitest";
import { BUNDLED_FONTS, fontFamilyStack } from "./fonts";

describe("BUNDLED_FONTS", () => {
  it("ships the four families the M10 spec commits to", () => {
    const displayNames = BUNDLED_FONTS.map((f) => f.displayName);
    expect(displayNames).toEqual(["JetBrains Mono", "Fira Code", "Cascadia Code", "Iosevka"]);
  });

  it("every entry ships OFL-1.1 licence + an upstream URL", () => {
    for (const font of BUNDLED_FONTS) {
      expect(font.licence).toBe("OFL-1.1");
      expect(font.source.startsWith("https://github.com/")).toBe(true);
    }
  });
});

describe("fontFamilyStack", () => {
  it("with null chosen returns a stack starting with the first bundled family", () => {
    const stack = fontFamilyStack(null);
    expect(stack.startsWith('"JetBrains Mono"')).toBe(true);
  });

  it("with a chosen family puts it first", () => {
    expect(fontFamilyStack("Menlo").startsWith("Menlo,")).toBe(true);
  });

  it("quotes multi-word family names", () => {
    expect(fontFamilyStack("SF Mono").startsWith('"SF Mono",')).toBe(true);
  });

  it("does not quote single-word family names", () => {
    // "Menlo" is a bare identifier and doesn't need quotes.
    expect(fontFamilyStack("Menlo").startsWith("Menlo,")).toBe(true);
  });

  it("includes every bundled family after the user's chosen", () => {
    const stack = fontFamilyStack("Menlo");
    for (const font of BUNDLED_FONTS) {
      const cssName = /\s/.test(font.cssFamily) ? `"${font.cssFamily}"` : font.cssFamily;
      expect(stack).toContain(cssName);
    }
  });

  it("includes the Nerd Font fallback so prompt-strip glyphs still render", () => {
    // Prompt strip icons + statusline glyphs live in the
    // Nerd Font patched face. Per-character font-fallback
    // pulls them in from this entry even when the user
    // picked a non-Nerd family like Fira Code.
    const stack = fontFamilyStack("Fira Code");
    expect(stack).toContain('"JetBrainsMono Nerd Font Mono"');
  });

  it("ends in `monospace` as the last-ditch OS fallback", () => {
    expect(fontFamilyStack(null).endsWith("monospace")).toBe(true);
  });

  it("de-duplicates when the chosen family matches a bundled one", () => {
    const stack = fontFamilyStack("JetBrains Mono");
    const occurrences = (stack.match(/"JetBrains Mono"/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("empty chosen string is treated the same as null", () => {
    expect(fontFamilyStack("")).toBe(fontFamilyStack(null));
  });
});
