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
 *  shell error, etc.). */
export function looksLikeJson(text: string): boolean {
  // Trim leading whitespace; JSON is allowed to have any amount
  // of leading whitespace and most pretty-printers add it.
  let i = 0;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  if (i >= text.length) return false;
  const first = text[i];
  return first === "{" || first === "[";
}

/** Full probe: try to parse `text` as JSON and return the parsed
 *  value, or `null` on parse failure / empty / not-even-looks-like.
 *  The implementation is intentionally a single `JSON.parse` —
 *  V8's parser is faster than anything we'd write. */
export function probeJson(text: string): JsonProbe | null {
  if (!looksLikeJson(text)) return null;
  try {
    const value: unknown = JSON.parse(text);
    return { value };
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
