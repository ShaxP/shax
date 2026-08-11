/**
 * Tiny multi-row VT renderer for the M1.9 PromptStrip.
 *
 * The shell renders its current prompt line (PS1 + typing + history nav +
 * Tab completion + PS2 continuation) using a small set of VT escape
 * sequences. To mirror what the shell is drawing we need just enough of
 * a VT engine to apply those sequences to a stack of rows with a cursor
 * — full xterm.js would be overkill (every command's output would have
 * to run through it too) and would re-implement xterm's invariants we
 * don't need here.
 *
 * Scope:
 *  - N rows (M12.3 grew this from single-line). LF advances the cursor
 *    to a fresh row; the previous row stays put. Users composing
 *    multi-line commands (unclosed quotes, backslash continuation) see
 *    the whole composition, not just the current row.
 *  - REPLACE semantics for printable chars (xterm default).
 *  - Cursor: (row, col) position, 0 ≤ cursorCol ≤ rows[cursorRow].text.length.
 *  - Per-character styling: we track whether each char arrived under a
 *    non-default foreground SGR. The PromptStrip renders those chars in
 *    a faint colour to distinguish hints (zsh-autosuggestions ghost text,
 *    syntax-highlighted command parts, etc.) from committed input.
 *  - Per-character selection: SGR 7 (reverse video) or any non-default
 *    background colour marks a char as part of the active region — vi
 *    visual mode + emacs mark-and-region both flow through this path.
 *    SGR 0 / 27 / 49 clear the selection state.
 *
 * Out of scope:
 *  - Multiple fg colour shades — we collapse "any non-default fg" to a
 *    single "styled" boolean. Good enough for the autosuggestion case
 *    and any other dim/grey hint; full SGR rendering lands with M4's
 *    formatter system.
 *  - Cursor motions that CROSS rows. CSI cursor moves (C / D / G / H)
 *    stay within the current row. BS at column 0 stays at column 0
 *    rather than wrapping to the previous row's end — the strip mirrors
 *    what the shell echoes, and the shell won't ask us to wrap.
 *  - Scrolling, alternate screen, arbitrary DECPAM.
 *
 * This module is pure: feed(state, bytes) returns the new state. The
 * consumer (blockReducer) resets to `emptyPromptLine` whenever a new
 * command starts (OSC 133 C fires) so cross-prompt state can't leak.
 */

/** One row of the mirrored prompt buffer. */
export interface PromptRow {
  /** The visible text of this row. */
  text: string;
  /**
   * Per-character "styled" flag — same length as `text`. `true` means the
   * char arrived under a non-default foreground SGR; the strip renders
   * these in a faint colour. `false` means default foreground.
   */
  styled: boolean[];
  /**
   * Per-character "selected" flag — same length as `text`. `true` means
   * the char arrived under SGR 7 (reverse video) or any non-default
   * background colour, which zsh / bash-readline / zsh-vi-mode use to
   * paint the mark/region during vi visual mode and emacs
   * mark-and-region. The strip renders these cells with an accent
   * background.
   */
  selected: boolean[];
}

export interface PromptLine {
  /** All rows in the current prompt composition. Always ≥ 1 row. */
  rows: PromptRow[];
  /** 0-based row the cursor is currently on. `0 ≤ cursorRow < rows.length`. */
  cursorRow: number;
  /** 0-based column within `rows[cursorRow].text`. May equal `text.length` (at end). */
  cursorCol: number;
  /**
   * Persistent SGR state across feeds: `true` while a non-default fg is
   * active (between `ESC[..m` setting fg and the matching reset `ESC[0m`
   * or `ESC[39m`). New characters inherit this value.
   */
  currentStyled: boolean;
  /**
   * Persistent SGR state across feeds: `true` while SGR 7 (reverse
   * video) is active OR a non-default background is set. New characters
   * inherit this value. Cleared by SGR 0 / 27 / 49.
   */
  currentSelected: boolean;
}

const EMPTY_ROW: PromptRow = { text: "", styled: [], selected: [] };

