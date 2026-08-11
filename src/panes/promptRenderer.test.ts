/**
 * Unit tests for the tiny multi-row VT renderer that drives the
 * PromptStrip.
 *
 * Each test feeds a hand-crafted byte stream (the same shape the shell
 * would emit) and verifies the resulting row stack + cursor position.
 * The renderer is pure, so tests run without any DOM or async wait.
 */

import { describe, it, expect } from "vitest";
import { feed, emptyPromptLine } from "./promptRenderer";
import type { PromptLine } from "./promptRenderer";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Extract just the visible text of every row — collapse test output
 *  to something readable. */
function rowTexts(line: PromptLine): string[] {
  return line.rows.map((r) => r.text);
}

describe("promptRenderer / printable text", () => {
  it("appends printable ASCII characters", () => {
    const r = feed(emptyPromptLine, bytes("hello"));
    expect(rowTexts(r)).toEqual(["hello"]);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(5);
  });

  it("handles UTF-8 multi-byte characters", () => {
    const r = feed(emptyPromptLine, bytes("héllo ✦"));
    expect(rowTexts(r)).toEqual(["héllo ✦"]);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe("héllo ✦".length);
  });

  it("REPLACE semantics: writing at a mid-row cursor overwrites existing chars", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, new Uint8Array([0x08, 0x08, 0x08])); // BS BS BS
    expect(r.cursorCol).toBe(3);
    r = feed(r, bytes("XYZ"));
    expect(rowTexts(r)).toEqual(["abcXYZ"]);
    expect(r.cursorCol).toBe(6);
  });

  it("extends the row when overwrite runs past the end", () => {
    let r = feed(emptyPromptLine, bytes("abc"));
    r = feed(r, new Uint8Array([0x08])); // BS
    r = feed(r, bytes("XY")); // cursor was 2, write XY → "abXY"
    expect(rowTexts(r)).toEqual(["abXY"]);
    expect(r.cursorCol).toBe(4);
  });
});

describe("promptRenderer / cursor controls", () => {
  it("CR resets cursor to column 0 of the current row without clearing text", () => {
    const r = feed(emptyPromptLine, bytes("hello\r"));
    expect(rowTexts(r)).toEqual(["hello"]);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(0);
  });

  it("BS moves the cursor left within the row; clamps at 0", () => {
    let r = feed(emptyPromptLine, bytes("abc"));
    r = feed(r, new Uint8Array([0x08, 0x08, 0x08, 0x08, 0x08])); // 5x BS
    expect(r.cursorCol).toBe(0);
    // BS at column 0 does NOT wrap to the previous row (v1 scope note in
    // the renderer's docblock).
    expect(r.cursorRow).toBe(0);
  });

  it("DEL (0x7f) is treated as a backspace", () => {
    let r = feed(emptyPromptLine, bytes("abc"));
    r = feed(r, new Uint8Array([0x7f]));
    expect(r.cursorCol).toBe(2);
    expect(rowTexts(r)).toEqual(["abc"]);
  });

  it("BEL is ignored", () => {
    const r = feed(emptyPromptLine, new Uint8Array([0x07, 0x07, 0x07]));
    expect(rowTexts(r)).toEqual([""]);
    expect(r.cursorCol).toBe(0);
  });
});

// ── M12.3: multi-row semantics ────────────────────────────────────────

