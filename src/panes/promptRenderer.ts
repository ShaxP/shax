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
 *  - Single line. LF clears the line and resets the cursor (mid-stream
 *    newlines are treated as "the shell is now starting a fresh prompt"
 *    rather than scrolling).
 *  - REPLACE semantics for printable chars (xterm default). Insert mode
 *    is rare in modern shells; when it's needed, readline emits the
 *    explicit insert/delete CSI sequences (which we honour).
 *  - Cursor: position within the line, 0 ≤ cursor ≤ text.length.
 *
 * Out of scope:
 *  - Colour and other SGR attributes: the CSI is consumed but the text
 *    stays uncoloured. M4 brings real formatters for rich rendering.
 *  - Scrolling, alternate screen, multi-line edits.
 *  - Mid-stream UTF-8 split across two feed() calls (the splitter currently
 *    decodes per call; a continuation byte at a boundary would render as
 *    its replacement char until the rest arrives).
 *
 * This module is pure: feed(state, bytes) returns the new state. The state
 * lives in the blockReducer so React diffs cleanly and the renderer can be
 * unit-tested without a DOM.
 */

export interface PromptLine {
  /** The visible text of the current prompt line. */
  text: string;
  /** 0-based column where the cursor is. May equal text.length (at end). */
  cursor: number;
}

export const emptyPromptLine: PromptLine = { text: "", cursor: 0 };

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
  let text = state.text;
  let cursor = state.cursor;

  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    // noUncheckedIndexedAccess: i < bytes.length guarantees b !== undefined,
    // but TypeScript can't infer that. Guard once so the rest of the loop
    // can compare b against numeric constants without further narrowing.
    if (b === undefined) break;

    if (b === ESC) {
      // Two-byte and longer escape sequences.
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
          // Incomplete CSI — drop the partial bytes; the next feed
          // should arrive with a fresh sequence.
          break;
        }
        const params = new TextDecoder("ascii").decode(bytes.subarray(i + 2, j));
        ({ text, cursor } = applyCsi(text, cursor, params, final));
        i = j + 1;
        continue;
      }
      if (next === OSC_INTRODUCER) {
        // OSC sequence: ESC ] ... (BEL | ST). OSC 133 is consumed by the
        // backend's VT parser; anything that reaches us here is a non-133
        // OSC (window title etc.) we can safely ignore.
        let j = i + 2;
        while (j < bytes.length && bytes[j] !== BEL && bytes[j] !== ST) {
          j++;
        }
        i = j < bytes.length ? j + 1 : bytes.length;
        continue;
      }
      if (next === undefined) {
        // Incomplete ESC at end of chunk — drop.
        break;
      }
      // Other two-byte escapes (charset selects, single shift, etc.) — skip.
      i += 2;
      continue;
    }

    if (b === BEL) {
      i++;
      continue;
    }
    if (b === BS || b === DEL) {
      if (cursor > 0) cursor--;
      i++;
      continue;
    }
    if (b === TAB) {
      // Most shells expand tabs locally; the bytes that reach us are the
      // expanded chars (the resulting completion). A bare TAB is rare here
      // — treat it as a single space.
      ({ text, cursor } = writeOver(text, cursor, " "));
      i++;
      continue;
    }
    if (b === CR) {
      cursor = 0;
      i++;
      continue;
    }
    if (b === LF) {
      // Single-line renderer: a newline means the shell is moving past the
      // current line. Treat it as "start fresh" — clear text and reset.
      text = "";
      cursor = 0;
      i++;
      continue;
    }
    if (b < 0x20) {
      // Other C0 control bytes (SO, SI, etc.) — ignore.
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
    ({ text, cursor } = writeOver(text, cursor, segment));
    i = j;
  }

  return { text, cursor };
}

/**
 * Write `segment` at `cursor`, replacing any characters that previously sat
 * at those positions. Extends `text` if the segment runs past the end.
 * Always advances the cursor by `segment.length`.
 */
function writeOver(text: string, cursor: number, segment: string): PromptLine {
  if (cursor === text.length) {
    return { text: text + segment, cursor: cursor + segment.length };
  }
  const head = text.slice(0, cursor);
  const tail = text.slice(cursor + segment.length);
  return { text: head + segment + tail, cursor: cursor + segment.length };
}

function applyCsi(text: string, cursor: number, params: string, final: number): PromptLine {
  // Parameters are semicolon-separated; an empty parameter defaults to 0
  // per the VT spec. Numerical conversion uses parseInt; non-numeric falls
  // back to 0 (the shell never emits non-numeric params in our cases).
  const args = params === "" ? [] : params.split(";").map((s) => parseInt(s, 10) || 0);
  const n = args[0] ?? 0;

  switch (final) {
    case 0x40: {
      // '@' — insert N blank characters at cursor (pushing tail right).
      const count = Math.max(1, n);
      const head = text.slice(0, cursor);
      const tail = text.slice(cursor);
      return { text: head + " ".repeat(count) + tail, cursor };
    }
    case 0x43: {
      // 'C' — cursor forward N (clamped to text length).
      const count = Math.max(1, n);
      return { text, cursor: Math.min(text.length, cursor + count) };
    }
    case 0x44: {
      // 'D' — cursor backward N (clamped to 0).
      const count = Math.max(1, n);
      return { text, cursor: Math.max(0, cursor - count) };
    }
    case 0x47: {
      // 'G' — cursor horizontal absolute, 1-indexed (CHA).
      const col = Math.max(0, (n || 1) - 1);
      return { text, cursor: col };
    }
    case 0x48: {
      // 'H' / 'f' — CUP (cursor position). Row is ignored in single-line.
      const col = Math.max(0, (args[1] ?? 1) - 1);
      return { text, cursor: col };
    }
    case 0x4b: {
      // 'K' — erase in line:
      //   0 (default): from cursor to end
      //   1          : from start to cursor (inclusive)
      //   2          : entire line
      if (n === 1) {
        return { text: " ".repeat(cursor) + text.slice(cursor), cursor };
      }
      if (n === 2) {
        return { text: "", cursor };
      }
      return { text: text.slice(0, cursor), cursor };
    }
    case 0x50: {
      // 'P' — delete N characters at cursor (DCH).
      const count = Math.max(1, n);
      return { text: text.slice(0, cursor) + text.slice(cursor + count), cursor };
    }
    // 'm' (SGR), 'J' (erase display), and the rest: consume and continue.
    default:
      return { text, cursor };
  }
}