export const emptyPromptLine: PromptLine = {
  rows: [EMPTY_ROW],
  cursorRow: 0,
  cursorCol: 0,
  currentStyled: false,
  currentSelected: false,
};

const ESC = 0x1b;
const CSI_INTRODUCER = 0x5b; // '['
const OSC_INTRODUCER = 0x5d; // ']'
const BEL = 0x07;
const BS = 0x08;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const DEL = 0x7f;
const ST = 0x9c;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Feed a chunk of bytes into the renderer. The byte stream is the same
 * shape the shell emits to a terminal: printable bytes, control codes,
 * CSI escape sequences, OSC escape sequences. Anything we don't recognise
 * is consumed silently — partial unknown sequences are dropped to keep
 * the renderer from getting stuck in a half-parsed state.
 */
export function feed(state: PromptLine, bytes: Uint8Array): PromptLine {
  let line: PromptLine = state;

  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === undefined) break;

    if (b === ESC) {
      const next = bytes[i + 1];
      if (next === CSI_INTRODUCER) {
        // CSI sequence: ESC [ <params> <final>
        let j = i + 2;
        while (j < bytes.length) {
          const c = bytes[j];
          if (c === undefined || c < 0x20 || c >= 0x40) break;
          j++;
        }
        const final = bytes[j];
        if (final === undefined) {
          // Incomplete CSI — drop the partial bytes.
          break;
        }
        const params = new TextDecoder("ascii").decode(bytes.subarray(i + 2, j));
        line = applyCsi(line, params, final);
        i = j + 1;
        continue;
      }
      if (next === OSC_INTRODUCER) {
        // OSC sequence: consume to its terminator and ignore.
        let j = i + 2;
        while (j < bytes.length && bytes[j] !== BEL && bytes[j] !== ST) j++;
        i = j < bytes.length ? j + 1 : bytes.length;
        continue;
      }
      if (next === undefined) break;
      // Other two-byte escapes — skip.
      i += 2;
      continue;
    }

    if (b === BEL) {
      i++;
      continue;
    }
    if (b === BS || b === DEL) {
      if (line.cursorCol > 0) line = { ...line, cursorCol: line.cursorCol - 1 };
      i++;
      continue;
    }
    if (b === TAB) {
      // A bare TAB is rare here — shells expand tabs locally and we get
      // the expanded chars instead. Treat as a single space.
      line = writeOver(line, " ");
      i++;
      continue;
    }
    if (b === CR) {
      line = { ...line, cursorCol: 0 };
      i++;
      continue;
    }
    if (b === LF) {
      // Multi-row renderer: LF appends a fresh row and moves the cursor
      // to column 0 of that row. Previous rows stay put. The SGR state
      // (styled / selected) carries over so a run spanning the newline
      // continues to inherit its attribute.
      line = {
        ...line,
        rows: [...line.rows, EMPTY_ROW],
        cursorRow: line.rows.length,
        cursorCol: 0,
      };
      i++;
      continue;
    }
    if (b < 0x20) {
      // Other C0 control bytes (SO, SI, …) — ignore.
      i++;
      continue;
    }

    // Printable run (and any UTF-8 continuation bytes, which are ≥ 0x80).
    let j = i;
    while (j < bytes.length) {
      const c = bytes[j];
      if (c === undefined) break;
      if (c === ESC || c === BS || c === CR || c === LF || c === DEL || c === BEL || c < 0x20) {
        break;
      }
      j++;
    }
    const segment = TEXT_DECODER.decode(bytes.subarray(i, j));
    line = writeOver(line, segment);
    i = j;
  }

  return line;
}

/** Replace the row at `cursorRow` with a new one, leaving other rows
 *  untouched. Returns a new PromptLine — never mutates. */
function withCurrentRow(state: PromptLine, row: PromptRow): PromptLine {
  const rows = state.rows.slice();
  rows[state.cursorRow] = row;
  return { ...state, rows };
}

