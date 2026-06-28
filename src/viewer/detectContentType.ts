/**
 * Decide *what kind of renderer* to use for a block's content.
 *
 * Slice 4.2 adds two non-code renderers on top of the slice-4.1
 * CodeMirror surface: a Markdown viewer for `.md` content and an
 * image viewer for `.png` / `.jpeg` / `.gif` / `.svg`. The viewer
 * modal calls `detectContentType` to pick which to use; falling
 * back to the CodeMirror viewer (with language detection from
 * `detectLanguage.ts`) for everything else.
 *
 * Detection is by *filename* first (most reliable — the user
 * typed the path) and by *magic bytes* second (for piped or
 * keyword-less commands). Magic-byte sniffing is constrained to a
 * tiny prefix so a multi-MB block can still be classified
 * instantly.
 *
 * Pure module: no React, no DOM, no Tauri. Easy to test.
 */

export type ContentType =
  | "code" // Default — render with CodeMirror.
  | "markdown" // Render with react-markdown + DOMPurify.
  | "image" // png / jpeg / gif inline <img>.
  | "svg"; // Sanitised SVG (own renderer; not <img> via data URL).

/**
 * Lower-case extension → content type. Only the renderer-choosing
 * extensions live here; `detectLanguage.ts` covers code-language
 * mapping for the CodeMirror surface.
 */
const EXTENSION_MAP: Record<string, ContentType> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "svg",
};

/**
 * Magic-byte signatures we care about. We only sniff the first 16
 * bytes — enough to pick up every common image format unambiguously.
 * SVG is *text* (XML), so it isn't sniffed here; it's caught by
 * extension or by the `<?xml ... <svg` opening below.
 */
function imageFromMagicBytes(bytes: Uint8Array): ContentType | null {
  if (bytes.length < 4) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image";
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image";
  }
  // GIF: 47 49 46 38 ("GIF8")
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image";
  }
  // WebP: 52 49 46 46 ... 57 45 42 50 ("RIFF....WEBP")
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image";
  }
  return null;
}

/**
 * Quick SVG sniff. SVG is XML, so we look for either the XML
 * declaration immediately followed by `<svg` or for `<svg` near
 * the head of the file. Capped at the first 1 KiB.
 */
function looksLikeSvg(text: string): boolean {
  const head = text.slice(0, 1024).trimStart().toLowerCase();
  if (head.startsWith("<svg")) return true;
  if (head.startsWith("<?xml")) {
    return head.indexOf("<svg", 5) !== -1;
  }
  return false;
}

/**
 * Pull the trailing extension from a path. Lower-cased; returns
 * `null` for paths without one. (`makeFile.am.in` → `in`.)
 */
function extensionOf(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot === path.length - 1) return null;
  // Don't take a leading-dot file (`.bashrc`) as having an extension.
  const slash = path.lastIndexOf("/");
  if (dot === slash + 1) return null;
  return path.slice(dot + 1).toLowerCase();
}

/**
 * Extract the first non-flag positional argument from a tokenised
 * command. Mirrors the helper in `detectLanguage.ts` but kept
 * here so the two detectors don't have to share a dependency.
 */
function firstFilenameArg(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === "") continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

/**
 * Inputs: the bytes (if available) plus a tokenised `argv`. The
 * bytes are optional because the viewer modal may call this
 * before its fetch resolves — in which case we fall back to
 * extension-only detection.
 */
export interface DetectInput {
  bytes?: Uint8Array;
  text?: string;
  argv?: readonly string[];
}

export function detectContentType(input: DetectInput): ContentType {
  const { bytes, text, argv } = input;

  // 1. Filename extension. Most reliable.
  if (argv !== undefined && argv.length > 0) {
    const name = firstFilenameArg(argv);
    if (name !== null) {
      const ext = extensionOf(name);
      if (ext !== null) {
        const hit = EXTENSION_MAP[ext];
        if (hit !== undefined) return hit;
      }
    }
  }

  // 2. Magic bytes. Decides for binary images even when the user
  //    cat'd by stdin / via a pipe (rare but happens with
  //    `curl … | display`-style invocations).
  if (bytes !== undefined && bytes.length > 0) {
    const fromBytes = imageFromMagicBytes(bytes);
    if (fromBytes !== null) return fromBytes;
  }

  // 3. SVG via text sniff. `text` is the decoded view of `bytes`
  //    when both are present; the modal passes them both.
  if (text !== undefined && text.length > 0 && looksLikeSvg(text)) {
    return "svg";
  }

  return "code";
}

// Re-exported for tests.
export { extensionOf, firstFilenameArg, imageFromMagicBytes, looksLikeSvg };
