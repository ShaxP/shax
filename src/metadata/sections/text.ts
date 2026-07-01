/**
 * `TEXT` section for the INFO lens — text-specific facts:
 * line count, encoding, detected language.
 *
 * Applied for any content type other than `image` — markdown,
 * svg (which is xml/text), and plain code all get it. Not
 * added for `contentType === "image"` since the file's bytes
 * aren't meant to be decoded as text.
 */

import type { LanguageId } from "../../viewer/detectLanguage";
import type { MetadataSection } from "../types";

interface TextInput {
  text: string;
  language: LanguageId;
}

export function buildTextSection({ text, language }: TextInput): MetadataSection {
  const lines = countLines(text);
  const rows = [
    { key: "Lines", value: lines.toLocaleString() },
    { key: "Language", value: humanLanguage(language) },
    { key: "Encoding", value: "UTF-8" },
  ];
  return { title: "Text", rows };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  // Empty trailing line (file ended with `\n`) doesn't count —
  // matches `wc -l` semantics.
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) count++;
  }
  if (text.charCodeAt(text.length - 1) !== 0x0a) count++;
  return count;
}

function humanLanguage(language: LanguageId): string {
  switch (language) {
    case "javascript":
      return "JavaScript";
    case "typescript":
      return "TypeScript";
    case "rust":
      return "Rust";
    case "python":
      return "Python";
    case "markdown":
      return "Markdown";
    case "json":
      return "JSON";
    case "html":
      return "HTML";
    case "css":
      return "CSS";
    case "yaml":
      return "YAML";
    case "plaintext":
      return "plain text";
  }
}