/**
 * Write `segment` at the cursor on the current row, replacing any
 * characters that previously sat at those positions. Extends the row
 * if the segment runs past the end. Records each new char's styled +
 * selected flags from the current SGR state.
 */
function writeOver(state: PromptLine, segment: string): PromptLine {
  const currentRow = state.rows[state.cursorRow] ?? EMPTY_ROW;
  const { text, styled, selected } = currentRow;
  const { cursorCol, currentStyled, currentSelected } = state;
  const segLen = segment.length;
  const segStyled = new Array<boolean>(segLen).fill(currentStyled);
  const segSelected = new Array<boolean>(segLen).fill(currentSelected);
  let nextRow: PromptRow;
  if (cursorCol === text.length) {
    nextRow = {
      text: text + segment,
      styled: [...styled, ...segStyled],
      selected: [...selected, ...segSelected],
    };
  } else {
    const headText = text.slice(0, cursorCol);
    const tailText = text.slice(cursorCol + segLen);
    const headStyled = styled.slice(0, cursorCol);
    const tailStyled = styled.slice(cursorCol + segLen);
    const headSelected = selected.slice(0, cursorCol);
    const tailSelected = selected.slice(cursorCol + segLen);
    nextRow = {
      text: headText + segment + tailText,
      styled: [...headStyled, ...segStyled, ...tailStyled],
      selected: [...headSelected, ...segSelected, ...tailSelected],
    };
  }
  return { ...withCurrentRow(state, nextRow), cursorCol: cursorCol + segLen };
}

function applyCsi(state: PromptLine, params: string, final: number): PromptLine {
  const args = params === "" ? [] : params.split(";").map((s) => parseInt(s, 10) || 0);
  const n = args[0] ?? 0;
  const currentRow = state.rows[state.cursorRow] ?? EMPTY_ROW;

  switch (final) {
    case 0x40: {
      // '@' — insert N blank characters at cursor.
      const count = Math.max(1, n);
      const blanks = " ".repeat(count);
      const blanksStyled = new Array<boolean>(count).fill(state.currentStyled);
      const blanksSelected = new Array<boolean>(count).fill(state.currentSelected);
      const nextRow: PromptRow = {
        text:
          currentRow.text.slice(0, state.cursorCol) +
          blanks +
          currentRow.text.slice(state.cursorCol),
        styled: [
          ...currentRow.styled.slice(0, state.cursorCol),
          ...blanksStyled,
          ...currentRow.styled.slice(state.cursorCol),
        ],
        selected: [
          ...currentRow.selected.slice(0, state.cursorCol),
          ...blanksSelected,
          ...currentRow.selected.slice(state.cursorCol),
        ],
      };
      return withCurrentRow(state, nextRow);
    }
    case 0x43: {
      // 'C' — cursor forward N (within the current row).
      const count = Math.max(1, n);
      return { ...state, cursorCol: Math.min(currentRow.text.length, state.cursorCol + count) };
    }
    case 0x44: {
      // 'D' — cursor backward N (within the current row).
      const count = Math.max(1, n);
      return { ...state, cursorCol: Math.max(0, state.cursorCol - count) };
    }
    case 0x47: {
      // 'G' — cursor horizontal absolute, 1-indexed. Stays on current row.
      const col = Math.max(0, (n || 1) - 1);
      return { ...state, cursorCol: col };
    }
    case 0x48: {
      // 'H' / 'f' — CUP. Row ignored — the strip's rows are ours to
      // arrange; the shell's row addressing doesn't map to our row
      // stack. Only the column applies.
      const col = Math.max(0, (args[1] ?? 1) - 1);
      return { ...state, cursorCol: col };
    }
    case 0x4b: {
      // 'K' — erase in line (current row).
      if (n === 1) {
        // From start to cursor (inclusive): replace with spaces.
        const blanks = " ".repeat(state.cursorCol);
        const blanksStyled = new Array<boolean>(state.cursorCol).fill(false);
        const blanksSelected = new Array<boolean>(state.cursorCol).fill(false);
        const nextRow: PromptRow = {
          text: blanks + currentRow.text.slice(state.cursorCol),
          styled: [...blanksStyled, ...currentRow.styled.slice(state.cursorCol)],
          selected: [...blanksSelected, ...currentRow.selected.slice(state.cursorCol)],
        };
        return withCurrentRow(state, nextRow);
      }
      if (n === 2) {
        return withCurrentRow(state, EMPTY_ROW);
      }
      // 0 (default): from cursor to end.
      const nextRow: PromptRow = {
        text: currentRow.text.slice(0, state.cursorCol),
        styled: currentRow.styled.slice(0, state.cursorCol),
        selected: currentRow.selected.slice(0, state.cursorCol),
      };
      return withCurrentRow(state, nextRow);
    }
    case 0x50: {
      // 'P' — delete N characters at cursor.
      const count = Math.max(1, n);
      const nextRow: PromptRow = {
        text:
          currentRow.text.slice(0, state.cursorCol) +
          currentRow.text.slice(state.cursorCol + count),
        styled: [
          ...currentRow.styled.slice(0, state.cursorCol),
          ...currentRow.styled.slice(state.cursorCol + count),
        ],
        selected: [
          ...currentRow.selected.slice(0, state.cursorCol),
          ...currentRow.selected.slice(state.cursorCol + count),
        ],
      };
      return withCurrentRow(state, nextRow);
    }
    case 0x6d: {
      // 'm' — SGR. Track foreground-style + reverse/bg state so
      // subsequent writes inherit both. Empty SGR is equivalent to
      // SGR 0 (reset all).
      return {
        ...state,
        currentStyled: applySgr(state.currentStyled, args),
        currentSelected: applySgrSelected(state.currentSelected, args),
      };
    }
    // 'J' (erase display) and other unhandled finals: consume and continue.
    default:
      return state;
  }
}

