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
/**
 * Strip zsh's "missing-newline-at-EOF" indicator from the end
 * of captured stdout. When a command's output doesn't end with
 * `\n`, zsh writes `%` (typically with inverse-video styling)
 * followed by padding spaces and a `\r` to mark the
 * end-of-output before the next prompt. ANSI strip removes the
 * styling but the literal `%` + padding + `\r` survive as
 * plain text and leak into every formatter and into the RAW
 * view.
 *
 * Matches at end-of-string: optional leading `\n`, `%`, any
 * mix of spaces / tabs / carriage returns. Stops on the first
 * non-whitespace character before `%`, so a `%` that's part of
 * the real output (e.g. `echo "100%"`) is preserved.
 *
 * Apply *after* `stripAnsi` — the indicator's styling escapes
 * need to be gone first.
 */
export function stripShellArtifacts(input: string): string {
  return input.replace(/\n?%[ \t\r]*$/, "");
}

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
