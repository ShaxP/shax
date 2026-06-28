/**
 * Strip ANSI / CSI / OSC escape sequences from a decoded text
 * string. Shared between every text-based viewer renderer
 * (CodeMirror, Markdown, future log viewers) so they all show
 * clean text — the raw bytes path keeps the originals.
 *
 * Handles:
 *   - CSI: `ESC [ params final` (covers `\x1b[1m`, `\x1b[27m`, …).
 *   - OSC: `ESC ] payload (BEL | ST)`.
 *   - Other two-byte ESC sequences (charset selects, save / restore
 *     cursor): ESC + one follow byte, dropped.
 *
 * Pure module; no DOM, no React. Easy to unit-test.
 */
export function stripAnsi(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input.charCodeAt(i);
    if (ch !== 0x1b) {
      out += input[i];
      i++;
      continue;
    }
    const next = input.charCodeAt(i + 1);
    if (next === 0x5b /* [ */) {
      // CSI: skip params + final byte (0x40–0x7e).
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (next === 0x5d /* ] */) {
      // OSC: terminated by BEL (0x07) or ST (ESC \\).
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c === 0x07) {
          j++;
          break;
        }
        if (c === 0x1b && input.charCodeAt(j + 1) === 0x5c /* \ */) {
          j += 2;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    // Other two-byte sequences: drop ESC + the byte after.
    i += 2;
  }
  return out;
}
