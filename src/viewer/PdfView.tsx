/**
 * PDF viewer (M11.2).
 *
 * Renders a PDF's pages one at a time onto a canvas via
 * pdf.js. Prev/next navigation, keyboard bindings, and an
 * inline password prompt for encrypted files. Search lands
 * in M11.3.
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

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
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

// Lazy singleton — pdfjs-dist's `getDocument` needs the worker
// URL set once at module scope, not per-invocation.
let pdfjsModulePromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (pdfjsModulePromise === null) {
    pdfjsModulePromise = (async () => {
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

const CANVAS_WRAPPER: CSSProperties = {
  boxShadow: "0 2px 8px color-mix(in srgb, #000 22%, transparent)",
  background: "#fff",
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
  // Current in-flight render, so a rapid prev→next→prev can
  // cancel the previous canvas draw instead of racing it.
  const activeRenderRef = useRef<RenderTask | null>(null);

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

  // Render the current page whenever it changes or the doc
  // (re)loads.
  useEffect(() => {
    if (state.kind !== "loaded") return;
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    if (canvas === null || scroller === null) return;
    let cancelled = false;

    void (async () => {
      const page = await state.doc.getPage(state.currentPage);
      if (cancelled) return;
      // Fit-to-width: pick a scale so the page's unrotated
      // width matches the scroller's available width (minus a
      // little padding). devicePixelRatio keeps the raster
      // crisp on retina.
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(200, scroller.clientWidth - 32);
      const cssScale = availableWidth / baseViewport.width;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: cssScale * dpr });
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
      } finally {
        if (activeRenderRef.current === task) {
          activeRenderRef.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state]);

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
  useEffect(() => {
    if (state.kind !== "loaded") return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPage(e.metaKey || e.ctrlKey ? 1 : state.currentPage - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToPage(e.metaKey || e.ctrlKey ? state.pageCount : state.currentPage + 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state, goToPage]);

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
      <div style={SCROLLER} ref={scrollerRef}>
        <div style={CANVAS_WRAPPER}>
          <canvas ref={canvasRef} data-testid="pdf-canvas" />
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
