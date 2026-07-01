/**
 * Shared content-aware view (M4.5 slice 1).
 *
 * Used by both the inline cat formatter and the block viewer
 * modal — when the inputs (bytes / text / content type) and
 * mode are the same, the render is the same. That's the
 * "one source of truth" rule from spec §06.
 *
 * Three modes — the FMT / SRC / RAW lens system from spec §07:
 *
 *   - "rendered" (FMT): markdown rendered, image inline, SVG
 *     sanitised, source-with-language-highlight for code.
 *   - "source" (SRC): the on-disk source as text. For binaries
 *     this is the `xxd`-style hex view. For text content with
 *     a different rendered view (markdown, SVG), this is
 *     CodeMirror with the source's own grammar.
 *   - "raw" (RAW): the *captured* bytes as plain text — what
 *     the terminal actually wrote, no language colouring, no
 *     disk-read substitution. The caller decides what `text`
 *     and `bytes` to pass in this mode (typically the
 *     captured-stdout pair).
 *
 * `text` may be `null` only when `contentType` is `"image"` —
 * the renderer doesn't decode binary bytes as text. Other
 * contentTypes assume `text` is non-null.
 */

import { ImageView } from "./ImageView";
import { MarkdownView } from "./MarkdownView";
import { Viewer } from "./Viewer";
import { HexView } from "./HexView";
import type { ContentType } from "./detectContentType";
import type { LanguageId } from "./detectLanguage";
import type { CSSProperties } from "react";

export type ContentLens = "rendered" | "source" | "info" | "raw";

export interface ContentViewProps {
  contentType: ContentType;
  /** Raw bytes; used by ImageView and HexView. */
  bytes: Uint8Array;
  /** UTF-8 decoded + ANSI-stripped text. `null` for binary
   *  content where decoding doesn't make sense. */
  text: string | null;
  /** Detected language for the CodeMirror viewer fallback. */
  language: LanguageId;
  mode: ContentLens;
  filenameHint?: string | null;
  style?: CSSProperties;
}

/** True iff the content type has a distinct *source* view —
 *  meaning a SRC toggle button adds information that FMT
 *  doesn't already show. The caller uses this to decide
 *  whether to render the FMT/SRC/RAW three-way or just
 *  FMT/RAW. */
export function hasDistinctSource(contentType: ContentType): boolean {
  return contentType !== "code";
}

export function ContentView({
  contentType,
  bytes,
  text,
  language,
  mode,
  filenameHint,
  style,
}: ContentViewProps): React.ReactElement {
  switch (contentType) {
    case "image":
      if (mode === "rendered") {
        return (
          <ImageView
            bytes={bytes}
            kind="raster"
            filenameHint={filenameHint ?? null}
            style={style}
          />
        );
      }
      // SRC / RAW on a binary fall back to the hex view —
      // decoding image bytes as text is mojibake, and the hex
      // dump is the most honest "look at the bytes" lens we
      // can offer.
      return <HexView bytes={bytes} style={style} />;

    case "svg":
      if (mode === "rendered") {
        return <ImageView bytes={bytes} kind="svg" style={style} />;
      }
      // SVG is XML; CodeMirror's html grammar covers it. There's
      // no dedicated `xml` LanguageId yet.
      return (
        <Viewer
          text={text ?? ""}
          language={mode === "source" ? "html" : "plaintext"}
          style={style}
        />
      );

    case "markdown":
      if (mode === "rendered" && text !== null) {
        return <MarkdownView text={text} style={style} />;
      }
      return (
        <Viewer
          text={text ?? ""}
          language={mode === "source" ? "markdown" : "plaintext"}
          style={style}
        />
      );

    case "code":
      // Plain code has no separate "rendered" tier — the
      // syntax-highlighted view *is* the source. RAW switches
      // to plaintext.
      return (
        <Viewer
          text={text ?? ""}
          language={mode === "raw" ? "plaintext" : language}
          style={style}
        />
      );
  }
}
