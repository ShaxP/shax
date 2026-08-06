/**
 * M11.2 sanity tests for PdfView.
 *
 * pdf.js itself is mocked — the real worker + canvas rendering
 * lives in a real browser (Playwright-driven smoke tests would
 * cover that in a future slice). These tests cover the state
 * machine + password prompt UI without exercising the worker.
 *
 * The Vite `?url` import for the worker file is mocked as a
 * bare string; vitest under jsdom can't resolve the query
 * suffix.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

// ── Mocks ──────────────────────────────────────────────────

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "mock-worker-url",
}));

const mockGetDocument = vi.fn();

// TextLayer is a stub — we only assert it's constructed +
// `.render()` is called. jsdom doesn't paint the spans
// anyway, so search highlight visuals aren't exercised here.
class MockTextLayer {
  constructor(_opts: unknown) {
    void _opts;
  }
  render(): Promise<void> {
    return Promise.resolve();
  }
}

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (options: unknown): { promise: Promise<unknown> } => ({
    promise: mockGetDocument(options) as Promise<unknown>,
  }),
  TextLayer: MockTextLayer,
}));

// Imported after the mock so PdfView's dynamic import resolves
// to the mock module.
import { PdfView } from "./PdfView";

// ── Fixtures ───────────────────────────────────────────────

function makeMockPage(text: string = "") {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 130 * scale,
    }),
    render: () => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }),
    // M11.3: search extracts text from every page. Return one
    // item so `text` shows up in the flat pageText string.
    getTextContent: () =>
      Promise.resolve({
        items: text === "" ? [] : [{ str: text }],
      }),
  };
}

function makeMockDoc(numPages: number, pageTexts: readonly string[] = []) {
  return {
    numPages,
    getPage: vi
      .fn()
      .mockImplementation((n: number) => Promise.resolve(makeMockPage(pageTexts[n - 1] ?? ""))),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

class PasswordException extends Error {
  code = 1;
  constructor(message: string) {
    super(message);
    this.name = "PasswordException";
  }
}

// jsdom doesn't implement canvas; give it a minimal 2d
// context stub so `canvas.getContext("2d")` returns something
// truthy for PdfView's render effect.
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({});
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 1,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────

describe("PdfView", () => {
  it("shows a loading state while the document opens", () => {
    // Never-resolving promise keeps us in the loading state.
    mockGetDocument.mockReturnValue(new Promise(() => undefined));
    render(<PdfView bytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />);
    expect(screen.getByTestId("pdf-view-loading")).toBeInTheDocument();
  });

  it("renders the toolbar + page indicator when the document loads", async () => {
    mockGetDocument.mockResolvedValue(makeMockDoc(3));
    render(<PdfView bytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-view")).toBeInTheDocument();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("1 / 3");
  });

  it("Next advances the page", async () => {
    mockGetDocument.mockResolvedValue(makeMockDoc(3));
    render(<PdfView bytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("pdf-next"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("2 / 3");
  });

  it("Prev is disabled on the first page", async () => {
    mockGetDocument.mockResolvedValue(makeMockDoc(3));
    render(<PdfView bytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId<HTMLButtonElement>("pdf-prev").disabled).toBe(true);
  });

  it("prompts for a password on PasswordException", async () => {
    mockGetDocument.mockRejectedValueOnce(new PasswordException("locked"));
    render(<PdfView bytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-password-prompt")).toBeInTheDocument();
    expect(screen.getByTestId("pdf-password-prompt")).toHaveTextContent(/password-protected/i);
  });

  it("re-attempts the load with the submitted password", async () => {
    mockGetDocument
      .mockRejectedValueOnce(new PasswordException("locked"))
      .mockResolvedValueOnce(makeMockDoc(1));
    render(<PdfView bytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Submit a password.
    const input = screen.getByTestId<HTMLInputElement>("pdf-password-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "hunter2" } });
      fireEvent.click(screen.getByTestId("pdf-password-submit"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // getDocument was called twice — once without a password,
    // once with. That's the whole state-machine round trip.
    expect(mockGetDocument).toHaveBeenCalledTimes(2);
    const secondCall = mockGetDocument.mock.calls[1]?.[0] as { password?: string };
    expect(secondCall.password).toBe("hunter2");
  });

  it("shows an error state for non-password failures", async () => {
    mockGetDocument.mockRejectedValueOnce(new Error("corrupt file"));
    render(<PdfView bytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-view-error")).toBeInTheDocument();
    expect(screen.getByTestId("pdf-view-error")).toHaveTextContent(/corrupt file/);
  });

  // ── M11.3 search ─────────────────────────────────────────

  async function loadWithPages(pages: readonly string[]): Promise<void> {
    mockGetDocument.mockResolvedValue(makeMockDoc(pages.length, pages));
    render(<PdfView bytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />);
    // Wait for load + text extraction to settle.
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
  }

  it("⌘F opens the search bar and focuses its input", async () => {
    await loadWithPages(["hello world", "goodbye world"]);
    expect(screen.queryByTestId("pdf-search-bar")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
      await Promise.resolve();
    });
    const input = screen.getByTestId<HTMLInputElement>("pdf-search-input");
    expect(input).toBeInTheDocument();
    // queueMicrotask defers focus; flush it.
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(input);
  });

  it("shows hit count and 'no matches' for empty results", async () => {
    await loadWithPages(["hello world"]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
      await Promise.resolve();
    });
    const input = screen.getByTestId<HTMLInputElement>("pdf-search-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "zz" } });
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("0");
  });

  it("counts hits across pages", async () => {
    // Distinct non-overlapping queries per page — avoids
    // accidental matches inside other words (e.g. "the" in
    // "another").
    await loadWithPages(["alpha bravo", "alpha charlie", "delta alpha echo"]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
      await Promise.resolve();
    });
    const input = screen.getByTestId<HTMLInputElement>("pdf-search-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "alpha" } });
      await Promise.resolve();
    });
    // Three "alpha" occurrences across three pages.
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("1 of 3");
  });

  it("Next / Prev buttons cycle through matches (wrapping)", async () => {
    await loadWithPages(["foo one", "foo two", "foo three"]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
      await Promise.resolve();
    });
    const input = screen.getByTestId<HTMLInputElement>("pdf-search-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "foo" } });
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("1 of 3");

    await act(async () => {
      fireEvent.click(screen.getByTestId("pdf-search-next"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("2 of 3");

    // Wrap forward: 3 → 1.
    await act(async () => {
      fireEvent.click(screen.getByTestId("pdf-search-next"));
      fireEvent.click(screen.getByTestId("pdf-search-next"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("1 of 3");

    // Wrap backward: 1 → 3.
    await act(async () => {
      fireEvent.click(screen.getByTestId("pdf-search-prev"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("3 of 3");
  });

  it("Next advances to the page containing the next match", async () => {
    await loadWithPages(["page one nothing", "page two contains needle", "page three nothing"]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
      await Promise.resolve();
    });
    const input = screen.getByTestId<HTMLInputElement>("pdf-search-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "needle" } });
      await Promise.resolve();
      await Promise.resolve();
    });
    // The only match is on page 2 → currentPage should have
    // jumped there.
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("2 / 3");
  });

  it("Esc closes the search bar", async () => {
    await loadWithPages(["hello world"]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-search-bar")).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("pdf-search-bar")).toBeNull();
  });

  it("shows 'Indexing…' while text extraction is in flight", async () => {
    // Delay every page's getTextContent so extraction hangs.
    const delayedDoc = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 100 * scale,
          height: 130 * scale,
        }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
        getTextContent: () => new Promise(() => undefined),
      }),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
    mockGetDocument.mockResolvedValue(delayedDoc);
    render(<PdfView bytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />);
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
      await Promise.resolve();
    });
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent(/indexing/i);
  });
});