describe("promptRenderer / LF appends a new row (M12.3 multi-line)", () => {
  it("LF appends a fresh row and moves cursor to column 0 of it", () => {
    let r = feed(emptyPromptLine, bytes("first"));
    r = feed(r, new Uint8Array([0x0a])); // LF
    expect(rowTexts(r)).toEqual(["first", ""]);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(0);
  });

  it("typing after LF fills the new row without touching the previous one", () => {
    let r = feed(emptyPromptLine, bytes('echo "hello'));
    r = feed(r, new Uint8Array([0x0a])); // Enter → shell drops to PS2
    r = feed(r, bytes("world"));
    expect(rowTexts(r)).toEqual(['echo "hello', "world"]);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(5);
  });

  it("multiple LFs stack rows deep", () => {
    let r = feed(emptyPromptLine, bytes("a"));
    r = feed(r, new Uint8Array([0x0a])); // LF
    r = feed(r, bytes("b"));
    r = feed(r, new Uint8Array([0x0a])); // LF
    r = feed(r, bytes("c"));
    expect(rowTexts(r)).toEqual(["a", "b", "c"]);
    expect(r.cursorRow).toBe(2);
    expect(r.cursorCol).toBe(1);
  });

  it("LF preserves SGR state so a styled run continues on the next row", () => {
    // Enter dim run, write on row 0, LF (dim still active), write on
    // row 1. The dim run must carry across the newline.
    let r = feed(emptyPromptLine, bytes("\x1b[90mfirst"));
    r = feed(r, new Uint8Array([0x0a])); // LF while dim is active
    r = feed(r, bytes("second\x1b[39m"));
    expect(rowTexts(r)).toEqual(["first", "second"]);
    expect(r.rows[0]?.styled).toEqual([true, true, true, true, true]);
    expect(r.rows[1]?.styled).toEqual([true, true, true, true, true, true]);
  });

  it("cursor motion (BS / CR / CSI D) stays within the current row after an LF", () => {
    let r = feed(emptyPromptLine, bytes("first"));
    r = feed(r, new Uint8Array([0x0a])); // LF → new row
    r = feed(r, bytes("second"));
    r = feed(r, new Uint8Array([0x08, 0x08, 0x08])); // BS x3 — stays in row 1
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(3);
    r = feed(r, bytes("\r")); // CR → col 0 of the CURRENT row
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(0);
  });
});

// ── M12.3 fix: multi-row cursor motions + LF-reuse + erase-display ──

describe("promptRenderer / multi-row cursor motions", () => {
  it("CSI A moves the cursor up N rows (clamped to 0)", () => {
    let r = feed(emptyPromptLine, bytes("one"));
    r = feed(r, new Uint8Array([0x0a])); // LF → append row 1
    r = feed(r, bytes("two"));
    r = feed(r, new Uint8Array([0x0a])); // LF → append row 2
    r = feed(r, bytes("three"));
    expect(r.cursorRow).toBe(2);
    r = feed(r, bytes("\x1b[2A"));
    expect(r.cursorRow).toBe(0);
    r = feed(r, bytes("\x1b[9A"));
    expect(r.cursorRow).toBe(0);
  });

  it("CSI B moves the cursor down N rows (clamped to last existing row)", () => {
    let r = feed(emptyPromptLine, bytes("one"));
    r = feed(r, new Uint8Array([0x0a]));
    r = feed(r, bytes("two"));
    r = feed(r, new Uint8Array([0x0a]));
    r = feed(r, bytes("three"));
    r = feed(r, bytes("\x1b[2A")); // up 2 → row 0
    r = feed(r, bytes("\x1b[1B")); // down 1 → row 1
    expect(r.cursorRow).toBe(1);
    r = feed(r, bytes("\x1b[9B")); // clamp
    expect(r.cursorRow).toBe(2);
  });

  it("LF advances into an existing row instead of appending a new one", () => {
    // Build a 3-row buffer, cursor at end of last row.
    let r = feed(emptyPromptLine, bytes("one\ntwo\nthree"));
    expect(r.rows).toHaveLength(3);
    // Go back to row 0.
    r = feed(r, bytes("\x1b[2A\r"));
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(0);
    // Overwrite row 0.
    r = feed(r, bytes("ONE"));
    // LF should advance to the existing row 1, NOT append row 3.
    r = feed(r, new Uint8Array([0x0a]));
    expect(r.rows).toHaveLength(3);
    expect(r.cursorRow).toBe(1);
    expect(rowTexts(r)).toEqual(["ONE", "two", "three"]);
  });

  it("LF at the last row still appends a new empty row (single-line-shell backward compat)", () => {
    let r = feed(emptyPromptLine, bytes("hello"));
    expect(r.rows).toHaveLength(1);
    r = feed(r, new Uint8Array([0x0a]));
    expect(r.rows).toHaveLength(2);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(0);
  });
});

