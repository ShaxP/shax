/**
 * Pure JSON detection for the `json` formatter (M4 slice 4.6a).
 *
 * Two questions the formatter needs answered without rendering:
 *
 *   1. Is this block's stdout JSON we can parse?
 *   2. If so, what's the parsed value (so the matcher and renderer
 *      both see the same thing)?
 *
 * Kept in its own pure module so tests don't need React or jsdom
 * and the registry's matcher pass can call it cheaply.
 */

/** Result of a JSON probe. `null` when the input isn't parseable
 *  as JSON, or doesn't even *look* like JSON (saves a parse on
 *  obvious non-matches). */
export interface JsonProbe {
  /** Parsed value (object, array, primitive). `null` is itself a
   *  valid JSON value, so callers should distinguish "no probe"
   *  via this whole result being `null`. */
  value: unknown;
}

/** Cheap pre-flight: does the input *look* like JSON? Skips a
 *  full parse for blocks that clearly aren't (`ls` output, a
 *  shell error, etc.). Tight enough to reject prose ("total 24")
 *  while still accepting the bare primitives `jq` emits (`42`,
 *  `"hi"`, `null`).
 *
 *  Structural openers (`{`, `[`, `"`) and numeric opener (`-` or
 *  digit) get the unambiguous yes. For `true` / `false` / `null`
 *  the first non-blank line must be *exactly* the keyword — so
 *  "total 24" (starts with `t`) doesn't sneak through. */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const first = trimmed[0] ?? "";
  if (first === "{" || first === "[" || first === '"') return true;
  if (first === "-" || (first >= "0" && first <= "9")) return true;
  const firstLine = (trimmed.split("\n", 1)[0] ?? "").trim();
  return firstLine === "true" || firstLine === "false" || firstLine === "null";
}

/** Extract the first balanced JSON value from the head of `text`,
 *  returning the substring that should be parseable. Returns
 *  `null` when nothing JSON-shaped is at the head.
 *
 *  Why this exists: PTY-captured stdout from `jq`, `curl`, etc.
 *  often has trailing terminal noise — zsh's `%` missing-newline
 *  indicator (which survives ANSI strip), late prompt bytes, the
 *  user's PS1 fragments. A strict `JSON.parse` chokes on any
 *  trailing character; this walker stops at the structural close
 *  of the leading value so the trailing noise is ignored. */
function extractLeadingJson(text: string): string | null {
  let i = 0;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  if (i >= text.length) return null;
  const start = i;
  const first = text[i] ?? "";

  // Structural opener: walk brackets, respecting strings + escapes.
  if (first === "{" || first === "[") {
    const close = first === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (inString) {
        if (escape) {
          escape = false;
          i++;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          i++;
          continue;
        }
        if (ch === '"') {
          inString = false;
          i++;
          continue;
        }
        i++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        i++;
        continue;
      }
      if (ch === first) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
      i++;
    }
    return null; // unbalanced
  }

  // Quoted-string primitive: walk to the matching `"`.
  if (first === '"') {
    let escape = false;
    i++;
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (escape) {
        escape = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        i++;
        continue;
      }
      if (ch === '"') return text.slice(start, i + 1);
      i++;
    }
    return null;
  }

  // Numeric / keyword primitive: read to the next whitespace.
  while (i < text.length && !/\s/.test(text[i] ?? "")) i++;
  return text.slice(start, i);
}

/** Full probe: try to parse `text` as JSON and return the parsed
 *  value. Three routes, in order:
 *
 *    1. Strict single-parse — `JSON.parse` of the trimmed text.
 *       Catches the common clean cases: `{...}`, `[...]`, and
 *       bare `42` / `"hi"` / `true` / `null`. By going first
 *       this also ensures a clean bare primitive isn't misread
 *       as a JSON-Lines stream of one.
 *    2. JSON Lines — when there are ≥2 non-blank lines that
 *       *all* parse standalone (`jq '.[]'`'s streaming output).
 *       Wrapped into a synthetic array.
 *    3. Leading JSON value, but **only when trailing content
 *       looks like shell noise** — pure whitespace, or starts
 *       with `%` (zsh's missing-newline indicator that leaks
 *       past ANSI strip). Without the trailing-content check
 *       this route would over-claim outputs like
 *       `wc README.md`'s `42 README.md` as the bare number 42.
 *
 *  Returns `null` on parse failure / empty / not-JSON-shaped. */
export function probeJson(text: string): JsonProbe | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!looksLikeJson(trimmed)) return null;
  // 1. Strict single-parse on the trimmed text.
  try {
    const value: unknown = JSON.parse(trimmed);
    return { value };
  } catch {
    // fall through
  }
  // 2. JSON Lines. Each non-blank line must parse standalone;
  //    one failure forces the fall-through.
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length >= 2) {
    try {
      const values = lines.map((line) => JSON.parse(line) as unknown);
      return { value: values };
    } catch {
      // fall through to leading-value extract
    }
  }
  // 3. Leading-value extract + parse, gated on the post-value
  //    trailing being shell noise (whitespace or `%`).
  const extracted = extractLeadingJson(trimmed);
  if (extracted !== null) {
    const rest = trimmed.slice(extracted.length).trim();
    const isShellNoise = rest.length === 0 || rest.startsWith("%");
    if (isShellNoise) {
      try {
        const value: unknown = JSON.parse(extracted);
        return { value };
      } catch {
        // fall through
      }
    }
  }
  return null;
}

/** Convenience for the matcher: was this block produced by a tool
 *  that almost always emits JSON? Currently `jq`. We treat this
 *  as a *hint* — the formatter still parses the actual stdout
 *  via `probeJson` and falls back to PASS if parsing fails. */
export function isLikelyJsonCommand(argv: readonly string[]): boolean {
  return argv[0] === "jq";
}

/** Tag for a parsed JSON node. The renderer uses this to pick a
 *  colour / icon without re-checking the value's runtime type
 *  everywhere. */
export type JsonNodeKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export function kindOf(value: unknown): JsonNodeKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      // Functions, undefined, symbols don't survive JSON.parse,
      // so this branch is for completeness only.
      return "string";
  }
}

/** Count entries for the collapsed-state summary ("Object · 12
 *  entries", "Array · 0 items"). Returns 0 for primitives. */
export function entryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length;
  }
  return 0;
}