/**
 * Parse a sequence of SGR parameters and return the new "is dim/hint
 * foreground" flag.
 *
 * We deliberately narrow the detection to *dim* foreground colours so
 * that real syntax highlighting (green for valid commands, red for
 * errors, etc. — every common zsh-syntax-highlighting palette entry)
 * does not get dimmed alongside the autosuggestion ghost text. The
 * autosuggestion case uses palette 8 by default and is the primary hint
 * we want the user to recognise visually.
 *
 *   SGR 0 / 39      → reset → styled = false
 *   SGR 2           → dim attribute → styled = true
 *   SGR 38;5;N      → styled iff N is a grey/dark index (8, 7, 232-245)
 *   SGR 38;2;R;G;B  → styled iff RGB is dark-grey-ish
 *   Anything else   → styled = false (syntax-highlighting colours, bold,
 *                     italic, bg colours, …)
 *
 * The check is intentionally narrow — false negatives (a user with a
 * custom autosuggestion colour outside this set) just see normal text;
 * false positives would re-introduce the bug where commands appear
 * faint, which is more disorienting.
 */
function applySgr(currentStyled: boolean, args: number[]): boolean {
  if (args.length === 0) return false;
  let styled = currentStyled;
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? 0;
    if (a === 0 || a === 39) {
      styled = false;
      i++;
    } else if (a === 2) {
      // SGR 2 = dim attribute (standard CSI).
      styled = true;
      i++;
    } else if (a === 38) {
      const mode = args[i + 1];
      if (mode === 5) {
        const n = args[i + 2] ?? -1;
        // Greyscale-like palette indices: standard light/dark grey + the
        // 24-step greyscale ramp at 232..255. Cap at 245 so almost-white
        // grey doesn't get caught (those are bright enough to be content).
        styled = n === 7 || n === 8 || (n >= 232 && n <= 245);
        i += 3;
      } else if (mode === 2) {
        const r = args[i + 2] ?? 0;
        const g = args[i + 3] ?? 0;
        const b = args[i + 4] ?? 0;
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        // Dark and roughly-grey: low brightness, channels close together.
        styled = maxC < 160 && maxC - minC < 32;
        i += 5;
      } else {
        styled = false;
        i++;
      }
    } else if (a === 48) {
      // Background colour spec — same skip pattern, doesn't affect fg.
      const mode = args[i + 1];
      if (mode === 5) i += 3;
      else if (mode === 2) i += 5;
      else i += 1;
    } else if (a === 90) {
      // SGR 90 = bright black = the standard "dark grey" channel many
      // terminals use when the user / theme sets `fg=8`. This is the
      // most common autosuggestion colour on terminals that don't
      // expose the 256-palette form (`\e[38;5;8m`), so we treat it as
      // a hint.
      styled = true;
      i++;
    } else if ((a >= 30 && a <= 37) || (a >= 91 && a <= 97)) {
      // Standard / bright palette fg (red, green, blue, cyan, …).
      // These are syntax-highlighting colours; do not dim them.
      styled = false;
      i++;
    } else {
      i++;
    }
  }
  return styled;
}

