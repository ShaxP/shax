/**
 * Sample sandboxed formatter — `wc` (slice 4.6b1).
 *
 * Demonstrates the worker-sandbox pipeline end-to-end: parses
 * `wc` output, returns a key-value or table schema depending on
 * shape, and is loaded the same way a future user-installed
 * community formatter would be.
 *
 * Bundled into Shax for v1 so we have a community-shaped
 * formatter to exercise the pipeline without needing the disk
 * loader (that lands in 4.6b2). When the disk loader exists,
 * this sample becomes a "ship-with-the-app default" that the
 * user could override or disable, but the bundled-vs-on-disk
 * distinction is invisible to the registry — both flow through
 * `createSandboxedFormatter`.
 */

import { createSandboxedFormatter } from "../createSandboxed";

/**
 * Source string executed inside the Worker. Must assign the
 * render function to `self.__shax_formatter_render`. Receives a
 * sanitised context object; returns a SandboxNode JSON tree.
 *
 * Kept as a hand-written string (not a TS module) because the
 * Worker has no TypeScript at runtime and no module loader —
 * the string is concatenated with the worker scaffold and
 * loaded as one. A future build step could compile a TS source
 * into this string automatically; for v1, plain JS is fine.
 */
const WC_SOURCE = `
self.__shax_formatter_render = function (ctx) {
  // Trim trailing zsh \`%\` artifact and any other noise.
  var text = ctx.stdout;
  var end = text.length;
  while (end > 0 && /\\s/.test(text.charAt(end - 1))) end--;
  text = text.slice(0, end);

  // Split into rows. Each line of \`wc\` output is fixed-shape
  // whitespace-separated columns.
  var lines = text.split("\\n").map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
  if (lines.length === 0) return null;

  // Detect flags from argv. Default \`wc\` (no flags) emits
  // 4 columns: lines, words, bytes, filename.
  var argv = ctx.argv || [];
  var flags = { lines: false, words: false, chars: false, bytes: false };
  for (var i = 1; i < argv.length; i++) {
    var a = argv[i];
    if (typeof a !== "string") continue;
    if (a === "-l" || a === "--lines") flags.lines = true;
    else if (a === "-w" || a === "--words") flags.words = true;
    else if (a === "-c" || a === "--bytes") flags.bytes = true;
    else if (a === "-m" || a === "--chars") flags.chars = true;
    else if (a.charAt(0) === "-" && a.length > 1 && a.charAt(1) !== "-") {
      // Combined short flags: \`-lw\`, \`-lwc\`, …
      for (var j = 1; j < a.length; j++) {
        var ch = a.charAt(j);
        if (ch === "l") flags.lines = true;
        else if (ch === "w") flags.words = true;
        else if (ch === "c") flags.bytes = true;
        else if (ch === "m") flags.chars = true;
      }
    }
  }
  var any = flags.lines || flags.words || flags.chars || flags.bytes;
  // Default (no flags) → all three numeric columns.
  if (!any) { flags.lines = true; flags.words = true; flags.bytes = true; }

  // Build the header from active flags, in the standard wc
  // column order: lines, words, chars/bytes, filename.
  var header = [];
  if (flags.lines) header.push("lines");
  if (flags.words) header.push("words");
  if (flags.chars) header.push("chars");
  if (flags.bytes) header.push("bytes");
  header.push("file");

  // Parse each line — wc separates columns with runs of spaces.
  var rows = lines.map(function (line) {
    var parts = line.split(/\\s+/).filter(function (p) { return p.length > 0; });
    // Last token is the filename; preceding tokens are numeric.
    var file = parts.length > 0 ? parts[parts.length - 1] : "";
    var nums = parts.slice(0, parts.length - 1);
    var row = nums.slice();
    row.push(file);
    return row;
  });

  // Single-file output uses a key-value shape because that
  // reads cleaner than a one-row table; multi-file output
  // (with a trailing \`total\` row) stays tabular.
  if (rows.length === 1) {
    var row = rows[0];
    var entries = [];
    var k = 0;
    if (flags.lines) entries.push({ key: "lines", value: row[k++] || "" });
    if (flags.words) entries.push({ key: "words", value: row[k++] || "" });
    if (flags.chars) entries.push({ key: "chars", value: row[k++] || "" });
    if (flags.bytes) entries.push({ key: "bytes", value: row[k++] || "" });
    entries.push({ key: "file", value: row[k] || "(stdin)" });
    return { kind: "key-value", entries: entries };
  }
  return { kind: "table", header: header, rows: rows };
};
`;

export const wcSandboxFormatter = createSandboxedFormatter({
  name: "wc",
  matcher: { kind: "argv0", argv0: "wc" },
  source: WC_SOURCE,
});
