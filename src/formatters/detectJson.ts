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

/** Full probe: try to parse `text` as JSON and return the parsed
 *  value. Two routes, in order:
 *
 *    1. A single JSON value — `JSON.parse` of the trimmed text.
 *       Catches both structured (`{...}`, `[...]`) and bare
 *       (`42`, `"hi"`, `true`, `null`) outputs.
 *    2. JSON Lines — one value per line, each parses cleanly.
 *       This is what `jq '.[]'` and similar streaming queries
 *       emit. Wrapped into a synthetic array so the renderer
 *       sees a single value.
 *
 *  Returns `null` on parse failure / empty / not-JSON-shaped.
 *  Single-value parses are tried first, so a block whose stdout
 *  is a valid array doesn't get mis-detected as JSON Lines. */
export function probeJson(text: string): JsonProbe | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!looksLikeJson(trimmed)) return null;
  // 1. Single value.
  try {
    const value: unknown = JSON.parse(trimmed);
    return { value };
  } catch {
    // fall through
  }
  // 2. JSON Lines. Each non-blank line must parse standalone.
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return null;
  try {
    const values = lines.map((line) => JSON.parse(line) as unknown);
    return { value: values };
  } catch {
    return null;
  }
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
