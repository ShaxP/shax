/**
 * Image content renderer (M4 slice 4.2).
 *
 * Two paths:
 *
 *   - Raster images (`png`, `jpg`, `jpeg`, `gif`, `webp`) render
 *     as a plain `<img>` element with a `data:image/...;base64,...`
 *     URL. GIFs animate for free. We don't decode the bytes here;
 *     the browser does, and respects its own format gating.
 *
 *   - SVG is *text* but can carry `<script>`, event handlers,
 *     and `<foreignObject>`. We sanitise it with DOMPurify in
 *     SVG mode and inject via `dangerouslySetInnerHTML` — never
 *     via a `data:image/svg+xml,...` URL, because that path
 *     would bypass our sanitiser.
 */

import { useMemo, type CSSProperties } from "react";
import DOMPurify, { type Config as PurifyConfig } from "dompurify";

export type ImageKind = "raster" | "svg";

export interface ImageViewProps {
  /** Raw bytes of the image content. */
  bytes: Uint8Array;
  /** Branch which renderer to use. The detection module decides. */
  kind: ImageKind;
  /** Filename / argv hint used to pick the MIME type for raster
   *  images. Defaults to "png" — the format browsers handle most
   *  permissively if the actual type can't be determined. */
  filenameHint?: string | null;
  style?: CSSProperties;
}

const WRAPPER: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const HEADER: CSSProperties = {
  padding: "6px 12px",
  background: "var(--pane2)",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-ui)",
  fontSize: 11,
  color: "var(--fg-faint)",
  letterSpacing: 0.4,
  textTransform: "uppercase",
};

const BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "auto",
  background: "var(--pane)",
  padding: 20,
};

const IMAGE_STYLE: CSSProperties = {
  maxWidth: "100%",
  maxHeight: "100%",
  // Render images on a transparent checkerboard so the user can
  // see PNG alpha; defaulting to the surface colour would hide it.
  background:
    "linear-gradient(45deg, #1c1e25 25%, transparent 25%), " +
    "linear-gradient(-45deg, #1c1e25 25%, transparent 25%), " +
    "linear-gradient(45deg, transparent 75%, #1c1e25 75%), " +
    "linear-gradient(-45deg, transparent 75%, #1c1e25 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
  imageRendering: "pixelated",
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
};

const SVG_HOST: CSSProperties = {
  maxWidth: "100%",
  maxHeight: "100%",
  // SVGs may not declare a size — give them a sensible cap.
  display: "block",
};

/**
 * Browser-side base64 encoder. The shared helper in `lib/ipc.ts`
 * is the right thing for IPC payloads but lives behind the
 * Tauri-context check there; importing it works in tests too
 * since we re-export it as a pure function.
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid blowing the call stack with very large
  // images. 8 KiB chunks tested fine for tens of MB.
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Lower-case extension from a filename / argv-ish string.
 * Mirrors the detect-module helper but kept local so this file
 * has no internal dependency on the detector.
 */
function rasterMimeFromHint(hint: string | null | undefined): string {
  if (hint === null || hint === undefined) return "image/png";
  const lower = hint.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

// Strict DOMPurify config for SVG: strip every script vector
// and event handler, and disallow `<foreignObject>` which can
// embed arbitrary HTML / scripting back into the SVG.
const SVG_PURIFY_CONFIG: PurifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ["script", "foreignObject"],
  FORBID_ATTR: ["onload", "onerror", "onclick", "onmouseover", "onfocus"],
};

const TEXT_DECODER = new TextDecoder();

export function ImageView({
  bytes,
  kind,
  filenameHint,
  style,
}: ImageViewProps): React.ReactElement {
  const dataUrl = useMemo(() => {
    if (kind !== "raster") return "";
    const mime = rasterMimeFromHint(filenameHint);
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }, [bytes, kind, filenameHint]);

  const safeSvg = useMemo(() => {
    if (kind !== "svg") return "";
    const text = TEXT_DECODER.decode(bytes);
    return DOMPurify.sanitize(text, SVG_PURIFY_CONFIG);
  }, [bytes, kind]);

  return (
    <div style={{ ...WRAPPER, ...style }} data-testid="image-view">
      <div style={HEADER}>{kind === "svg" ? "svg · sanitised" : "image"}</div>
      <div style={BODY}>
        {kind === "raster" ? (
          <img data-testid="image-view-img" alt="block output" src={dataUrl} style={IMAGE_STYLE} />
        ) : (
          <div
            data-testid="image-view-svg"
            style={SVG_HOST}
            dangerouslySetInnerHTML={{ __html: safeSvg }}
          />
        )}
      </div>
    </div>
  );
}
