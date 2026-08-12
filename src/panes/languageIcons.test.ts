/**
 * Unit tests for the language-label → Nerd Font chip mapping (M12.4).
 *
 * The mapping is a plain lookup table — these tests guard against
 * accidental table edits (a codepoint typo, a missing entry, a
 * duplicate) more than they exercise interesting logic.
 */

import { describe, it, expect } from "vitest";
import { languageChip, ALL_LANGUAGE_CHIPS } from "./languageIcons";

describe("languageIcons / lookup", () => {
  it("returns null for null / undefined / empty input", () => {
    expect(languageChip(null)).toBeNull();
    expect(languageChip(undefined)).toBeNull();
    expect(languageChip("")).toBeNull();
  });

  it("returns null for an unknown label", () => {
    expect(languageChip("elixir")).toBeNull();
    expect(languageChip("haskell")).toBeNull();
  });

  it("returns the chip for every label the shim can emit", () => {
    // The full set the shell's _shax_detect_lang can emit. If this
    // list drifts from the shim, the frontend silently drops the chip
    // — this test catches that.
    const shimLabels = [
      "rust",
      "swift",
      "deno",
      "typescript",
      "node",
      "python",
      "go",
      "ruby",
      "kotlin",
      "java",
      "csharp",
      "c-cpp",
    ] as const;
    for (const label of shimLabels) {
      const chip = languageChip(label);
      expect(chip, `chip for ${label} must exist`).not.toBeNull();
      expect(chip?.label).toBe(label);
      expect(chip?.icon.length).toBeGreaterThan(0);
      expect(chip?.displayName.length).toBeGreaterThan(0);
    }
  });

  it("c-cpp displays as `c/c++` (single shared chip, per spec §18 M12.4)", () => {
    expect(languageChip("c-cpp")?.displayName).toBe("c/c++");
  });

  it("csharp displays as `c#` (label kept ASCII-safe on the wire)", () => {
    expect(languageChip("csharp")?.displayName).toBe("c#");
  });
});

describe("languageIcons / table integrity", () => {
  it("every label in the table is unique", () => {
    const labels = ALL_LANGUAGE_CHIPS.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every icon in the table is a single character", () => {
    // Nerd Font glyphs are single Unicode codepoints. A two-char
    // string here would be a copy-paste error (accidentally including
    // a variation selector or another glyph).
    for (const chip of ALL_LANGUAGE_CHIPS) {
      expect(chip.icon.length, `icon for ${chip.label}`).toBe(1);
    }
  });
});
