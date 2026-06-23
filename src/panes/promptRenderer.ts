/**
 * Tiny single-line VT renderer for the M1.9 PromptStrip.
 *
 * The shell renders its current prompt line (PS1 + typing + history nav +
 * Tab completion) using a small set of VT escape sequences. To mirror what
 * the shell is drawing we need just enough of a VT engine to apply those
 * sequences to a one-line buffer with a cursor — full xterm.js would be
 * overkill (every command's output would have to run through it too) and
 * would re-implement xterm's invariants we don't need here.
 *
 * Scope:
 *  - Single line. LF clears the line and resets the cursor.
 *  - REPLACE semantics for printable chars (xterm default).
 *  - Cursor: position within the line, 0 ≤ cursor ≤ text.length.
 *  - Per-character styling: we track whether each char arrived under a
 *    non-default foreground SGR. The PromptStrip renders those chars in
 *    a faint colour to distinguish hints (zsh-autosuggestions ghost text,
 *    syntax-highlighted command parts, etc.) from committed input.
 *
 * Out of scope:
 *  - Multiple fg colour shades — we collapse "any non-default fg" to a
 *    single "styled" boolean. Good enough for the autosuggestion case
 *    and any other dim/grey hint; full SGR rendering lands with M4's
 *    formatter system.
 *  - Scrolling, alternate screen, multi-line edits.
 *
 * This module is pure: feed(state, bytes) returns the new state.
 */

export interface PromptLine {
  /** The visible text of the current prompt line. */
  text: string;
  /**
   * Per-character "styled" flag — same length as `text`. `true` means the
   * char arrived under a non-default foreground SGR; the strip renders
   * these in a faint colour. Empty (and `false` entries) means default
   * foreground.
   */
  styled: boolean[];
  /** 0-based column where the cursor is. May equal text.length (at end). */
  cursor: number;
  /**
   * Persistent SGR state across feeds: `true` while a non-default fg is
   * active (between `ESC[..m` setting fg and the matching reset `ESC[0m`
   * or `ESC[39m`). New characters inherit this value.
   */
  currentStyled: boolean;
}

export const emptyPromptLine: PromptLine = {
  text: "",
  styled: [],
  cursor: 0,
  currentStyled: false,
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
      if (line.cursor > 0) line = { ...line, cursor: line.cursor - 1 };
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
      line = { ...line, cursor: 0 };
      i++;
      continue;
    }
    if (b === LF) {
      // Single-line renderer: a newline means the shell is moving past
      // the current line. Treat it as "start fresh" — clear everything
      // except the SGR state (so a styled fg in progress carries over).
      line = { ...line, text: "", styled: [], cursor: 0 };
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

/**
 * Write `segment` at the cursor, replacing any characters that previously
 * sat at those positions. Extends `text` if the segment runs past the end.
 * Records each new char's styled flag from the current SGR state.
 */
function writeOver(state: PromptLine, segment: string): PromptLine {
  const { text, styled, cursor, currentStyled } = state;
  const segLen = segment.length;
  const segStyled = new Array<boolean>(segLen).fill(currentStyled);
  if (cursor === text.length) {
    return {
      ...state,
      text: text + segment,
      styled: [...styled, ...segStyled],
      cursor: cursor + segLen,
    };
  }
  const headText = text.slice(0, cursor);
  const tailText = text.slice(cursor + segLen);
  const headStyled = styled.slice(0, cursor);
  const tailStyled = styled.slice(cursor + segLen);
  return {
    ...state,
    text: headText + segment + tailText,
    styled: [...headStyled, ...segStyled, ...tailStyled],
    cursor: cursor + segLen,
  };
}

function applyCsi(state: PromptLine, params: string, final: number): PromptLine {
  const args = params === "" ? [] : params.split(";").map((s) => parseInt(s, 10) || 0);
  const n = args[0] ?? 0;

  switch (final) {
    case 0x40: {
      // '@' — insert N blank characters at cursor.
      const count = Math.max(1, n);
      const blanks = " ".repeat(count);
      const blanksStyled = new Array<boolean>(count).fill(state.currentStyled);
      return {
        ...state,
        text: state.text.slice(0, state.cursor) + blanks + state.text.slice(state.cursor),
        styled: [
          ...state.styled.slice(0, state.cursor),
          ...blanksStyled,
          ...state.styled.slice(state.cursor),
        ],
      };
    }
    case 0x43: {
      // 'C' — cursor forward N.
      const count = Math.max(1, n);
      return { ...state, cursor: Math.min(state.text.length, state.cursor + count) };
    }
    case 0x44: {
      // 'D' — cursor backward N.
      const count = Math.max(1, n);
      return { ...state, cursor: Math.max(0, state.cursor - count) };
    }
    case 0x47: {
      // 'G' — cursor horizontal absolute, 1-indexed.
      const col = Math.max(0, (n || 1) - 1);
      return { ...state, cursor: col };
    }
    case 0x48: {
      // 'H' / 'f' — CUP. Row ignored in single-line.
      const col = Math.max(0, (args[1] ?? 1) - 1);
      return { ...state, cursor: col };
    }
    case 0x4b: {
      // 'K' — erase in line.
      if (n === 1) {
        // From start to cursor (inclusive): replace with spaces.
        const blanks = " ".repeat(state.cursor);
        const blanksStyled = new Array<boolean>(state.cursor).fill(false);
        return {
          ...state,
          text: blanks + state.text.slice(state.cursor),
          styled: [...blanksStyled, ...state.styled.slice(state.cursor)],
        };
      }
      if (n === 2) {
        return { ...state, text: "", styled: [] };
      }
      // 0 (default): from cursor to end.
      return {
        ...state,
        text: state.text.slice(0, state.cursor),
        styled: state.styled.slice(0, state.cursor),
      };
    }
    case 0x50: {
      // 'P' — delete N characters at cursor.
      const count = Math.max(1, n);
      return {
        ...state,
        text: state.text.slice(0, state.cursor) + state.text.slice(state.cursor + count),
        styled: [
          ...state.styled.slice(0, state.cursor),
          ...state.styled.slice(state.cursor + count),
        ],
      };
    }
    case 0x6d: {
      // 'm' — SGR. Track foreground-style state so subsequent writes
      // inherit it. Empty SGR is equivalent to SGR 0 (reset all).
      return { ...state, currentStyled: applySgr(state.currentStyled, args) };
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
    } else if ((a >= 30 && a <= 37) || (a >= 90 && a <= 97)) {
      // Standard / bright palette fg. These are the syntax-highlighting
      // colours we explicitly do *not* dim.
      styled = false;
      i++;
    } else {
      i++;
    }
  }
  return styled;
}
