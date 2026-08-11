/**
 * PromptStrip unit tests (jsdom / Vitest).
 *
 * Covers the M1.9 1.9b input-ownership behaviour: keydown events map to
 * PTY bytes via keyToBytes and flow through the onInput callback. Visual
 * mirror assertions from 1.9a continue to apply (cwd / branch fallbacks,
 * placeholder, split-around-cursor). M12.3 grew the strip to N rows —
 * see the multi-line block near the end.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PromptStrip } from "./PromptStrip";
import { emptyPromptLine } from "./promptRenderer";
import type { PromptLine, PromptRow } from "./promptRenderer";

const noop = (): void => {};

afterEach(() => cleanup());

/** Test helper — build a single-row PromptLine from a text string. */
function singleRow(
  text: string,
  opts?: { cursorCol?: number; styled?: boolean[]; selected?: boolean[] },
): PromptLine {
  const styled = opts?.styled ?? new Array<boolean>(text.length).fill(false);
  const selected = opts?.selected ?? new Array<boolean>(text.length).fill(false);
  return {
    rows: [{ text, styled, selected }],
    cursorRow: 0,
    cursorCol: opts?.cursorCol ?? text.length,
    currentStyled: false,
    currentSelected: false,
  };
}

/** Test helper — build a multi-row PromptLine. Cursor defaults to the
 *  end of the last row. */
function multiRow(
  rowTexts: string[],
  opts?: { cursorRow?: number; cursorCol?: number },
): PromptLine {
  const rows: PromptRow[] = rowTexts.map((text) => ({
    text,
    styled: new Array<boolean>(text.length).fill(false),
    selected: new Array<boolean>(text.length).fill(false),
  }));
  const cursorRow = opts?.cursorRow ?? rows.length - 1;
  const cursorCol = opts?.cursorCol ?? rows[cursorRow]?.text.length ?? 0;
  return {
    rows,
    cursorRow,
    cursorCol,
    currentStyled: false,
    currentSelected: false,
  };
}

describe("PromptStrip / layout", () => {
  it("renders the wrapper and neutral fallbacks for cwd/branch", () => {
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={noop} />);
    expect(screen.getByTestId("prompt-strip")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-cwd")).toHaveTextContent("—");
    expect(screen.getByTestId("prompt-branch")).toHaveTextContent("—");
  });

  it("shows the placeholder hint AND a visible cursor when the line is empty", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={emptyPromptLine} onInput={noop} />);
    expect(screen.getByTestId("prompt-line")).toHaveTextContent("type a command");
    // The cursor must be visible from the start so the user sees a clear
    // insertion point even before typing.
    expect(screen.getByTestId("prompt-cursor")).toBeInTheDocument();
  });

  it("renders the typed line with the cursor at the end by default", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={singleRow("ls -la")} onInput={noop} />);
    expect(screen.getByTestId("prompt-line-text")).toHaveTextContent("ls -la");
    expect(screen.getByTestId("prompt-cursor")).toBeInTheDocument();
  });

  it("splits the line around a mid-line cursor", () => {
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={singleRow("abcdef", { cursorCol: 3 })}
        onInput={noop}
      />,
    );
    expect(screen.getByTestId("prompt-line-text")).toHaveTextContent("abc");
    expect(screen.getByTestId("prompt-line")).toHaveTextContent("abcdef");
  });

  it("renders the supplied cwd and branch", () => {
    render(
      <PromptStrip
        cwd="/Users/ada/dev/shax"
        branch="feat/x"
        line={emptyPromptLine}
        onInput={noop}
      />,
    );
    expect(screen.getByTestId("prompt-cwd")).toHaveTextContent("/Users/ada/dev/shax");
    expect(screen.getByTestId("prompt-branch")).toHaveTextContent("feat/x");
  });
});

describe("PromptStrip / input ownership", () => {
  it("forwards typed bytes through onInput for a printable key", () => {
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "a" });
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith(new TextEncoder().encode("a"));
  });

  it("maps Enter to CR for the shell", () => {
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "Enter" });
    expect(onInput).toHaveBeenCalledWith(new Uint8Array([0x0d]));
  });

  it("maps arrow keys to CSI sequences", () => {
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "ArrowUp" });
    expect(onInput).toHaveBeenCalledWith(new TextEncoder().encode("\x1b[A"));
  });

  it("ignores modifier-only events (no onInput call)", () => {
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "Shift", shiftKey: true });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("is focusable (tabIndex=0) so it can claim focus when no input has happened yet", () => {
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={noop} />);
    expect(screen.getByTestId("prompt-strip")).toHaveAttribute("tabindex", "0");
  });
});

