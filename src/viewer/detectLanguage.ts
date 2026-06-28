/**
 * Pick a CodeMirror language extension for a block's text content.
 *
 * The first pass goes by *filename argument* — the most reliable
 * source for a `cat` / `bat` / `less` block, since the user typed
 * the path. Falls back to inspecting the content itself (shebang
 * and JSON sniffing), then plain text.
 *
 * Pure module (no React, no DOM) so it's straightforward to test.
 */

import { type Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";

export type LanguageId =
  | "javascript"
  | "typescript"
  | "rust"
  | "python"
  | "markdown"
  | "json"
  | "html"
  | "css"
  | "yaml"
  | "plaintext";

/**
 * File-extension → language id table. Lower-cased on lookup so case
 * variations on case-insensitive filesystems still resolve.
 */
const EXTENSION_MAP: Record<string, LanguageId> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  rs: "rust",
  py: "python",
  pyi: "python",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  xml: "html",
  css: "css",
  scss: "css",
  yaml: "yaml",
  yml: "yaml",
};

/**
 * Shebang interpreter → language id table. Matched against the
 * basename of the interpreter path so both `#!/usr/bin/python3`
 * and `#!/usr/bin/env python3` work.
 */
const SHEBANG_MAP: Record<string, LanguageId> = {
  node: "javascript",
  deno: "javascript",
  bun: "javascript",
  tsx: "typescript",
  python: "python",
  python3: "python",
  ruby: "plaintext", // no @codemirror/lang-ruby in M4
  bash: "plaintext", // shell highlighting may come later
  sh: "plaintext",
};

/**
 * Map a `LanguageId` to its CodeMirror extension. `plaintext`
 * resolves to an empty extension array — CM6 still gives line
 * numbers + cursor + basic editing.
 */
export function languageExtension(id: LanguageId): Extension {
  switch (id) {
    case "javascript":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ jsx: true, typescript: true });
    case "rust":
      return rust();
    case "python":
      return python();
    case "markdown":
      return markdown();
    case "json":
      return json();
    case "html":
      return html();
    case "css":
      return css();
    case "yaml":
      return yaml();
    case "plaintext":
      return [];
  }
}

/**
 * Extract a filename from a command's `argv`-ish array. The first
 * positional that doesn't look like a flag is treated as a path
 * (the common `cat README.md` / `bat src/lib.rs` shape). Returns
 * the lower-cased extension without the dot, or `null` if no
 * usable filename was found.
 */
export function extensionFromArgv(argv: readonly string[]): string | null {
  // Skip the program name. Stop at the first non-flag positional.
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === "") continue;
    if (arg.startsWith("-")) continue;
    const dot = arg.lastIndexOf(".");
    if (dot === -1 || dot === arg.length - 1) return null;
    return arg.slice(dot + 1).toLowerCase();
  }
  return null;
}

/**
 * Detect a language from a shebang line at the top of `text`.
 * Returns `null` if the first line isn't a shebang or the
 * interpreter is unknown.
 */
export function languageFromShebang(text: string): LanguageId | null {
  if (!text.startsWith("#!")) return null;
  const eol = text.indexOf("\n");
  const line = eol === -1 ? text : text.slice(0, eol);
  // Take the last whitespace-separated path-like token. This
  // handles `#!/usr/bin/python3` and `#!/usr/bin/env python3`
  // identically — both end in `python3`.
  const parts = line.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  if (last === undefined || last.length === 0) return null;
  const slash = last.lastIndexOf("/");
  const interpreter = (slash === -1 ? last : last.slice(slash + 1)).toLowerCase();
  return SHEBANG_MAP[interpreter] ?? null;
}

/**
 * Heuristic JSON sniff: strip leading whitespace, check that the
 * first non-space byte is `{` or `[`, and that the whole trimmed
 * text round-trips through `JSON.parse`. Capped at a reasonable
 * size so we don't churn on multi-megabyte blocks.
 */
export function looksLikeJson(text: string): boolean {
  const SNIFF_CAP = 256 * 1024;
  const sample = text.length > SNIFF_CAP ? text.slice(0, SNIFF_CAP) : text;
  const trimmed = sample.trimStart();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Full detection pipeline used by the viewer.
 *
 *   1. filename extension from `argv`,
 *   2. shebang on the content's first line,
 *   3. JSON content sniff,
 *   4. fallback to plain text.
 *
 * `argv` is optional so the viewer can be opened on arbitrary
 * content (e.g. piped output with no obvious filename).
 */
export function detectLanguage(text: string, argv?: readonly string[]): LanguageId {
  if (argv !== undefined && argv.length > 0) {
    const ext = extensionFromArgv(argv);
    if (ext !== null) {
      const fromExt = EXTENSION_MAP[ext];
      if (fromExt !== undefined) return fromExt;
    }
  }
  const fromShebang = languageFromShebang(text);
  if (fromShebang !== null) return fromShebang;
  if (looksLikeJson(text)) return "json";
  return "plaintext";
}
