/**
 * Parser for `git diff`'s unified diff output (M4 slice 4.5).
 *
 * Each file's diff starts with a `diff --git a/<old> b/<new>`
 * marker, followed by metadata lines (`index`, `new file mode`,
 * `deleted file mode`, `Binary files differ`, `--- a/<old>`,
 * `+++ b/<new>`), then zero or more hunks each starting with
 * `@@ -oldStart,oldLines +newStart,newLines @@`.
 *
 * Pure module — no React. The renderer walks the parsed tree.
 */

export interface DiffLine {
  /** Type of line: `"add"`, `"del"`, `"context"`, or `"meta"`. */
  kind: "add" | "del" | "context" | "meta";
  /** Line number in the old file (1-based); null for adds + meta. */
  oldLine: number | null;
  /** Line number in the new file (1-based); null for dels + meta. */
  newLine: number | null;
  /** Content of the line, *without* the leading `+`/`-`/` ` marker. */
  text: string;
}

export interface DiffHunk {
  /** Raw header `@@ -1,3 +1,4 @@ some context`. */
  header: string;
  /** Line number where the hunk starts in the old file. */
  oldStart: number;
  /** Line number where the hunk starts in the new file. */
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Filename as it appears on the `+++ b/<path>` line, or the
   *  `b/<path>` in the `diff --git` header. */
  path: string;
  /** Source filename, for renames and copies — same as `path`
   *  otherwise. */
  oldPath: string;
  /** `true` if git reports the file is binary (no hunks). */
  binary: boolean;
  /** Detected operation. `null` for an ordinary modification. */
  op: "new" | "deleted" | "renamed" | "copied" | "mode-change" | null;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
}

export function parseGitDiff(text: string): ParsedDiff {
  const lines = text.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLineCounter = 0;
  let newLineCounter = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git")) {
      // New file. Push the previous one (if any) into the list.
      if (current !== null) {
        if (currentHunk !== null) current.hunks.push(currentHunk);
        files.push(current);
      }
      const paths = parseDiffGitHeader(line);
      current = {
        path: paths.b,
        oldPath: paths.a,
        binary: false,
        op: null,
        hunks: [],
      };
      currentHunk = null;
      i++;
      continue;
    }
    if (current === null) {
      // Pre-amble before the first `diff --git`. Skip.
      i++;
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.op = "new";
      i++;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.op = "deleted";
      i++;
      continue;
    }
    if (line.startsWith("rename from") || line.startsWith("rename to")) {
      current.op = "renamed";
      i++;
      continue;
    }
    if (line.startsWith("copy from") || line.startsWith("copy to")) {
      current.op = "copied";
      i++;
      continue;
    }
    if (line.startsWith("old mode") || line.startsWith("new mode")) {
      if (current.op === null) current.op = "mode-change";
      i++;
      continue;
    }
    if (line.startsWith("Binary files")) {
      current.binary = true;
      i++;
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ")) {
      // Header noise we already extracted via the `diff --git`
      // line. Skip; the renderer never needs them.
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      if (currentHunk !== null) current.hunks.push(currentHunk);
      const header = parseHunkHeader(line);
      if (header === null) {
        // Malformed; treat the line as meta noise.
        i++;
        continue;
      }
      currentHunk = {
        header: line,
        oldStart: header.oldStart,
        newStart: header.newStart,
        lines: [],
      };
      oldLineCounter = header.oldStart;
      newLineCounter = header.newStart;
      i++;
      continue;
    }
    if (currentHunk === null) {
      // Pre-hunk metadata we don't recognise; skip.
      i++;
      continue;
    }
    // Body of the hunk: `+` / `-` / ` ` (context) / `\` (no-newline-at-eof).
    const ch = line[0] ?? "";
    if (ch === "+") {
      currentHunk.lines.push({
        kind: "add",
        oldLine: null,
        newLine: newLineCounter,
        text: line.slice(1),
      });
      newLineCounter++;
    } else if (ch === "-") {
      currentHunk.lines.push({
        kind: "del",
        oldLine: oldLineCounter,
        newLine: null,
        text: line.slice(1),
      });
      oldLineCounter++;
    } else if (ch === " ") {
      currentHunk.lines.push({
        kind: "context",
        oldLine: oldLineCounter,
        newLine: newLineCounter,
        text: line.slice(1),
      });
      oldLineCounter++;
      newLineCounter++;
    } else if (ch === "\\") {
      // `\ No newline at end of file` — meta, attached to the
      // previous line conceptually but rendered as its own
      // muted row.
      currentHunk.lines.push({
        kind: "meta",
        oldLine: null,
        newLine: null,
        text: line.slice(1).trimStart(),
      });
    } else {
      // Trailing blank / unknown — bail to the next file.
    }
    i++;
  }
  if (current !== null) {
    if (currentHunk !== null) current.hunks.push(currentHunk);
    files.push(current);
  }
  return { files };
}

function parseDiffGitHeader(line: string): { a: string; b: string } {
  // `diff --git a/<old> b/<new>` — but `<old>` and `<new>` can
  // contain spaces, and `<new>` is usually the same as `<old>`
  // (it's only different for renames, which `git diff` also
  // marks with `rename from` / `rename to` lines). Take the
  // last `b/` token and the last `a/` token before that.
  const rest = line.slice("diff --git ".length);
  // Find ` b/` separator that splits a/ and b/.
  // The last occurrence is the right one even with weird paths.
  const sep = rest.lastIndexOf(" b/");
  if (sep === -1) {
    return { a: rest, b: rest };
  }
  const aPart = rest.slice(0, sep);
  const bPart = rest.slice(sep + 3); // skip " b/"
  const a = aPart.startsWith("a/") ? aPart.slice(2) : aPart;
  return { a, b: bPart };
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  // `@@ -<oldStart>(,<oldLines>)? +<newStart>(,<newLines>)? @@ [context]`
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return {
    oldStart: Number(m[1]),
    newStart: Number(m[2]),
  };
}
