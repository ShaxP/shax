/**
 * PDF viewer (M11.2 + M11.3).
 *
 * Renders a PDF's pages one at a time onto a canvas via
 * pdf.js. Prev/next navigation, keyboard bindings, an inline
 * password prompt for encrypted files, and an in-content
 * text search overlay (⌘F / Ctrl+F) with hit count +
 * next/prev + on-page highlighting via pdf.js's TextLayer.
 *
 * pdfjs-dist is loaded via a dynamic `import()` inside the
 * effect so the ~1 MB minified library only touches the
 * bundle when a user actually opens a PDF. The worker file
 * is imported through Vite's `?url` suffix — that fingerprints
 * the asset and serves it from the same origin, so the
 * webview's CSP never needs relaxing.
 *
 * Contract (unchanged from the M11.1 placeholder):
 * - Takes bytes as `Uint8Array`. Never a `data:` or `blob:`
 *   URL — `data:` hits URL-length limits in some webview
 *   builds, `blob:` requires a lifecycle we don't need.
 * - `password` lives in component state only. Never logged,
 *   persisted, or forwarded past `getDocument({ password })`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

// Vite's `?url` gives us a fingerprinted URL to the worker.
// `pdfjs-dist@6` uses ESM workers, so we pass the URL through
// pdf.js's `GlobalWorkerOptions.workerSrc` and it takes care
// of the rest.
import PdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// ── State machine ─────────────────────────────────────────

type PdfState =
  | { kind: "loading" }
  | { kind: "password-required"; failed: boolean }
  | {
      kind: "loaded";
      doc: PDFDocumentProxy;
      pageCount: number;
      currentPage: number;
    }
  | { kind: "error"; message: string };

// ── Search types (M11.3) ──────────────────────────────────

/** A single search hit: which page it lives on and where in
 *  that page's flat text the match starts + ends. Positions
 *  are half-open: `[startChar, endChar)`. */
interface SearchMatch {
  pageNumber: number;
  startChar: number;
  endChar: number;
}

interface PdfViewProps {
  /**
   * The PDF's raw bytes. Empty (`byteLength === 0`) is a
   * legitimate boot state; the modal may mount `PdfView`
   * before its disk-read override resolves.
   */
  bytes: Uint8Array;
}

// pdfjs-dist doesn't export a stable PasswordException type
// (it's a runtime object with `.name === "PasswordException"`
// and `.code`). Sniff structurally.
function isPasswordException(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" && name === "PasswordException";
}

// Polyfill `ReadableStream[Symbol.asyncIterator]` on WebKit
// builds that don't ship it. pdf.js's `getTextContent`
// internally does `for await (const chunk of stream)`; on
// Safari < 17.4 / macOS < 14.4 (which every Tauri WKWebView
// on those OS versions inherits) that fails with
// "undefined is not a function". The polyfill is spec-shape
// and idempotent — installed at first PdfView mount, no-op
// on modern engines. Reference: whatwg/streams spec + the
// widely-shared MDN example.
function installReadableStreamAsyncIteratorPolyfill(): void {
  if (typeof ReadableStream === "undefined") return;
  const proto = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
  if (Symbol.asyncIterator in proto) return;
  proto[Symbol.asyncIterator] = async function* (
    this: ReadableStream<unknown>,
  ): AsyncGenerator<unknown, void, void> {
    const reader = this.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

// Lazy singleton — pdfjs-dist's `getDocument` needs the worker
// URL set once at module scope, not per-invocation.
let pdfjsModulePromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (pdfjsModulePromise === null) {
    pdfjsModulePromise = (async () => {
      installReadableStreamAsyncIteratorPolyfill();
      const mod = await import("pdfjs-dist");
      mod.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;
      return mod;
    })();
  }
  return pdfjsModulePromise;
}

// ── Styling ───────────────────────────────────────────────

const HOST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  flex: 1,
  background: "var(--pane2)",
  fontFamily: "var(--font-ui)",
};

const TOOLBAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 12px",
  borderBottom: "1px solid var(--border)",
  background: "var(--pane)",
  fontSize: 12,
  color: "var(--fg-dim)",
  flexShrink: 0,
};