describe("promptRenderer / CSI J erase display (M12.3 redraw handling)", () => {
  it("CSI J default (0) truncates current row from cursor and deletes rows below", () => {
    let r = feed(emptyPromptLine, bytes("one\ntwo\nthree"));
    // Move to (row 1, col 1) — middle of "two".
    r = feed(r, bytes("\x1b[1A")); // up 1 → row 1
    r = feed(r, bytes("\x1b[2G")); // absolute col 2 (1-indexed → col 1)
    r = feed(r, bytes("\x1b[J"));
    expect(rowTexts(r)).toEqual(["one", "t"]);
  });

  it("CSI 2 J collapses to a single empty row", () => {
    let r = feed(emptyPromptLine, bytes("one\ntwo\nthree"));
    r = feed(r, bytes("\x1b[2J"));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.text).toBe("");
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(0);
  });

  it("CSI 1 J erases rows above cursor and replaces start-of-row-with-spaces", () => {
    let r = feed(emptyPromptLine, bytes("one\ntwo\nthree"));
    r = feed(r, bytes("\x1b[1A")); // row 1
    r = feed(r, bytes("\x1b[3G")); // col 2
    r = feed(r, bytes("\x1b[1J"));
    expect(r.rows[0]?.text).toBe("");
    expect(r.rows[1]?.text).toBe("  o");
    expect(r.rows[2]?.text).toBe("three");
  });

  it("CSI 3 J is a scrollback signal — the renderer leaves rows alone", () => {
    // The pane's VT parser handles the scrollback-cleared event at
    // the block-list level; the strip's row stack must not be touched
    // by a stray CSI 3 J in prompt bytes.
    let r = feed(emptyPromptLine, bytes("one\ntwo"));
    r = feed(r, bytes("\x1b[3J"));
    expect(rowTexts(r)).toEqual(["one", "two"]);
  });

  it("a full shell-style multi-line redraw lands in-place without accumulating rows", () => {
    // Simulate: shell built a 3-row buffer, then redrew it entirely
    // with slightly different content. The classic redraw dance:
    // \r + \e[NA (up to first line) + \e[J (erase) + rewrite.
    let r = feed(emptyPromptLine, bytes("aaa\nbbb\nccc"));
    expect(r.rows).toHaveLength(3);
    // Redraw sequence — cursor is at (row 2, col 3).
    r = feed(r, bytes("\r"));
    r = feed(r, bytes("\x1b[2A"));
    r = feed(r, bytes("\x1b[J"));
    // Now cursor at (0, 0), rows collapsed to [""]
    expect(r.rows).toHaveLength(1);
    r = feed(r, bytes("ONE"));
    r = feed(r, bytes("\r\n"));
    r = feed(r, bytes("TWO"));
    r = feed(r, bytes("\r\n"));
    r = feed(r, bytes("THREE"));
    expect(r.rows).toHaveLength(3);
    expect(rowTexts(r)).toEqual(["ONE", "TWO", "THREE"]);
  });
});

describe("promptRenderer / CSI cursor moves", () => {
  it("CSI C moves the cursor forward N within the current row (clamped)", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, new Uint8Array([0x08, 0x08, 0x08])); // BS BS BS
    r = feed(r, bytes("\x1b[2C")); // forward 2
    expect(r.cursorCol).toBe(5);
    r = feed(r, bytes("\x1b[9C")); // forward past end → clamp
    expect(r.cursorCol).toBe(6);
  });

  it("CSI D moves the cursor backward N within the current row (clamped to 0)", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, bytes("\x1b[3D"));
    expect(r.cursorCol).toBe(3);
    r = feed(r, bytes("\x1b[9D"));
    expect(r.cursorCol).toBe(0);
  });

  it("CSI G sets the cursor to an absolute column of the current row (1-indexed)", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, bytes("\x1b[3G"));
    expect(r.cursorCol).toBe(2); // 1-indexed
  });
});