describe("PromptStrip / M7.6 additions", () => {
  it("? as the first character on an empty prompt opens the assistant", () => {
    const onInput = vi.fn();
    const listener = vi.fn();
    window.addEventListener("shax:assistant-open", listener);
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "?" });
    expect(listener).toHaveBeenCalledTimes(1);
    // The `?` byte itself is NOT forwarded to the shell.
    expect(onInput).not.toHaveBeenCalled();
    window.removeEventListener("shax:assistant-open", listener);
  });

  it("? with existing text on the line is a normal character", () => {
    const onInput = vi.fn();
    const listener = vi.fn();
    window.addEventListener("shax:assistant-open", listener);
    render(<PromptStrip cwd={null} branch={null} line={singleRow("grep")} onInput={onInput} />);
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "?" });
    expect(listener).not.toHaveBeenCalled();
    expect(onInput).toHaveBeenCalledTimes(1);
    window.removeEventListener("shax:assistant-open", listener);
  });

  it("? with a modifier (e.g. Shift-?) is passed to the shell as normal input", () => {
    const onInput = vi.fn();
    const listener = vi.fn();
    window.addEventListener("shax:assistant-open", listener);
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "?", metaKey: true });
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener("shax:assistant-open", listener);
  });

  it("cwd is compacted against the home dir from context (M7.6)", async () => {
    const { HomeDirProvider } = await import("../lib/HomeDirContext");
    render(
      <HomeDirProvider value="/Users/ada">
        <PromptStrip
          cwd="/Users/ada/dev/shax"
          branch="main"
          line={emptyPromptLine}
          onInput={noop}
        />
      </HomeDirProvider>,
    );
    expect(screen.getByTestId("prompt-cwd")).toHaveTextContent("~/dev/shax");
  });
});

describe("PromptStrip / M7.7b assistant-dock integration", () => {
  it("swaps the placeholder when the assistant is docked", () => {
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={emptyPromptLine}
        onInput={noop}
        assistantDocked
      />,
    );
    const line = screen.getByTestId("prompt-line");
    expect(line).toHaveTextContent(/assistant is working beside you/i);
    expect(line).not.toHaveTextContent(/type a command/i);
  });

  it("does NOT intercept ? when the assistant is docked", () => {
    const onInput = vi.fn();
    const listener = vi.fn();
    window.addEventListener("shax:assistant-open", listener);
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={emptyPromptLine}
        onInput={onInput}
        assistantDocked
      />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "?" });
    expect(listener).not.toHaveBeenCalled();
    expect(onInput).toHaveBeenCalledTimes(1);
    window.removeEventListener("shax:assistant-open", listener);
  });
});

// ── M12.2: selection rendering ────────────────────────────────────────

describe("PromptStrip / selection rendering (M12.2)", () => {
  it("paints a selected run with an accent background", () => {
    // "abcdef" with cells 2..4 (`cde`) marked as selected.
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={singleRow("abcdef", {
          selected: [false, false, true, true, true, false],
        })}
        onInput={noop}
      />,
    );
    const promptLine = screen.getByTestId("prompt-line-text");
    const selectedSpans = Array.from(promptLine.querySelectorAll("span")).filter(
      (span) => span.style.background !== "" && span.style.background.includes("--accent-soft"),
    );
    expect(selectedSpans.length).toBeGreaterThan(0);
    const selectedText = selectedSpans.map((s) => s.textContent).join("");
    expect(selectedText).toBe("cde");
  });

  it("does not paint a background when no cell is selected", () => {
    render(<PromptStrip cwd={null} branch={null} line={singleRow("abcdef")} onInput={noop} />);
    const promptLine = screen.getByTestId("prompt-line-text");
    const withBg = Array.from(promptLine.querySelectorAll("span")).filter(
      (span) => span.style.background !== "" && span.style.background.includes("--accent-soft"),
    );
    expect(withBg.length).toBe(0);
  });

  it("selection background wins over the dim colour for a cell that is both styled and selected", () => {
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={singleRow("abc", {
          styled: [true, true, true],
          selected: [true, true, true],
        })}
        onInput={noop}
      />,
    );
    const promptLine = screen.getByTestId("prompt-line-text");
    const spans = Array.from(promptLine.querySelectorAll("span"));
    const selectedSpan = spans.find(
      (s) => s.style.background !== "" && s.style.background.includes("--accent-soft"),
    );
    expect(selectedSpan).toBeDefined();
    // The selected span must not also dim its foreground.
    expect(selectedSpan?.style.color).not.toContain("--fg-faint");
  });
});