const NAV_BUTTON: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border-strong)",
  borderRadius: 4,
  background: "transparent",
  color: "var(--fg)",
  padding: "3px 10px",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "inherit",
};

const NAV_BUTTON_DISABLED: CSSProperties = {
  ...NAV_BUTTON,
  opacity: 0.4,
  cursor: "not-allowed",
};

const PAGE_INDICATOR: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-compact)",
  color: "var(--fg-dim)",
  minWidth: 80,
  textAlign: "center",
};

const SCROLLER: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  display: "flex",
  justifyContent: "center",
  padding: 16,
};

const CENTERED_MESSAGE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "48px 24px",
  color: "var(--fg-dim)",
  fontSize: 13,
  gap: 10,
  minHeight: 240,
  flex: 1,
};

const PWD_INPUT: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border-strong)",
  borderRadius: 4,
  background: "var(--pane)",
  color: "var(--fg)",
  padding: "6px 10px",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  width: 240,
};

// ── Search overlay (M11.3) ────────────────────────────────

const SEARCH_BAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderBottom: "1px solid var(--border)",
  background: "var(--pane)",
  fontSize: 12,
  flexShrink: 0,
};

const SEARCH_INPUT: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border-strong)",
  borderRadius: 4,
  background: "var(--pane2)",
  color: "var(--fg)",
  padding: "4px 8px",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  flex: 1,
  maxWidth: 320,
};

const SEARCH_COUNT: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-compact)",
  color: "var(--fg-dim)",
  minWidth: 60,
  textAlign: "right",
};

// Container for the pdf.js TextLayer: absolute-positioned
// sibling of the canvas, sized to match the CSS-scaled canvas
// dimensions. Transparent text spans live inside, positioned
// per the viewport by pdfjs.TextLayer. Highlights are painted
// on those spans via .highlight / .highlight.current classes
// (see `PDF_TEXT_LAYER_CSS` below).
const TEXT_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  overflow: "hidden",
  opacity: 1,
  lineHeight: 1,
};

const CANVAS_STACK: CSSProperties = {
  position: "relative",
  boxShadow: "0 2px 8px color-mix(in srgb, #000 22%, transparent)",
  background: "#fff",
};

// Inlined so the CSS ships with the component — no extra
// import surface. Applied to a global <style> node once.
const PDF_TEXT_LAYER_CSS = `
.shax-pdf-text-layer {
  position: absolute;
  text-align: initial;
  inset: 0;
  overflow: clip;
  opacity: 1;
  line-height: 1;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  z-index: 2;
}
.shax-pdf-text-layer :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.shax-pdf-text-layer span.shax-pdf-hit {
  background: color-mix(in srgb, var(--amber) 55%, transparent);
  border-radius: 2px;
}
.shax-pdf-text-layer span.shax-pdf-hit-current {
  background: color-mix(in srgb, var(--amber) 90%, transparent);
  outline: 2px solid var(--amber);
  outline-offset: 1px;
}
`;

// One-shot: install the text-layer stylesheet on first
// PdfView mount. Idempotent — we key by an id on the style tag.
function ensureTextLayerCss(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("shax-pdf-text-layer-css") !== null) return;
  const style = document.createElement("style");
  style.id = "shax-pdf-text-layer-css";
  style.textContent = PDF_TEXT_LAYER_CSS;
  document.head.appendChild(style);
}

// ── Component ─────────────────────────────────────────────

