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

import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
};

const SVG_HOST: CSSProperties = {
  maxWidth: "100%",
  maxHeight: "100%",
  // SVGs may not declare a size — give them a sensible cap.
  display: "block",
};

/**
 * Build a same-document URL the `<img>` element can fetch from
 * without blowing the data-URL size limit (some webviews cap at
 * a few MB, which a large animated GIF easily exceeds).
 * `URL.createObjectURL` produces a `blob:` URL with no size cap.
 * Caller is responsible for revoking it on unmount.
 */
function makeBlobUrl(bytes: Uint8Array, mime: string): string {
  // Copy into a fresh ArrayBuffer so the Blob owns the storage
  // — passing the Uint8Array directly would still work, but the
  // Blob can outlive React's render cycle for the bytes.
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/**
 * MIME for a raster image. Magic bytes are authoritative: the
 * bytes know what they are, the filename might lie (or be
 * missing on a piped command). A mis-typed `image/png` on actual
 * GIF bytes is enough for some browsers to refuse the
 * animation, so we never guess from the extension when the
 * bytes are also available.
 *
 * The filename hint is the *fallback* — only consulted when
 * sniffing comes up empty (truncated head, unknown format).
 */
function rasterMime(bytes: Uint8Array, hint: string | null | undefined): string {
  if (bytes.length >= 4) {
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return "image/png";
    }
    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    // GIF: 47 49 46 38 ("GIF8")
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return "image/gif";
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
      return "image/webp";
    }
  }
  if (hint !== null && hint !== undefined) {
    const lower = hint.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
  }
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
  // Build a Blob URL for the raster path. data: URLs have a
  // per-browser size limit (~2 MB in some webviews) that a
  // large animated GIF easily blows; Blob URLs don't. Revoke
  // on unmount or when bytes change so we don't leak.
  const [blobUrl, setBlobUrl] = useState<string>("");
  useEffect(() => {
    if (kind !== "raster") return;
    const url = makeBlobUrl(bytes, rasterMime(bytes, filenameHint));
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
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
          <img data-testid="image-view-img" alt="block output" src={blobUrl} style={IMAGE_STYLE} />
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