describe("promptRenderer / erase line", () => {
  it("CSI K (default) erases from cursor to end of the current row", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, bytes("\x1b[3D")); // cursor to col 3
    r = feed(r, bytes("\x1b[K"));
    expect(rowTexts(r)).toEqual(["abc"]);
  });

  it("CSI 1 K erases from start of the current row to cursor (replacing with spaces)", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, bytes("\x1b[3D"));
    r = feed(r, bytes("\x1b[1K"));
    expect(rowTexts(r)).toEqual(["   def"]);
  });

  it("CSI 2 K erases the entire current row, leaving the cursor in place", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, bytes("\x1b[3D"));
    r = feed(r, bytes("\x1b[2K"));
    expect(rowTexts(r)).toEqual([""]);
    expect(r.cursorCol).toBe(3);
  });
});

describe("promptRenderer / insert/delete", () => {
  it("CSI @ inserts N blanks at the cursor of the current row", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, bytes("\x1b[3D")); // cursor at 3
    r = feed(r, bytes("\x1b[2@"));
    expect(rowTexts(r)).toEqual(["abc  def"]);
    expect(r.cursorCol).toBe(3);
  });

  it("CSI P deletes N chars at the cursor of the current row", () => {
    let r = feed(emptyPromptLine, bytes("abcdef"));
    r = feed(r, bytes("\x1b[3D"));
    r = feed(r, bytes("\x1b[2P"));
    expect(rowTexts(r)).toEqual(["abcf"]);
    expect(r.cursorCol).toBe(3);
  });
});

describe("promptRenderer / OSC + partial CSI safety", () => {
  it("OSC is swallowed without leaving artifacts on the row", () => {
    const r = feed(emptyPromptLine, bytes("\x1b]0;title\x07visible"));
    expect(rowTexts(r)).toEqual(["visible"]);
  });

  it("partial CSI at end of buffer is dropped without corrupting state", () => {
    // ESC [ with no final byte — half-parsed. Renderer must NOT append
    // ESC or bracket as text.
    const r = feed(emptyPromptLine, bytes("hi\x1b[2"));
    expect(rowTexts(r)).toEqual(["hi"]);
    expect(r.cursorCol).toBe(2);
  });
});