export function PdfView({ bytes }: PdfViewProps): React.ReactElement {
  const [state, setState] = useState<PdfState>({ kind: "loading" });
  // Password attempt is state so setting it re-triggers the
  // load effect. Kept as state, not ref, precisely because the
  // effect needs it in its dependency array to re-fire on a
  // password submit.
  const [passwordAttempt, setPasswordAttempt] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // TextLayer overlay div sitting on top of the canvas —
  // pdf.js positions transparent text spans in here per the
  // page's viewport. Enables both native text selection and
  // M11.3's search-hit highlights.
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  // Current in-flight render, so a rapid prev→next→prev can
  // cancel the previous canvas draw instead of racing it.
  const activeRenderRef = useRef<RenderTask | null>(null);
  // Track the current page's rendered scale so highlight
  // positioning + coordinate-space math stay consistent
  // between the canvas render effect and the highlight effect.
  const currentPageScaleRef = useRef<number>(1);

  // M11.3 search state
  //
  // `pageTexts[i]` is page (i+1)'s flat, whitespace-normalised
  // text. `null` while background extraction is in flight.
  // `extractionError` is set when a page's getPage /
  // getTextContent throws — search then reports "Search
  // unavailable" instead of eternal "Indexing…". Extraction
  // runs once per loaded document.
  const [pageTexts, setPageTexts] = useState<string[] | null>(null);
  const [extractionProgress, setExtractionProgress] = useState(0);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    ensureTextLayerCss();
  }, []);

  // Load (or reload after a password attempt) the document.
  useEffect(() => {
    if (bytes.byteLength === 0) return;
    let cancelled = false;
    setState({ kind: "loading" });

    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // `getDocument` mutates the bytes buffer internally,
        // so hand it a slice we own — otherwise a re-render
        // with the same underlying ArrayBuffer would fail.
        const task = pdfjs.getDocument({
          data: bytes.slice(0),
          password: passwordAttempt ?? undefined,
        });
        const doc = await task.promise;
        if (cancelled) {
          void doc.cleanup();
          return;
        }
        setState({
          kind: "loaded",
          doc,
          pageCount: doc.numPages,
          currentPage: 1,
        });
      } catch (err) {
        if (cancelled) return;
        if (isPasswordException(err)) {
          setState({
            kind: "password-required",
            failed: passwordAttempt !== null,
          });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bytes, passwordAttempt]);

  // Destroy the document on unmount / bytes-change so pdf.js's
  // worker doesn't hold onto a doc we've replaced.
  useEffect(() => {
    return () => {
      if (state.kind === "loaded") {
        void state.doc.cleanup();
      }
      if (activeRenderRef.current !== null) {
        activeRenderRef.current.cancel();
        activeRenderRef.current = null;
      }
    };
    // Only run on unmount — destroying on every state change
    // would tear down the doc we just loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // M11.3: extract every page's text once after the document
  // loads. Runs in the background (setState resolves after all
  // pages complete). Small PDFs finish in tens of ms; a
  // 500-page PDF takes a couple of seconds. The search UI
  // shows an "Indexing…" hint while pageTexts is null.
  //
  // Deps are `[loadedDoc, loadedPageCount]`, NOT `[state]`.
  // Depending on the whole state object re-fired extraction
  // on every page navigation — and since the search-jump
  // effect (which flips currentPage when a match lives on
  // another page) fires once extraction completes, a
  // completed extraction would restart itself in an
  // infinite loop. `state.doc` reference is stable across
  // page navigations; only a new document changes it.
  const loadedDoc = state.kind === "loaded" ? state.doc : null;
  const loadedPageCount = state.kind === "loaded" ? state.pageCount : 0;
  useEffect(() => {
    if (loadedDoc === null) return;
    let cancelled = false;
    setPageTexts(null);
    setExtractionProgress(0);
    setExtractionError(null);
    void (async () => {
      const texts: string[] = [];
      try {
        for (let i = 1; i <= loadedPageCount; i++) {
          if (cancelled) return;
          const page = await loadedDoc.getPage(i);
          if (cancelled) return;
          const content = await page.getTextContent();
          if (cancelled) return;
          // Concatenate every text item with a space between;
          // the exact whitespace shape doesn't matter for
          // substring search, only that adjacent items don't
          // glue together (which would let `foo` fail to
          // match `fooBAR` split into two items).
          const flat = content.items
            .map((it) =>
              typeof (it as { str?: unknown }).str === "string" ? (it as { str: string }).str : "",
            )
            .filter((s) => s.length > 0)
            .join(" ");
          texts.push(flat);
          setExtractionProgress(i);
        }
        if (cancelled) return;
        setPageTexts(texts);
      } catch (err) {
        if (cancelled) return;
        // Silent-failure was the M11.3 bug that stuck the
        // indexer at "Indexing…" forever: a single-page
        // throw ended the loop and no state was ever set.
        // Now we surface it — the search UI shows "Search
        // unavailable" and the console carries the detail.
        console.warn("[PdfView] text extraction failed:", err);
        const message = err instanceof Error ? err.message : String(err);
        setExtractionError(message);
        setPageTexts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadedDoc, loadedPageCount]);

  // M11.3: match computation. Case-insensitive substring
  // search over each page's flat text. `null` when query is
  // empty or too short (single-char queries would return
  // thousands of hits on any doc).
  const matches: SearchMatch[] = useMemo(() => {
    if (pageTexts === null) return [];
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: SearchMatch[] = [];
    for (let pi = 0; pi < pageTexts.length; pi++) {
      const hay = pageTexts[pi]?.toLowerCase() ?? "";
      let start = 0;
      while (true) {
        const idx = hay.indexOf(q, start);
        if (idx === -1) break;
        out.push({
          pageNumber: pi + 1,
          startChar: idx,
          endChar: idx + q.length,
        });
        start = idx + q.length;
      }
    }
    return out;
  }, [pageTexts, searchQuery]);

  // Reset searchIndex if the current index falls off the end
  // of a shortened matches list (e.g. user extended the query).
  useEffect(() => {
    if (matches.length === 0) return;
    if (searchIndex >= matches.length) setSearchIndex(0);
  }, [matches, searchIndex]);

  // Jump to the page containing the current match. Scroll to
  // the top of the scroller (we'll refine to hit-position in
  // the highlight effect once the text layer is rendered).
  useEffect(() => {
    if (matches.length === 0) return;
    const target = matches[searchIndex];
    if (target === undefined) return;
    setState((prev) => {
      if (prev.kind !== "loaded") return prev;
      if (prev.currentPage === target.pageNumber) return prev;
      return { ...prev, currentPage: target.pageNumber };
    });
  }, [matches, searchIndex]);

  // Render the current page whenever it changes or the doc
  // (re)loads. Mounts both the canvas raster AND the TextLayer
  // overlay used for native selection + M11.3 search-hit
  // highlighting.
  useEffect(() => {
    if (state.kind !== "loaded") return;
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    const textLayerEl = textLayerRef.current;
    if (canvas === null || scroller === null) return;
    let cancelled = false;

    void (async () => {
      const pdfjs = await loadPdfjs();
      if (cancelled) return;
      const page = await state.doc.getPage(state.currentPage);
      if (cancelled) return;
      // Fit-to-width: pick a scale so the page's unrotated
      // width matches the scroller's available width (minus a
      // little padding). devicePixelRatio keeps the raster
      // crisp on retina.
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(200, scroller.clientWidth - 32);
      const cssScale = availableWidth / baseViewport.width;
      currentPageScaleRef.current = cssScale;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: cssScale * dpr });
      // TextLayer uses the CSS-space viewport (no dpr) so its
      // spans line up with the visually-sized canvas.
      const cssViewport = page.getViewport({ scale: cssScale });
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;

      // Cancel any in-flight render before starting a new one.
      if (activeRenderRef.current !== null) {
        activeRenderRef.current.cancel();
      }
      const task = page.render({ canvasContext: ctx, viewport, canvas });
      activeRenderRef.current = task;
      try {
        await task.promise;
      } catch (err) {
        // A cancelled render throws; that's expected on rapid
        // navigation. Anything else is a real error.
        if ((err as { name?: string } | null)?.name !== "RenderingCancelledException") {
          throw err;
        }
        return;
      } finally {
        if (activeRenderRef.current === task) {
          activeRenderRef.current = null;
        }
      }

      // Build the TextLayer over the canvas. Clear any prior
      // page's spans first, then let pdf.js re-populate.
      //
      // pdf.js v6 sizes the container via
      // `round(down, var(--total-scale-factor) * pageWidth,
      // var(--scale-round-x))` (see `setLayerDimensions` in
      // the pdfjs bundle). If those CSS custom properties
      // aren't set on the container, the `var()` collapses to
      // nothing, the `round()` becomes invalid, the container
      // renders 0×0, and every span's absolute position lands
      // in the wrong place — the classic "highlights in the
      // wrong spot" bug. Setting them explicitly restores
      // correct positioning.
      if (textLayerEl !== null) {
        textLayerEl.textContent = "";
        textLayerEl.style.setProperty("--scale-factor", String(cssScale));
        textLayerEl.style.setProperty("--total-scale-factor", String(cssScale));
        textLayerEl.style.setProperty("--scale-round-x", "1px");
        textLayerEl.style.setProperty("--scale-round-y", "1px");
        try {
          const textContent = await page.getTextContent();
          if (cancelled) return;
          const textLayer = new pdfjs.TextLayer({
            textContentSource: textContent,
            container: textLayerEl,
            viewport: cssViewport,
          });
          await textLayer.render();
        } catch {
          // Text layer failures are cosmetic — the canvas
          // render is what matters. Swallow and move on.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state]);

  // M11.3: after the text layer renders (or when the query /
  // current match changes), walk its spans and toggle
  // highlight classes. This runs on every relevant state
  // change so pagination re-applies highlights against the
  // freshly-built spans.
  useEffect(() => {
    const el = textLayerRef.current;
    if (el === null) return;
    if (state.kind !== "loaded") return;
    const q = searchQuery.trim().toLowerCase();
    const spans = el.querySelectorAll<HTMLSpanElement>("span");
    // Clear previous highlights up front so a shortened query
    // (or closed search) leaves nothing stale behind.
    spans.forEach((s) => {
      s.classList.remove("shax-pdf-hit");
      s.classList.remove("shax-pdf-hit-current");
    });
    if (q.length < 2 || !searchOpen) return;
    // Which hit on this page corresponds to the currently-
    // selected global match? Count matches on preceding pages
    // to compute the local index, then walk spans and count
    // hits within them until we reach that index.
    const currentMatch = matches[searchIndex];
    let currentLocalHitIdx = -1;
    if (currentMatch !== undefined && currentMatch.pageNumber === state.currentPage) {
      let count = 0;
      for (let i = 0; i < searchIndex; i++) {
        if (matches[i]?.pageNumber === state.currentPage) count++;
      }
      currentLocalHitIdx = count;
    }
    let localHit = 0;
    spans.forEach((span) => {
      const text = span.textContent ?? "";
      if (text.length === 0) return;
      // Simple contains-check: paint the whole span if any
      // occurrence of the query lives inside it. For M11.3
      // v1, we intentionally don't split spans at match
      // boundaries — that would need pdf.js's own text-
      // divs-splitter and is measurably heavier. Users see a
      // slightly wider highlight than the exact hit; still
      // reads correctly.
      if (text.toLowerCase().includes(q)) {
        span.classList.add("shax-pdf-hit");
        if (localHit === currentLocalHitIdx) {
          span.classList.add("shax-pdf-hit-current");
          span.scrollIntoView({ block: "center", behavior: "auto" });
        }
        localHit++;
      }
    });
  }, [state, searchQuery, searchOpen, matches, searchIndex]);

  const goToPage = useCallback((next: number): void => {
    setState((prev) => {
      if (prev.kind !== "loaded") return prev;
      const clamped = Math.max(1, Math.min(prev.pageCount, next));
      if (clamped === prev.currentPage) return prev;
      return { ...prev, currentPage: clamped };
    });
  }, []);

  // Keyboard navigation. Only active while the pane owns
  // keydown — the modal shell handles Escape.
  //
  // Two axes:
  //   - Page-level (change PDF page): ← / → and ⌘←/⌘→ jump
  //     to first / last.
  //   - Scroll-level (within the current page): ↑ / ↓
  //     scroll a small amount; PageUp / PageDown scroll a
  //     viewport height; Home / End jump to top / bottom.
  //     Space acts like PageDown (matches every native PDF
  //     viewer).
  const advanceMatch = useCallback(
    (delta: 1 | -1): void => {
      setSearchIndex((prev) => {
        if (matches.length === 0) return prev;
        const next = (prev + delta + matches.length) % matches.length;
        return next;
      });
    },
    [matches.length],
  );

  useEffect(() => {
    if (state.kind !== "loaded") return;
    const SCROLL_STEP = 60; // ↑/↓ nudge, in CSS px.
    const handler = (e: KeyboardEvent): void => {
      const scroller = scrollerRef.current;
      // M11.3: ⌘F / Ctrl+F opens the search box and focuses
      // its input. Repeated ⌘F while open jumps to the next
      // match (like every browser's find bar).
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        if (searchOpen) {
          advanceMatch(1);
        } else {
          setSearchOpen(true);
          // Focus the input on the next microtask so the
          // element has mounted.
          queueMicrotask(() => searchInputRef.current?.focus());
        }
        return;
      }
      // Escape closes search. Do this BEFORE other key
      // handling so the pane's normal Esc-handling (if any)
      // doesn't run through.
      if (e.key === "Escape" && searchOpen) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(false);
        return;
      }
      // If the search input is focused, hand everything else
      // through so the user can type freely. Enter navigates.
      const target = e.target as HTMLElement | null;
      if (target !== null && target === searchInputRef.current) {
        if (e.key === "Enter") {
          e.preventDefault();
          advanceMatch(e.shiftKey ? -1 : 1);
        }
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPage(e.metaKey || e.ctrlKey ? 1 : state.currentPage - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToPage(e.metaKey || e.ctrlKey ? state.pageCount : state.currentPage + 1);
      } else if (scroller !== null && e.key === "ArrowDown") {
        e.preventDefault();
        scroller.scrollBy({ top: SCROLL_STEP });
      } else if (scroller !== null && e.key === "ArrowUp") {
        e.preventDefault();
        scroller.scrollBy({ top: -SCROLL_STEP });
      } else if (scroller !== null && (e.key === "PageDown" || e.key === " ")) {
        e.preventDefault();
        // Reading flow: if already at the bottom of the
        // current page's scroll, advance to the next PDF
        // page (scrolled to top by the render effect).
        // Threshold of 2 px absorbs sub-pixel rounding.
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        if (atBottom && state.currentPage < state.pageCount) {
          goToPage(state.currentPage + 1);
          scroller.scrollTo({ top: 0 });
        } else {
          scroller.scrollBy({ top: scroller.clientHeight * 0.9 });
        }
      } else if (scroller !== null && e.key === "PageUp") {
        e.preventDefault();
        const atTop = scroller.scrollTop <= 2;
        if (atTop && state.currentPage > 1) {
          goToPage(state.currentPage - 1);
          // Jump to bottom of the just-loaded prev page. The
          // render effect writes canvas dimensions
          // synchronously; scrollHeight is available on the
          // next microtask.
          queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight }));
        } else {
          scroller.scrollBy({ top: -scroller.clientHeight * 0.9 });
        }
      } else if (scroller !== null && e.key === "Home") {
        e.preventDefault();
        scroller.scrollTo({ top: 0 });
      } else if (scroller !== null && e.key === "End") {
        e.preventDefault();
        scroller.scrollTo({ top: scroller.scrollHeight });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state, goToPage, searchOpen, advanceMatch]);

  // ── Renderers ─────────────────────────────────────────

  if (state.kind === "loading") {
    return (
      <div data-testid="pdf-view-loading" style={CENTERED_MESSAGE}>
        <div>Loading PDF…</div>
      </div>
    );
  }

  if (state.kind === "password-required") {
    return (
      <PasswordPrompt
        failed={state.failed}
        onSubmit={(pw) => {
          // Setting passwordAttempt re-fires the load effect
          // above (it's in the deps). The effect flips state
          // to "loading" itself; we don't need to force it
          // here.
          setPasswordAttempt(pw);
        }}
      />
    );
  }

  if (state.kind === "error") {
    return (
      <div data-testid="pdf-view-error" style={CENTERED_MESSAGE}>
        <div style={{ color: "var(--red)", fontWeight: 500 }}>Couldn&apos;t open PDF</div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-compact)",
            color: "var(--fg-faint)",
          }}
        >
          {state.message}
        </div>
      </div>
    );
  }

  // Loaded — render toolbar + canvas.
  const atFirst = state.currentPage <= 1;
  const atLast = state.currentPage >= state.pageCount;
  return (
    <div style={HOST} data-testid="pdf-view">
      <div style={TOOLBAR}>
        <button
          type="button"
          onClick={() => goToPage(state.currentPage - 1)}
          disabled={atFirst}
          style={atFirst ? NAV_BUTTON_DISABLED : NAV_BUTTON}
          aria-label="Previous page"
          data-testid="pdf-prev"
        >
          ‹ Prev
        </button>
        <span style={PAGE_INDICATOR} data-testid="pdf-page-indicator">
          {state.currentPage} / {state.pageCount}
        </span>
        <button
          type="button"
          onClick={() => goToPage(state.currentPage + 1)}
          disabled={atLast}
          style={atLast ? NAV_BUTTON_DISABLED : NAV_BUTTON}
          aria-label="Next page"
          data-testid="pdf-next"
        >
          Next ›
        </button>
      </div>
      {searchOpen && (
        <div style={SEARCH_BAR} data-testid="pdf-search-bar">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search PDF…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchIndex(0);
            }}
            style={SEARCH_INPUT}
            data-testid="pdf-search-input"
            spellCheck={false}
            autoComplete="off"
          />
          <span
            style={SEARCH_COUNT}
            data-testid="pdf-search-count"
            title={extractionError ?? undefined}
          >
            {extractionError !== null
              ? "unavailable"
              : pageTexts === null
                ? loadedPageCount > 0
                  ? `Indexing ${extractionProgress}/${loadedPageCount}…`
                  : "Indexing…"
                : searchQuery.trim().length < 2
                  ? "type ≥ 2 chars"
                  : matches.length === 0
                    ? "0"
                    : `${searchIndex + 1} of ${matches.length}`}
          </span>
          <button
            type="button"
            onClick={() => advanceMatch(-1)}
            disabled={matches.length === 0}
            style={matches.length === 0 ? NAV_BUTTON_DISABLED : NAV_BUTTON}
            aria-label="Previous match"
            data-testid="pdf-search-prev"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => advanceMatch(1)}
            disabled={matches.length === 0}
            style={matches.length === 0 ? NAV_BUTTON_DISABLED : NAV_BUTTON}
            aria-label="Next match"
            data-testid="pdf-search-next"
          >
            ›
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(false)}
            style={NAV_BUTTON}
            aria-label="Close search"
            data-testid="pdf-search-close"
          >
            ✕
          </button>
        </div>
      )}
      <div style={SCROLLER} ref={scrollerRef}>
        <div style={CANVAS_STACK}>
          <canvas ref={canvasRef} data-testid="pdf-canvas" />
          <div
            ref={textLayerRef}
            className="shax-pdf-text-layer"
            style={TEXT_LAYER_STYLE}
            data-testid="pdf-text-layer"
          />
        </div>
      </div>
    </div>
  );
}

// ── Password prompt ───────────────────────────────────────

function PasswordPrompt({
  failed,
  onSubmit,
}: {
  failed: boolean;
  onSubmit: (password: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState("");
  return (
    <form
      data-testid="pdf-password-prompt"
      style={CENTERED_MESSAGE}
      onSubmit={(e) => {
        e.preventDefault();
        if (value.length > 0) onSubmit(value);
      }}
    >
      <div style={{ color: "var(--fg)", fontWeight: 500 }}>
        {failed ? "Incorrect password. Try again:" : "This PDF is password-protected."}
      </div>
      <input
        type="password"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Password"
        style={PWD_INPUT}
        data-testid="pdf-password-input"
      />
      <button
        type="submit"
        style={NAV_BUTTON}
        disabled={value.length === 0}
        data-testid="pdf-password-submit"
      >
        Unlock
      </button>
    </form>
  );
}
