/**
 * INFO lens: compose the metadata view from a file's stats,
 * text (if any), and raw bytes.
 *
 * Universal sections (FILE, TEXT when applicable) come first,
 * then format-specific sections (PNG / JPEG / GIF) when the
 * raw bytes match one of the parsers. Everything is
 * best-effort — a parser that returns `null` (unknown format,
 * malformed) is silently skipped.
 */

import type { ContentType } from "../viewer/detectContentType";
import type { LanguageId } from "../viewer/detectLanguage";
import type { FileStat } from "../lib/ipc";
import type { MetadataView } from "./types";
import { buildFileSection } from "./sections/file";
import { buildTextSection } from "./sections/text";
import { buildPngSection } from "./sections/png";
import { buildJpegSection } from "./sections/jpeg";
import { buildGifSection } from "./sections/gif";

export interface BuildMetadataInput {
  stat: FileStat;
  bytes: Uint8Array;
  contentType: ContentType;
  /** UTF-8 decoded text; `null` for pure binary content. */
  text: string | null;
  language: LanguageId;
}

export function buildMetadata({
  stat,
  bytes,
  contentType,
  text,
  language,
}: BuildMetadataInput): MetadataView {
  const sections = [buildFileSection(stat)];
  // Format-specific sections next — order chosen so image
  // details are close to the FILE stats they annotate.
  const png = buildPngSection(bytes);
  if (png !== null) sections.push(png);
  const jpeg = buildJpegSection(bytes);
  if (jpeg !== null) sections.push(jpeg);
  const gif = buildGifSection(bytes);
  if (gif !== null) sections.push(gif);
  // TEXT section only for non-image content — decoding a PNG's
  // bytes as text is mojibake.
  if (contentType !== "image" && text !== null) {
    sections.push(buildTextSection({ text, language }));
  }
  return sections;
}