/**
 * Parse a sequence of SGR parameters and return the new "this cell is
 * part of a highlighted region" flag (M12.2 selection support).
 *
 * Two ways a shell paints a highlighted region:
 *
 *   1. SGR 7 (reverse video). What bash-readline's active-region-*
 *      defaults to and what zsh's `region_highlight standout` produces.
 *   2. A non-default background colour. What `zsh-vi-mode` uses by
 *      default (`bg=#cc0000` → `\e[48;2;204;0;0m`), and what
 *      `region_highlight bg=…` produces in general.
 *
 * We treat both as selection because in assertive mode the shell's own
 * prompt / theme / syntax-highlighter has been silenced, so the only
 * remaining sources of bg colour in the strip's byte stream are the
 * mark/region highlights. False-positive risk is minimal in practice.
 *
 * Handled tokens:
 *
 *   SGR 0            → reset all → selected = false
 *   SGR 7            → reverse video on → selected = true
 *   SGR 27           → reverse video off → selected = false
 *   SGR 40-47        → standard palette bg → selected = true
 *   SGR 49           → default bg → selected = false
 *   SGR 100-107      → bright palette bg → selected = true
 *   SGR 48;5;N       → 256-palette bg → selected = true
 *   SGR 48;2;R;G;B   → 24-bit bg → selected = true
 *   SGR 38           → foreground colour spec — skipped
 *
 * Keeping this separate from the dim-heuristic `applySgr` means each
 * pass has one job and the existing autosuggestion detection stays
 * untouched.
 */
function applySgrSelected(currentSelected: boolean, args: number[]): boolean {
  if (args.length === 0) return false;
  let selected = currentSelected;
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? 0;
    if (a === 0 || a === 49 || a === 27) {
      // SGR 0 (reset all), SGR 27 (no reverse), SGR 49 (default bg) —
      // all three signal "this cell is not part of a highlight anymore".
      selected = false;
      i++;
    } else if (a === 7) {
      selected = true;
      i++;
    } else if ((a >= 40 && a <= 47) || (a >= 100 && a <= 107)) {
      // Standard / bright palette bg — non-default bg means the shell
      // painted a highlight.
      selected = true;
      i++;
    } else if (a === 48) {
      // Extended bg colour spec (256-palette or 24-bit RGB). Both count
      // as highlight. Skip past the mode + trailing parameters so we
      // don't misread them as SGR opcodes.
      const mode = args[i + 1];
      if (mode === 5) {
        selected = true;
        i += 3;
      } else if (mode === 2) {
        selected = true;
        i += 5;
      } else {
        i += 1;
      }
    } else if (a === 38) {
      // Foreground colour spec — skip mode + trailing parameters.
      // Doesn't affect selection. Mirrors the skip pattern in applySgr.
      const mode = args[i + 1];
      if (mode === 5) i += 3;
      else if (mode === 2) i += 5;
      else i += 1;
    } else {
      i++;
    }
  }
  return selected;
}
