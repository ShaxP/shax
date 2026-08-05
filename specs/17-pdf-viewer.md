# 17 PDF viewer

Peek a PDF inline instead of shelling out to Preview / a browser. Extends the viewer stack (`06`) with one more content type. Same modal surface, same magic-byte / extension detection pipeline that already routes images and Markdown.

Grows out of `06-file-viewer.md` and `02-rendering-two-path.md`. This spec is the shape one level up: how a PDF becomes a block, how it renders, what features v1 carries.

## What a PDF viewer is (and isn't)

- A **read-only, in-modal renderer** for PDF bytes. Multi-page navigation, in-content text search, password prompt for encrypted files. Rendered by **pdf.js** (Mozilla, Apache 2.0, ~1 MB minified) on a canvas per page.
- **Modal only** in v1. A PDF opens in `BlockViewerModal` when the user activates it; it does **not** render inline in a block card. PDFs are page-oriented and multi-page — inline would fight the block-stack layout and force awkward promotion decisions. Same discipline as images: block-list holds a hint, viewer holds the render.
- **Not** an editor. No form-filling, no annotation, no signing. Users who need those go to a real PDF app.
- **Not** an office-format viewer. `.docx` / `.xlsx` / `.pptx` remain out of scope per the roadmap seed's Post-M8 note — the open-source library landscape doesn't hit the quality bar and delegating to the OS is the honest terminal-first answer.

## Detection and entry paths

Three entry paths, all funnelling into the same `contentType === "pdf"` routing in `BlockViewerModal`.

1. **Magic-byte detection on any block** — the primary path. `detectContentType.ts` (already home to PNG / JPEG / GIF / SVG detection) grows a `pdfFromMagicBytes` peer that checks the first four bytes for `%PDF` (`0x25 0x50 0x44 0x46`). ContentType `"pdf"` joins the union. Every block whose captured bytes begin with the PDF header becomes viewable — `cat file.pdf`, `curl -sO ... && cat`, `git show <blob>`, anything.
2. **Filename extension** — `EXTENSION_MAP.pdf = "pdf"` covers the disk-read override path (viewer opens the file fresh, not the captured stdout). Belt-and-braces alongside the magic bytes.
3. **`ls` widget click** — the ls widget's file rows already offer "open in viewer" for text; the same action routes `.pdf` files into the modal via the disk-read path.

The block card's promotion-gate affordance (currently "View as image" / "View as file" for those content types) grows a "View as PDF" variant. Same call site, same one-tap flow.

## What the backend owns

Almost nothing new. The existing `read_file_bytes` IPC (used by the disk-read override in `BlockViewerModal`) returns whatever bytes the file holds; pdf.js does the rest in the webview. No Rust-side PDF parsing, no server component.

The one addition: the block store already retains full output bytes for a bounded window; PDFs are typically <5 MB so they fit comfortably. A PDF larger than the store's current cap (16 MiB) falls through to disk-read via `read_file_bytes` — same fallback the image viewer uses today.

## What the frontend owns

### New: `<PdfView>` component

A new `src/viewer/PdfView.tsx`, sitting next to `MarkdownView` and `HexView` in the routing surface. Props:

```ts
interface PdfViewProps {
  bytes: Uint8Array;
  /** Passed to pdf.js for encrypted PDFs. Absent = try without. */
  password?: string;
}
```

Internally:

- Loads `pdfjs-dist` lazily (`await import(...)`) so pdf.js's ~1 MB doesn't touch the initial bundle.
- Sets `GlobalWorkerOptions.workerSrc` to the worker file we ship as a resource. Worker isolates parse + render off the main thread.
- Calls `getDocument({ data: bytes, password })` and renders each page's canvas on demand as the user navigates.
- Handles `PasswordException` by rendering a password input in-place; retries on submit.

### Routing

`BlockViewerModal.contentType` gains a `"pdf"` branch that mounts `<PdfView>`. Same shape as the existing `image` / `svg` / `markdown` branches — no routing surgery, one more `contentType === "pdf"` conditional.

### Modal chrome

The modal's existing header + close button stay. New v1 additions **inside** the pdf view:

- **Page navigation** — prev / next buttons, current-page indicator, page count, keyboard bindings (`←` / `→` prev / next, `⌘←` / `⌘→` first / last).
- **Text search** — `⌘F` opens an in-modal search box, `Enter` jumps to the next match, `⇧Enter` previous, hit-count indicator, `Esc` closes. pdf.js's `getTextContent` per page powers the match set; overlays highlight hits on the rendered canvas.
- **Password prompt** — inline `<input type="password">` + submit inside the modal body when `getDocument` throws `PasswordException`. No modal-on-modal — the prompt lives inside the same modal surface.

## Out of scope for v1

Called out explicitly so users know what's coming next vs. what won't:

- **Zoom / fit-width toggle.** v1 renders at a fixed fit-to-width based on the modal's current width. Zoom controls (in / out / reset / fit-width toggle) are a follow-up slice — the render pipeline supports it, the UI doesn't ship it. Defer until users hit small-print PDFs and complain.
- **Copy text from the PDF.** pdf.js's `getTextContent` extracts text per page (already used for search), so wiring copy is small. Deferred to keep v1 focused on peek-through, not editing / extraction.
- **Annotations, form fields, signatures.** Full annotation layer support in pdf.js is real work; users who need it use a real app.
- **Print.** Browsers can print any rendered page via `⌘P`; we don't need to ship UI for it.
- **PDF/A validation, digital-signature verification.** Out of scope.

## The things that actually bite, in order

1. **Bundle size.** `pdfjs-dist` is ~1 MB minified. If it lands in the initial bundle every launch is slower for users who never open a PDF. Lazy-import inside `PdfView` (dynamic `import()`), gated by the `contentType === "pdf"` branch. Every other content type stays as fast as today.
2. **Worker script path.** pdf.js requires a worker; `GlobalWorkerOptions.workerSrc` must resolve to a URL the webview can load. Bundle the worker as a Vite asset (`?url` import) so Vite fingerprints it and serves it from the same origin — no CSP relaxation.
3. **Password-exception ordering.** `getDocument().promise` rejects synchronously with `PasswordException` if the PDF is encrypted; the retry path re-calls `getDocument` with the new password. Getting the state machine right (idle → loading → password-required → loading with password → loaded) is where PDF viewers get bugs — one state enum, one reducer, one render tree keyed off it.
4. **Search-highlight rendering.** pdf.js renders pages to a `<canvas>`, and highlights live in a sibling `<div>` positioned over the canvas using per-glyph transform matrices from `getTextContent`. Coordinate-space mismatches are the classic bug — do it via pdf.js's own `TextLayerBuilder` rather than a hand-rolled overlay.
5. **Very-large-page memory.** A 400-page PDF fully rendered at once holds hundreds of canvases. Render on-demand (current page + one adjacent for smooth prev/next), dispose off-screen canvases when scrolling past them. pdf.js's viewer components already do this if we use them; a hand-rolled loop needs the discipline.
6. **Encrypted-PDF telemetry footgun.** Never log or persist the password. It stays in the component's state, sent only to pdf.js's `getDocument({ password })`. Not to the backend, not to logs, not to the block store.
7. **File-scheme edge case.** pdf.js can load from `data:`, `blob:`, or `Uint8Array`. Always use `Uint8Array` — `data:` URLs for a 5 MB PDF hit URL-length limits in some webview builds, and `blob:` requires a URL.createObjectURL/revoke lifecycle we don't need.

## Interaction with existing surfaces

- **BlockViewerModal (`06`).** Gains one `contentType === "pdf"` branch. No structural change; PDF sits alongside image / svg / markdown.
- **`detectContentType.ts` (`06`).** Gains `pdfFromMagicBytes` peer + `pdf` in `EXTENSION_MAP` + `"pdf"` in the `ContentType` union.
- **Block-card promotion (`02`).** The "View as X" affordance in the block card grows a "View as PDF" variant. Same activation flow.
- **ls widget (`08`).** File rows that match `.pdf` gain the same "open in viewer" action they already offer for text files.
- **Safety gate (`10`).** Not involved — viewing a PDF is a read-only rendering, not a shell action. The gate protects side effects; there are none here.
- **Themes / fonts (`16`).** pdf.js renders the PDF's own fonts and colors — no theme integration; a Solarized-Dark preset doesn't recolour a PDF. Modal chrome around the render (page counter, search box, password prompt) reads the active theme's chrome tokens like every other modal.

## Slice map

Three slices, each landable independently.

- **M11.1 — Detection + routing.** Extend `detectContentType.ts` with `pdfFromMagicBytes` and the `pdf` extension + `ContentType` union entry. Add a `contentType === "pdf"` branch to `BlockViewerModal` that mounts a placeholder `<PdfView>` (renders "PDF viewer coming" for now). Ships the pipeline; no pdf.js yet.
- **M11.2 — pdf.js render + page navigation.** Real `<PdfView>` with lazy import of `pdfjs-dist`, worker wiring, single-page render, prev/next buttons + keyboard bindings + page counter. Password prompt for encrypted PDFs (`PasswordException` handling). Ships the "view a PDF" feature without search.
- **M11.3 — In-content text search.** `⌘F` search box, `TextLayerBuilder`-driven highlight, next / previous, hit counter. Ships the "find text in a PDF" feature.

## Explicitly out of scope (repeated for the read-through)

- Zoom / fit controls beyond fit-to-width.
- Copy-text.
- Annotations, form fields, signatures.
- Print UI (browser handles it).
- Office formats (`.docx` / `.xlsx` / `.pptx`).

## Cross-references

- `02-rendering-two-path.md` — the two-path model + promotion gate that decides when a block can offer "View as PDF".
- `06-file-viewer.md` — the ContentView / BlockViewerModal routing PDF plugs into.
- `08-interactive-widgets.md` — the ls widget's "open in viewer" action extension point.
- `10-safety-and-permissions.md` — cross-ref only; PDF rendering doesn't touch the gate.
- `11-tech-stack-and-conventions.md` — where the new `pdfjs-dist` dependency slots in.
- `12-roadmap-milestones.md` — M11 entry + the deferred zoom / copy-text follow-ups.
