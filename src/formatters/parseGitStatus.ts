/**
 * Parser for `git status --porcelain=v2 --branch -z`
 * (M4 slice 4.5).
 *
 * Porcelain v2 output is the stable machine-readable format
 * across git versions — we use this instead of parsing the
 * human output (which is localised, depends on `color.ui`, and
 * changes between releases).
 *
 * Lines (`-z` makes them NUL-separated for files with newlines):
 *
 *   `# branch.oid <sha>`                            → header
 *   `# branch.head <name | (detached)>`             → header
 *   `# branch.upstream <name>`                      → header (optional)
 *   `# branch.ab +<ahead> -<behind>`                → header (optional)
 *   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`  → tracked changed
 *   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<orig>`
 *                                                    → renamed / copied
 *   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 *                                                    → unmerged
 *   `? <path>`                                       → untracked
 *   `! <path>`                                       → ignored
 *
 * `XY`: two-letter `<index><worktree>` status code.
 *   `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied,
 *   `T` typechange, `U` updated-but-unmerged, `.` no change.
 *
 * Pure module — no React, no Tauri, no fs. Easy to test.
 */

export interface BranchInfo {
  /** Current commit OID (or `"(initial)"` on a fresh repo). */
  oid: string | null;
  /** Current branch name (or `"(detached)"`). */
  head: string | null;
  upstream: string | null;
  /** Ahead / behind counts relative to upstream. */
  ahead: number;
  behind: number;
}

export type StatusCode = "." | "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?" | "!";

export interface StatusEntry {
  /** Path relative to repo root (post-rename for renames). */
  path: string;
  /** For renames / copies, the source path. */
  origPath: string | null;
  /** Index-side status — first char of the XY code. */
  index: StatusCode;
  /** Worktree-side status — second char of the XY code. */
  worktree: StatusCode;
  /** `true` for `u` lines (merge conflict). */
  unmerged: boolean;
}

export interface GitStatus {
  branch: BranchInfo;
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: StatusEntry[];
  ignored: StatusEntry[];
  unmerged: StatusEntry[];
}

/** Parse the entire porcelain-v2 output. NUL-separated entries
 *  (`-z`) so a path containing a literal newline doesn't break
 *  the parser. */
export function parseGitStatus(output: string): GitStatus {
  const status: GitStatus = {
    branch: { oid: null, head: null, upstream: null, ahead: 0, behind: 0 },
    staged: [],
    unstaged: [],
    untracked: [],
    ignored: [],
    unmerged: [],
  };
  const records = output.split("\0");
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (rec === undefined || rec.length === 0) {
      i++;
      continue;
    }
    const kind = rec[0];
    if (kind === "#") {
      parseHeader(rec, status.branch);
      i++;
      continue;
    }
    if (kind === "1") {
      const e = parseChangedV2(rec);
      if (e !== null) bucketEntry(status, e);
      i++;
      continue;
    }
    if (kind === "2") {
      // Renames: the original path is in the *next* NUL record.
      const next = records[i + 1] ?? "";
      const e = parseRenamedV2(rec, next);
      if (e !== null) bucketEntry(status, e);
      i += 2;
      continue;
    }
    if (kind === "u") {
      const e = parseUnmergedV2(rec);
      if (e !== null) bucketEntry(status, e);
      i++;
      continue;
    }
    if (kind === "?") {
      status.untracked.push({
        path: rec.slice(2),
        origPath: null,
        index: "?",
        worktree: "?",
        unmerged: false,
      });
      i++;
      continue;
    }
    if (kind === "!") {
      status.ignored.push({
        path: rec.slice(2),
        origPath: null,
        index: "!",
        worktree: "!",
        unmerged: false,
      });
      i++;
      continue;
    }
    // Unknown line kind — skip. (Future git versions may add new
    // record types; we don't want to crash on them.)
    i++;
  }
  return status;
}

function parseHeader(line: string, branch: BranchInfo): void {
  // Form: `# branch.<key> <value...>`.
  const rest = line.slice(2);
  const sp = rest.indexOf(" ");
  if (sp === -1) return;
  const key = rest.slice(0, sp);
  const value = rest.slice(sp + 1);
  if (key === "branch.oid") {
    branch.oid = value === "(initial)" ? "(initial)" : value;
  } else if (key === "branch.head") {
    branch.head = value;
  } else if (key === "branch.upstream") {
    branch.upstream = value;
  } else if (key === "branch.ab") {
    // `+12 -3`
    const m = /^\+(\d+)\s+-(\d+)$/.exec(value);
    if (m !== null) {
      branch.ahead = Number(m[1]);
      branch.behind = Number(m[2]);
    }
  }
}

/** "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>" */
function parseChangedV2(line: string): StatusEntry | null {
  // Token boundaries are spaces UNTIL the path, which can
  // itself contain spaces. After the 8th space (after `<hI>`)
  // everything is the path.
  const parts = splitOnSpace(line, 9);
  if (parts.length < 9) return null;
  const xy = parts[1] ?? "";
  return {
    path: parts[8] ?? "",
    origPath: null,
    index: codeOf(xy[0]),
    worktree: codeOf(xy[1]),
    unmerged: false,
  };
}

/** "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>" + (next NUL) orig */
function parseRenamedV2(line: string, origRecord: string): StatusEntry | null {
  // 10 fields then the path.
  const parts = splitOnSpace(line, 10);
  if (parts.length < 10) return null;
  const xy = parts[1] ?? "";
  return {
    path: parts[9] ?? "",
    origPath: origRecord.length > 0 ? origRecord : null,
    index: codeOf(xy[0]),
    worktree: codeOf(xy[1]),
    unmerged: false,
  };
}

/** "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>" */
function parseUnmergedV2(line: string): StatusEntry | null {
  const parts = splitOnSpace(line, 11);
  if (parts.length < 11) return null;
  const xy = parts[1] ?? "";
  return {
    path: parts[10] ?? "",
    origPath: null,
    index: codeOf(xy[0]),
    worktree: codeOf(xy[1]),
    unmerged: true,
  };
}

/** Split into the first `n` whitespace-separated fields; the
 *  remainder of the string becomes the last field (so paths
 *  containing spaces work). */
function splitOnSpace(line: string, n: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (out.length < n - 1 && i < line.length) {
    const sp = line.indexOf(" ", i);
    if (sp === -1) {
      out.push(line.slice(i));
      i = line.length;
      break;
    }
    out.push(line.slice(i, sp));
    i = sp + 1;
  }
  if (i < line.length) out.push(line.slice(i));
  return out;
}

function codeOf(ch: string | undefined): StatusCode {
  switch (ch) {
    case "M":
    case "A":
    case "D":
    case "R":
    case "C":
    case "T":
    case "U":
      return ch;
    case ".":
      return ".";
    default:
      return ".";
  }
}

function bucketEntry(status: GitStatus, entry: StatusEntry): void {
  if (entry.unmerged) {
    status.unmerged.push(entry);
    return;
  }
  // An entry can show up in *both* staged and unstaged when the
  // user has staged some changes and made further edits. The v2
  // format collapses that into one row with a non-`.` X and Y,
  // so we push to both lists when both sides changed.
  if (entry.index !== ".") status.staged.push(entry);
  if (entry.worktree !== ".") status.unstaged.push(entry);
}
