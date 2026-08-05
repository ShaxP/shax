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

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (options: unknown): { promise: Promise<unknown> } => ({
    promise: mockGetDocument(options) as Promise<unknown>,
  }),
}));

// Imported after the mock so PdfView's dynamic import resolves
// to the mock module.
import { PdfView } from "./PdfView";

// ── Fixtures ───────────────────────────────────────────────

function makeMockPage() {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 130 * scale,
    }),
    render: () => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }),
  };
}

function makeMockDoc(numPages: number) {
  return {
    numPages,
    getPage: vi.fn().mockResolvedValue(makeMockPage()),
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
});