// ── M12.3: multi-row rendering ───────────────────────────────────────

describe("PromptStrip / multi-row rendering (M12.3)", () => {
  it("renders one row per PromptRow", () => {
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={multiRow(['echo "hello', "world"])}
        onInput={noop}
      />,
    );
    expect(screen.getByTestId("prompt-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-row-1")).toBeInTheDocument();
    expect(screen.queryByTestId("prompt-row-2")).toBeNull();
  });

  it("row 0 carries the chrome (cwd, branch, ❯); continuation rows hide it", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={multiRow(['echo "hello', "world"])}
        onInput={noop}
      />,
    );
    // Row 0's testids are the canonical ones.
    expect(screen.getByTestId("prompt-cwd")).toHaveTextContent("/tmp");
    expect(screen.getByTestId("prompt-branch")).toHaveTextContent("main");
    // Continuation rows reserve the chrome column via visibility:hidden
    // so the input column aligns automatically. Their chrome spans are
    // aria-hidden so screen readers don't repeat the cwd.
    const row1 = screen.getByTestId("prompt-row-1");
    const hidden = row1.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThanOrEqual(2); // chrome + glyph
  });

  it("cursor is only rendered on the row the cursor sits on", () => {
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={multiRow(["one", "two", "three"], { cursorRow: 1, cursorCol: 2 })}
        onInput={noop}
      />,
    );
    const row1 = screen.getByTestId("prompt-row-1");
    expect(row1.querySelector('[data-testid="prompt-cursor"]')).not.toBeNull();
    const row0 = screen.getByTestId("prompt-row-0");
    const row2 = screen.getByTestId("prompt-row-2");
    expect(row0.querySelector('[data-testid="prompt-cursor"]')).toBeNull();
    expect(row2.querySelector('[data-testid="prompt-cursor"]')).toBeNull();
  });

  it("placeholder hint appears only on row 0 and only when no row has text", () => {
    // Empty line — placeholder appears.
    const { rerender } = render(
      <PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={noop} />,
    );
    expect(screen.getByTestId("prompt-row-0")).toHaveTextContent(/type a command/i);
    // Multi-row line with content — no placeholder anywhere.
    rerender(<PromptStrip cwd={null} branch={null} line={multiRow(["a", "b"])} onInput={noop} />);
    expect(screen.getByTestId("prompt-row-0")).not.toHaveTextContent(/type a command/i);
    expect(screen.getByTestId("prompt-row-1")).not.toHaveTextContent(/type a command/i);
  });

  it("? on an empty multi-row line still opens the assistant only when cursor is at (0, 0)", () => {
    const listener = vi.fn();
    window.addEventListener("shax:assistant-open", listener);
    try {
      const { rerender } = render(
        <PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={noop} />,
      );
      // Empty, cursor at (0, 0) → ? opens.
      fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "?" });
      expect(listener).toHaveBeenCalledTimes(1);
      listener.mockClear();
      // Multi-row with text → ? is a normal char.
      rerender(<PromptStrip cwd={null} branch={null} line={multiRow(["hi", ""])} onInput={noop} />);
      fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "?" });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("shax:assistant-open", listener);
    }
  });
});

// ── M12.3: paste handling ────────────────────────────────────────────

