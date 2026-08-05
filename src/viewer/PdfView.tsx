/**
 * PDF viewer (M11).
 *
 * M11.1 ships this as a placeholder — it renders "PDF viewer
 * coming in M11.2" so the routing wiring in `BlockViewerModal`
 * can land + be tested without pulling `pdfjs-dist` into the
 * bundle yet. M11.2 replaces the body with a real pdf.js render
 * + page navigation + password prompt. M11.3 layers text search
 * on top.
 *
 * Contract:
 *
 * - Takes the PDF bytes as a `Uint8Array` (never a `data:` URL
 *   or a `blob:` URL — those hit URL-length limits in some
 *   webview builds and require a lifecycle we don't need).
 * - Never logs, persists, or forwards `password` beyond the
 *   pdf.js `getDocument({ password })` call. Kept as component
 *   state only.
 * - Modal-only surface. No inline-in-block render in v1.
 */

import type { CSSProperties } from "react";

interface PdfViewProps {
  /**
   * The PDF's raw bytes. Empty (`byteLength === 0`) is a
   * legitimate state — the modal may mount `PdfView` before
   * its disk-read override resolves.
   */
  bytes: Uint8Array;
}

const HOST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "48px 24px",
  color: "var(--fg-dim)",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  textAlign: "center",
  gap: 6,
  minHeight: 240,
};

const HEADLINE: CSSProperties = {
  color: "var(--fg)",
  fontWeight: 500,
};

const META: CSSProperties = {
  color: "var(--fg-faint)",
  fontSize: 11.5,
};

export function PdfView({ bytes }: PdfViewProps): React.ReactElement {
  const kib = Math.max(1, Math.round(bytes.byteLength / 1024));
  return (
    <div data-testid="pdf-view-placeholder" style={HOST}>
      <div style={HEADLINE}>PDF viewer coming in M11.2</div>
      <div style={META}>
        {bytes.byteLength === 0
          ? "no bytes loaded yet"
          : `${kib.toLocaleString()} KiB PDF detected`}
      </div>
    </div>
  );
}