describe("promptRenderer / styled foreground (autosuggestion heuristic)", () => {
  it("SGR 38;5;8 marks the styled flag on subsequent chars", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[38;5;8ma\x1b[0mb"));
    expect(rowTexts(r)).toEqual(["ab"]);
    expect(r.rows[0]?.styled).toEqual([true, false]);
  });

  it("SGR 39 resets the styled flag", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[38;5;8mab\x1b[39mcd"));
    expect(r.rows[0]?.styled).toEqual([true, true, false, false]);
  });

  it("dim greyscale-ramp palette indices (232-245) also mark styled", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[38;5;240mhi\x1b[39m"));
    expect(r.rows[0]?.styled).toEqual([true, true]);
  });

  it("brighter palette indices (e.g. 250, 255) do NOT mark styled", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[38;5;250mhi\x1b[39m"));
    expect(r.rows[0]?.styled).toEqual([false, false]);
  });

  it("SGR 90 (bright black / dark grey) marks styled — the 16-color form of fg=8", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[90mhint\x1b[39m"));
    expect(r.rows[0]?.styled).toEqual([true, true, true, true]);
  });

  it("other bright-palette colours (91-97) do NOT mark styled", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[91merr\x1b[39m"));
    expect(r.rows[0]?.styled).toEqual([false, false, false]);
  });

  it("attribute-only SGR (bold/italic) does not flip styled on its own", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[1mab\x1b[0m"));
    expect(r.rows[0]?.styled).toEqual([false, false]);
  });

  it("currentStyled state persists across feed calls", () => {
    let r = feed(emptyPromptLine, bytes("\x1b[38;5;8m"));
    expect(r.currentStyled).toBe(true);
    r = feed(r, bytes("more"));
    expect(r.rows[0]?.styled).toEqual([true, true, true, true]);
    r = feed(r, bytes("\x1b[39m"));
    expect(r.currentStyled).toBe(false);
  });
});

// ── M12.2: selection (SGR 7 / bg colour) ─────────────────────────────

describe("promptRenderer / selection via SGR 7", () => {
  it("empty state has no selection and currentSelected is false", () => {
    expect(emptyPromptLine.rows[0]?.selected).toEqual([]);
    expect(emptyPromptLine.currentSelected).toBe(false);
  });

  it("SGR 7 marks subsequent chars as selected", () => {
    const r = feed(emptyPromptLine, bytes("ab\x1b[7mcd\x1b[27mef"));
    expect(rowTexts(r)).toEqual(["abcdef"]);
    expect(r.rows[0]?.selected).toEqual([false, false, true, true, false, false]);
    expect(r.rows[0]?.styled).toEqual([false, false, false, false, false, false]);
  });

  it("SGR 27 clears the selection state", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[7mab\x1b[27mcd"));
    expect(r.rows[0]?.selected).toEqual([true, true, false, false]);
  });

  it("SGR 0 clears both styled and selected", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[7m\x1b[90mab\x1b[0mcd"));
    expect(r.rows[0]?.styled).toEqual([true, true, false, false]);
    expect(r.rows[0]?.selected).toEqual([true, true, false, false]);
  });

  it("currentSelected persists across feed calls", () => {
    let r = feed(emptyPromptLine, bytes("\x1b[7m"));
    expect(r.currentSelected).toBe(true);
    r = feed(r, bytes("ab"));
    expect(r.rows[0]?.selected).toEqual([true, true]);
    r = feed(r, bytes("\x1b[27m"));
    expect(r.currentSelected).toBe(false);
  });

  it("fg-colour spec params do not accidentally trip the selection bit", () => {
    // A 24-bit fg spec that HAPPENS to include a 7 in its parameter
    // stream. SGR 38 is fg, doesn't imply selection.
    const r = feed(emptyPromptLine, bytes("\x1b[38;2;7;7;7mx"));
    expect(r.rows[0]?.selected).toEqual([false]);
  });

  it("selection survives cursor motion and REPLACE writes preserve their own cell flags", () => {
    let r = feed(emptyPromptLine, bytes("\x1b[7mAB\x1b[27m"));
    expect(r.rows[0]?.selected).toEqual([true, true]);
    r = feed(r, new Uint8Array([0x08, 0x08])); // BS BS
    r = feed(r, bytes("xy"));
    expect(rowTexts(r)).toEqual(["xy"]);
    expect(r.rows[0]?.selected).toEqual([false, false]);
  });

  it("CSI K (default) truncates selection to match truncated text", () => {
    let r = feed(emptyPromptLine, bytes("\x1b[7mabcd\x1b[27m"));
    r = feed(r, new Uint8Array([0x08, 0x08])); // BS BS
    r = feed(r, bytes("\x1b[K"));
    expect(rowTexts(r)).toEqual(["ab"]);
    expect(r.rows[0]?.selected).toEqual([true, true]);
  });

  it("24-bit background colour marks selection — zsh-vi-mode's default paint", () => {
    // zsh-vi-mode's default visual highlight sets `bg=#cc0000`, which
    // zsh translates to `\e[48;2;204;0;0m`. That's a highlighted
    // region; the strip must render it.
    const r = feed(emptyPromptLine, bytes("\x1b[48;2;204;0;0mab\x1b[49mc"));
    expect(rowTexts(r)).toEqual(["abc"]);
    expect(r.rows[0]?.selected).toEqual([true, true, false]);
  });

  it("256-palette background colour marks selection", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[48;5;12mab\x1b[49mc"));
    expect(r.rows[0]?.selected).toEqual([true, true, false]);
  });

  it("standard palette background colours (40-47) mark selection", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[41mab\x1b[49mc"));
    expect(r.rows[0]?.selected).toEqual([true, true, false]);
  });

  it("bright palette background colours (100-107) mark selection", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[101mab\x1b[49mc"));
    expect(r.rows[0]?.selected).toEqual([true, true, false]);
  });

  it("SGR 49 (default bg) clears selection independently of SGR 27", () => {
    const r = feed(emptyPromptLine, bytes("\x1b[41mab\x1b[49mcd"));
    expect(r.rows[0]?.selected).toEqual([true, true, false, false]);
  });
});
