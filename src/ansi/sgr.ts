/**
 * SGR parser (M4.5 slice 3).
 *
 * Walks a UTF-8 string with embedded ANSI escape sequences and
 * returns a flat list of styled spans — one per run of text
 * that shares the same active SGR attributes. Non-SGR CSI
 * sequences (cursor movement, mode changes) and OSC sequences
 * are consumed and dropped; only the plain-text runs between
 * them are emitted, so a stray `ESC [K` doesn't survive as
 * literal `[K`.
 *
 * Attribute state (fg / bg colour, bold / italic / underline /
 * dim / strikethrough / inverse) carries between spans until a
 * reset code changes it. Every SGR sub-parameter is honoured:
 *
 *   - 30–37 / 40–47   — 8-color palette (fg / bg).
 *   - 90–97 / 100–107 — 8-bright palette (fg / bg).
 *   - 38;5;n / 48;5;n — 256-color indexed.
 *   - 38;2;r;g;b / 48;2;r;g;b — 24-bit truecolor.
 *   - 39 / 49         — default fg / bg (drop the attribute).
 *   - 1 / 22          — bold on / off.
 *   - 2 / 22          — dim on / off (22 clears both).
 *   - 3 / 23          — italic on / off.
 *   - 4 / 24          — underline on / off.
 *   - 7 / 27          — inverse on / off.
 *   - 9 / 29          — strikethrough on / off.
 *   - 0 / (empty)     — reset all.
 *
 * Pure module. Returns spans; the renderer is responsible for
 * mapping palette colours to CSS.
 */

/** Named palette slots. The renderer maps these to CSS custom
 *  properties (`--ansi-red`, `--ansi-bright-green`, …) so a
 *  theme can override. */
export type PaletteColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "bright-black"
  | "bright-red"
  | "bright-green"
  | "bright-yellow"
  | "bright-blue"
  | "bright-magenta"
  | "bright-cyan"
  | "bright-white";

export type SgrColor =
  | { kind: "palette"; name: PaletteColor }
  | { kind: "indexed"; index: number }
  | { kind: "rgb"; r: number; g: number; b: number };

export interface SgrStyle {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  fg?: SgrColor;
  bg?: SgrColor;
}

export interface AnsiSpan {
  text: string;
  style: SgrStyle;
}

const PALETTE_ORDER: PaletteColor[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];
const BRIGHT_ORDER: PaletteColor[] = [
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
];

/** Fast pre-check so callers can skip the parse entirely on
 *  ANSI-free strings. */
export function hasSgr(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === 0x1b) return true;
  }
  return false;
}

/** Split `input` into styled spans. Empty spans (which happen
 *  when consecutive SGR sequences occur with no text between)
 *  are dropped. */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: SgrStyle = {};
  let buffer = "";
  const flush = (): void => {
    if (buffer.length === 0) return;
    spans.push({ text: buffer, style: { ...style } });
    buffer = "";
  };
  let i = 0;
  while (i < input.length) {
    const ch = input.charCodeAt(i);
    if (ch !== 0x1b) {
      buffer += input[i];
      i++;
      continue;
    }
    const next = input.charCodeAt(i + 1);
    if (next === 0x5b /* [ */) {
      // CSI: find the final byte (0x40..0x7e). Between the `[`
      // and the final are the parameter bytes.
      const paramStart = i + 2;
      let j = paramStart;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          break;
        }
        j++;
      }
      if (j >= input.length) {
        // Unterminated CSI — drop the ESC + `[` and stop.
        i = input.length;
        continue;
      }
      const final = input.charCodeAt(j);
      // Only SGR (`m`) affects the style; every other CSI code
      // (cursor movement `A/B/C/D`, erase `J/K`, etc.) is
      // consumed silently — we're not simulating a terminal
      // here, only turning bytes into spans.
      if (final === 0x6d /* m */) {
        flush();
        const params = parseParams(input.slice(paramStart, j));
        style = applySgr(style, params);
      }
      i = j + 1;
      continue;
    }
    if (next === 0x5d /* ] */) {
      // OSC: payload terminated by BEL (0x07) or ST (`ESC \`).
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c === 0x07) {
          j++;
          break;
        }
        if (c === 0x1b && input.charCodeAt(j + 1) === 0x5c) {
          j += 2;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    // Some other two-byte ESC (charset select, save/restore,
    // …). Drop ESC + the follow byte.
    i += 2;
  }
  flush();
  return spans;
}

/** Split a CSI parameter string on `;` and return the numeric
 *  values. Missing / empty parameters coerce to 0 (the SGR
 *  default). */