describe("PromptStrip / paste handling (M12.3)", () => {
  const BRACKETED_START = "\x1b[200~";
  const BRACKETED_END = "\x1b[201~";

  function firePaste(strip: HTMLElement, text: string): void {
    // jsdom doesn't ship a functional `DataTransfer`; the paste handler
    // only reads `getData("text/plain")` so a minimal stub is enough.
    const clipboardData = {
      getData: (type: string): string => (type === "text/plain" ? text : ""),
    };
    fireEvent.paste(strip, { clipboardData });
  }

  it("small paste wraps in bracketed-paste and sends straight through", () => {
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    firePaste(screen.getByTestId("prompt-strip"), "echo hello");
    expect(onInput).toHaveBeenCalledTimes(1);
    const bytes = onInput.mock.calls[0]?.[0] as Uint8Array;
    const s = new TextDecoder().decode(bytes);
    expect(s).toBe(`${BRACKETED_START}echo hello${BRACKETED_END}`);
    // Small paste does NOT open the modal.
    expect(screen.queryByTestId("confirm-paste-modal")).toBeNull();
  });

  it("CRLF line endings are normalised to LF before wrapping", () => {
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    firePaste(screen.getByTestId("prompt-strip"), "one\r\ntwo");
    const bytes = onInput.mock.calls[0]?.[0] as Uint8Array;
    const s = new TextDecoder().decode(bytes);
    expect(s).toBe(`${BRACKETED_START}one\ntwo${BRACKETED_END}`);
  });

  it("large multi-line paste (>= 5 lines) opens the confirmation modal instead of sending", () => {
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    const payload = "a\nb\nc\nd\ne";
    firePaste(screen.getByTestId("prompt-strip"), payload);
    expect(onInput).not.toHaveBeenCalled();
    const modal = screen.getByTestId("confirm-paste-modal");
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveAttribute("data-lines", "5");
  });

  it("large-by-bytes paste (>= 500 bytes) opens the modal", () => {
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    // 500+ bytes on a single line.
    const payload = "x".repeat(600);
    firePaste(screen.getByTestId("prompt-strip"), payload);
    expect(onInput).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-paste-modal")).toBeInTheDocument();
  });

  it("confirming a large paste sends the payload wrapped in bracketed-paste with raw LFs", () => {
    // The modal no longer has a toggle — bracketed-paste + raw LFs is
    // the only path. Shell's bracketed-paste handling inserts the
    // payload into the buffer as multi-line text; user hits Enter to
    // submit. See ConfirmPasteModal docblock for why the earlier
    // `\`-prefix toggle was removed.
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    firePaste(screen.getByTestId("prompt-strip"), "a\nb\nc\nd\ne");
    fireEvent.click(screen.getByTestId("confirm-paste-confirm"));
    expect(onInput).toHaveBeenCalledTimes(1);
    const bytes = onInput.mock.calls[0]?.[0] as Uint8Array;
    const s = new TextDecoder().decode(bytes);
    expect(s).toBe(`${BRACKETED_START}a\nb\nc\nd\ne${BRACKETED_END}`);
    expect(screen.queryByTestId("confirm-paste-modal")).toBeNull();
  });

  it("cancelling a large paste sends nothing to the shell", () => {
    const onInput = vi.fn();
    render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={onInput} />);
    firePaste(screen.getByTestId("prompt-strip"), "a\nb\nc\nd\ne");
    fireEvent.click(screen.getByTestId("confirm-paste-cancel"));
    expect(onInput).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-paste-modal")).toBeNull();
  });

  it("closing the paste modal (confirm) fires shax:refocus-pane so the strip regains focus", () => {
    const refocus = vi.fn();
    window.addEventListener("shax:refocus-pane", refocus);
    try {
      render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={vi.fn()} />);
      firePaste(screen.getByTestId("prompt-strip"), "a\nb\nc\nd\ne");
      fireEvent.click(screen.getByTestId("confirm-paste-confirm"));
      expect(refocus).toHaveBeenCalled();
    } finally {
      window.removeEventListener("shax:refocus-pane", refocus);
    }
  });

  it("closing the paste modal (cancel) fires shax:refocus-pane so the strip regains focus", () => {
    const refocus = vi.fn();
    window.addEventListener("shax:refocus-pane", refocus);
    try {
      render(<PromptStrip cwd={null} branch={null} line={emptyPromptLine} onInput={vi.fn()} />);
      firePaste(screen.getByTestId("prompt-strip"), "a\nb\nc\nd\ne");
      fireEvent.click(screen.getByTestId("confirm-paste-cancel"));
      expect(refocus).toHaveBeenCalled();
    } finally {
      window.removeEventListener("shax:refocus-pane", refocus);
    }
  });
});