function parseParams(input: string): number[] {
  if (input.length === 0) return [0];
  const parts = input.split(";");
  const nums: number[] = [];
  for (const part of parts) {
    if (part.length === 0) {
      nums.push(0);
    } else {
      const n = Number.parseInt(part, 10);
      nums.push(Number.isFinite(n) ? n : 0);
    }
  }
  return nums;
}

/** Apply a run of SGR parameters to the current style. Returns
 *  a fresh style object; the previous one keeps its identity so
 *  a flushed span retains what was active when it was flushed. */
function applySgr(prev: SgrStyle, params: number[]): SgrStyle {
  const style: SgrStyle = { ...prev };
  let i = 0;
  while (i < params.length) {
    const p = params[i] ?? 0;
    switch (p) {
      case 0:
        // Full reset.
        for (const key of Object.keys(style) as (keyof SgrStyle)[]) {
          delete style[key];
        }
        break;
      case 1:
        style.bold = true;
        break;
      case 2:
        style.dim = true;
        break;
      case 3:
        style.italic = true;
        break;
      case 4:
        style.underline = true;
        break;
      case 7:
        style.inverse = true;
        break;
      case 9:
        style.strikethrough = true;
        break;
      case 22:
        delete style.bold;
        delete style.dim;
        break;
      case 23:
        delete style.italic;
        break;
      case 24:
        delete style.underline;
        break;
      case 27:
        delete style.inverse;
        break;
      case 29:
        delete style.strikethrough;
        break;
      case 39:
        delete style.fg;
        break;
      case 49:
        delete style.bg;
        break;
      case 38:
      case 48: {
        // Extended colour. The next parameter selects the mode:
        // 5 = 256-color, 2 = 24-bit truecolor. Anything else is
        // malformed and we skip the SGR run to avoid consuming
        // the next unrelated code as a colour value.
        const mode = params[i + 1];
        if (mode === 5) {
          const idx = params[i + 2];
          if (typeof idx === "number") {
            const color: SgrColor = paletteFromIndex(idx);
            if (p === 38) style.fg = color;
            else style.bg = color;
          }
          i += 2;
        } else if (mode === 2) {
          const r = params[i + 2] ?? 0;
          const g = params[i + 3] ?? 0;
          const b = params[i + 4] ?? 0;
          const color: SgrColor = {
            kind: "rgb",
            r: clamp255(r),
            g: clamp255(g),
            b: clamp255(b),
          };
          if (p === 38) style.fg = color;
          else style.bg = color;
          i += 4;
        }
        break;
      }
      default: {
        if (p >= 30 && p <= 37) {
          const name = PALETTE_ORDER[p - 30];
          if (name !== undefined) style.fg = { kind: "palette", name };
        } else if (p >= 90 && p <= 97) {
          const name = BRIGHT_ORDER[p - 90];
          if (name !== undefined) style.fg = { kind: "palette", name };
        } else if (p >= 40 && p <= 47) {
          const name = PALETTE_ORDER[p - 40];
          if (name !== undefined) style.bg = { kind: "palette", name };
        } else if (p >= 100 && p <= 107) {
          const name = BRIGHT_ORDER[p - 100];
          if (name !== undefined) style.bg = { kind: "palette", name };
        }
        // Everything else (font selects, framing, ideogram
        // attrs) is silently ignored.
      }
    }
    i++;
  }
  return style;
}

function paletteFromIndex(idx: number): SgrColor {
  // 0..15 map to the two named palettes.
  if (idx >= 0 && idx < 8) {
    const name = PALETTE_ORDER[idx];
    if (name !== undefined) return { kind: "palette", name };
  } else if (idx >= 8 && idx < 16) {
    const name = BRIGHT_ORDER[idx - 8];
    if (name !== undefined) return { kind: "palette", name };
  }
  // 16..231 form a 6x6x6 RGB cube; 232..255 are a 24-step
  // grayscale ramp. Map both to concrete RGB so the renderer
  // doesn't need a lookup.
  if (idx >= 16 && idx < 232) {
    const n = idx - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    return {
      kind: "rgb",
      r: rampChannel(r),
      g: rampChannel(g),
      b: rampChannel(b),
    };
  }
  if (idx >= 232 && idx < 256) {
    const level = 8 + (idx - 232) * 10;
    return { kind: "rgb", r: level, g: level, b: level };
  }
  // Out-of-range indices fall back to indexed so we don't lie
  // about which colour they picked; renderer treats unknown
  // indices as default fg.
  return { kind: "indexed", index: idx };
}

/** Standard xterm 6-level ramp: 0, 95, 135, 175, 215, 255. */
function rampChannel(level: number): number {
  if (level === 0) return 0;
  return 55 + level * 40;
}

function clamp255(n: number): number {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.floor(n);
}
