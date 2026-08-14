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

  it("shows the placeholder hint AND a visible cursor when focused on an empty line", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={emptyPromptLine} onInput={noop} />);
    expect(screen.getByTestId("prompt-line")).toHaveTextContent("type a command");
    // The line caret is hidden entirely when the strip is blurred
    // (see M12.8a — the 2px hollow outline read as a glitch). In
    // production the pane's mount effect focuses the strip; in this
    // test we do so explicitly so the caret renders.
    fireEvent.focus(screen.getByTestId("prompt-strip"));
    expect(screen.getByTestId("prompt-cursor")).toBeInTheDocument();
  });

  it("renders the typed line with the cursor at the end by default", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={singleRow("ls -la")} onInput={noop} />);
    expect(screen.getByTestId("prompt-line-text")).toHaveTextContent("ls -la");
    // Line caret only renders when the strip owns focus (M12.8a).
    fireEvent.focus(screen.getByTestId("prompt-strip"));
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
    // Line caret only renders when focused (M12.8a).
    fireEvent.focus(screen.getByTestId("prompt-strip"));
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

// ── M12.4: prompt chrome enrichment (ahead/behind + language) ──────

describe("PromptStrip / chrome enrichment (M12.4)", () => {
  it("does not render the git-ahead-behind chip when both are null", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={emptyPromptLine} onInput={noop} />);
    expect(screen.queryByTestId("prompt-git-ahead-behind")).toBeNull();
  });

  it("does not render the ahead-behind chip when both are zero", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        gitAhead={0}
        gitBehind={0}
        line={emptyPromptLine}
        onInput={noop}
      />,
    );
    expect(screen.queryByTestId("prompt-git-ahead-behind")).toBeNull();
  });

  it("renders `↑N` when ahead > 0, no `↓` when behind is zero", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        gitAhead={2}
        gitBehind={0}
        line={emptyPromptLine}
        onInput={noop}
      />,
    );
    const chip = screen.getByTestId("prompt-git-ahead-behind");
    expect(chip).toHaveTextContent("↑2");
    expect(chip).not.toHaveTextContent("↓");
  });

  it("renders both `↑N ↓M` when both are non-zero", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        gitAhead={2}
        gitBehind={1}
        line={emptyPromptLine}
        onInput={noop}
      />,
    );
    const chip = screen.getByTestId("prompt-git-ahead-behind");
    expect(chip).toHaveTextContent("↑2");
    expect(chip).toHaveTextContent("↓1");
    expect(chip).toHaveAttribute("title", "2 ahead, 1 behind upstream");
  });

  it("does not render a language chip when language is null", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={emptyPromptLine} onInput={noop} />);
    expect(screen.queryByTestId("prompt-language")).toBeNull();
  });

  it("does not render a language chip for an unknown label", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        language="elixir"
        line={emptyPromptLine}
        onInput={noop}
      />,
    );
    expect(screen.queryByTestId("prompt-language")).toBeNull();
  });

  it("renders the language chip with icon + display name for a known label", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        language="rust"
        line={emptyPromptLine}
        onInput={noop}
      />,
    );
    const chip = screen.getByTestId("prompt-language");
    expect(chip).toHaveAttribute("data-language", "rust");
    expect(chip).toHaveTextContent("rust");
    expect(chip).toHaveAttribute("title", "Detected language: rust");
  });

  it("continuation rows hide the chrome via visibility:hidden so alignment holds", () => {
    // Multi-row line — row 1 should render its chrome duplicated but
    // aria-hidden and visually invisible. Regression guard: adding
    // new chrome chips (ahead/behind, language) must keep this
    // invariant so pasted multi-line commands still align.
    const line: PromptLine = {
      rows: [
        {
          text: 'echo "hello',
          styled: new Array<boolean>(11).fill(false),
          selected: new Array<boolean>(11).fill(false),
        },
        {
          text: 'world"',
          styled: new Array<boolean>(6).fill(false),
          selected: new Array<boolean>(6).fill(false),
        },
      ],
      cursorRow: 1,
      cursorCol: 6,
      currentStyled: false,
      currentSelected: false,
    };
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        gitAhead={2}
        gitBehind={0}
        language="rust"
        line={line}
        onInput={noop}
      />,
    );
    // Row 1's chrome is aria-hidden — enumerating aria-hidden spans
    // should catch the branch, ahead/behind, language, and prompt
    // glyph reservations. If any of the new chips forgot the
    // aria-hidden wrapping, alignment would break silently.
    const row1 = screen.getByTestId("prompt-row-1");
    const hidden = row1.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThanOrEqual(4);
  });
});

// ── M12.5 / M12.6a syntax highlighting integration ────────────────
//
// The render-behaviour tests (kind → color mapping, precedence rules,
// fidelity fallback) moved to `CommandSpans.test.tsx` in M12.6a when
// the render logic was extracted. What stays here is a single
// integration check that the composition still works — the strip
// wires row text through `CommandSpans` correctly, and the cursor
// split doesn't fracture syntax coloring on either side.

describe("PromptStrip / syntax highlighting integration (M12.6a)", () => {
  function leafSpan(text: string): HTMLSpanElement | null {
    return (
      Array.from(document.querySelectorAll<HTMLSpanElement>("span")).find(
        (s) => s.textContent === text && s.querySelector("span") === null,
      ) ?? null
    );
  }

  it("wires row text through CommandSpans on both sides of the cursor", () => {
    // With a mid-line cursor, `git` sits before and `commit` sits
    // after. Both halves independently tokenize (from their own
    // segment-start), so both `git` and `commit` should reach the
    // matching --syntax-* colours.
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("git commit", { cursorCol: 4 })}
        onInput={noop}
      />,
    );
    expect(leafSpan("git")?.style.color).toBe("var(--syntax-command)");
    expect(leafSpan("commit")?.style.color).toBe("var(--syntax-command)");
    // Note: the "after" half re-tokenizes from its own start, so
    // `commit` renders as a command (first word of its segment),
    // not a subcommand — the split at the cursor is intentional
    // and the visual matches the mirror renderer's own
    // char-by-char state.
  });
});

// ── M12.8: vi-aware caret/cursor with focus states ───────────────

describe("PromptStrip / cursor shape by mode (M12.8)", () => {
  it("defaults to a thin line caret when viKeymap is null (emacs default)", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={singleRow("ls")} onInput={noop} />);
    // Line caret only renders when focused (M12.8a).
    fireEvent.focus(screen.getByTestId("prompt-strip"));
    const cursor = screen.getByTestId("prompt-cursor");
    expect(cursor).toHaveAttribute("data-cursor-kind", "line");
    // Line cursor: 2px wide, filled with accent (no border).
    expect(cursor.style.width).toBe("2px");
    // Empty text content — the caret is a positional bar between
    // characters, not covering one.
    expect(cursor.textContent).toBe("");
  });

  it("keeps the line caret in vi INSERT mode (`viins`)", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("ls")}
        onInput={noop}
        viKeymap="viins"
      />,
    );
    fireEvent.focus(screen.getByTestId("prompt-strip"));
    expect(screen.getByTestId("prompt-cursor")).toHaveAttribute("data-cursor-kind", "line");
  });

  it("keeps the line caret in `main` (bash / zsh alias for the active keymap)", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("ls")}
        onInput={noop}
        viKeymap="main"
      />,
    );
    fireEvent.focus(screen.getByTestId("prompt-strip"));
    expect(screen.getByTestId("prompt-cursor")).toHaveAttribute("data-cursor-kind", "line");
  });

  it("switches to a block cursor in vi NORMAL mode (`vicmd`)", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("ls", { cursorCol: 0 })}
        onInput={noop}
        viKeymap="vicmd"
      />,
    );
    const cursor = screen.getByTestId("prompt-cursor");
    expect(cursor).toHaveAttribute("data-cursor-kind", "block");
    // Block cursor: 1ch wide (a character cell), foreground inverted.
    expect(cursor.style.minWidth).toBe("1ch");
    // The block contains the character at cursorCol — `l` here.
    expect(cursor.textContent).toBe("l");
  });

  it("uses a block cursor in vi VISUAL mode as well", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("ls", { cursorCol: 0 })}
        onInput={noop}
        viKeymap="visual"
      />,
    );
    expect(screen.getByTestId("prompt-cursor")).toHaveAttribute("data-cursor-kind", "block");
  });

  it("block cursor at end of text wraps a space so it stays visible", () => {
    // `ls` has length 2. cursorCol = 2 → past the last char → the
    // block wraps a space rather than an empty string; without this,
    // the block would collapse to zero width at end-of-line.
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("ls", { cursorCol: 2 })}
        onInput={noop}
        viKeymap="vicmd"
      />,
    );
    const cursor = screen.getByTestId("prompt-cursor");
    expect(cursor).toHaveAttribute("data-cursor-kind", "block");
    // `.textContent` for a single-space span is " " — asserting the
    // exact whitespace character.
    expect(cursor.textContent).toBe(" ");
  });

  it("block cursor consumes ONE character; text after that character stays visible", () => {
    // With text "abc" and cursor at 1: `a` is before, `b` is inside
    // the block, `c` is after. Regression guard against the earlier
    // "cursor sits between chars" split, which would render `b` twice
    // (once in beforeText, once in the cursor) or lose it entirely.
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("abc", { cursorCol: 1 })}
        onInput={noop}
        viKeymap="vicmd"
      />,
    );
    const cursor = screen.getByTestId("prompt-cursor");
    expect(cursor.textContent).toBe("b");
    // The whole line's rendered text is still "abc" (b via the cursor
    // block, a and c via CommandSpans on either side).
    expect(screen.getByTestId("prompt-line").textContent).toBe("abc");
  });
});

describe("PromptStrip / cursor focus state (M12.8)", () => {
  it("line caret is hidden entirely when the strip is blurred (M12.8a)", () => {
    // Regression pin: the earlier "hollow outline" for a blurred
    // line caret was barely visible at typical font sizes and read
    // as a rendering glitch. The line variant now renders only
    // when focused; blurred = no DOM element at all. Block cursors
    // keep their outline (see next test).
    render(<PromptStrip cwd="/tmp" branch="main" line={singleRow("ls")} onInput={noop} />);
    expect(screen.queryByTestId("prompt-cursor")).toBeNull();
  });

  it("line caret appears with solid fill when the strip gains focus", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={singleRow("ls")} onInput={noop} />);
    fireEvent.focus(screen.getByTestId("prompt-strip"));
    const cursor = screen.getByTestId("prompt-cursor");
    expect(cursor).toHaveAttribute("data-cursor-focused", "true");
    // Solid: accent background, no border.
    expect(cursor.style.background).toBe("var(--accent)");
    expect(cursor.style.border).toBe("");
  });

  it("line caret disappears again when the strip blurs", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={singleRow("ls")} onInput={noop} />);
    const strip = screen.getByTestId("prompt-strip");
    fireEvent.focus(strip);
    expect(screen.getByTestId("prompt-cursor")).toBeInTheDocument();
    fireEvent.blur(strip);
    expect(screen.queryByTestId("prompt-cursor")).toBeNull();
  });

  it("block cursor STAYS visible (outlined) when the strip is blurred (M12.8a)", () => {
    // Contrast with the line-cursor case: the block variant
    // remains legible at any font size when outlined, so hiding
    // it would lose the "here's where you were in NORMAL" signal.
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("ls", { cursorCol: 0 })}
        onInput={noop}
        viKeymap="vicmd"
      />,
    );
    const cursor = screen.getByTestId("prompt-cursor");
    // Present in the DOM even though blurred.
    expect(cursor).toBeInTheDocument();
    expect(cursor).toHaveAttribute("data-cursor-focused", "false");
    // Outlined: transparent bg, accent border.
    expect(cursor.style.background).toBe("transparent");
    expect(cursor.style.border).toContain("var(--accent)");
  });

  it("focus state applies to the block cursor too", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("ls", { cursorCol: 0 })}
        onInput={noop}
        viKeymap="vicmd"
      />,
    );
    fireEvent.focus(screen.getByTestId("prompt-strip"));
    const cursor = screen.getByTestId("prompt-cursor");
    // Focused block: accent bg, bg-inverse fg.
    expect(cursor.style.background).toBe("var(--accent)");
    expect(cursor.style.color).toBe("var(--bg)");
    fireEvent.blur(screen.getByTestId("prompt-strip"));
    // Blurred block: transparent bg, fg text color, accent border.
    expect(cursor.style.background).toBe("transparent");
    expect(cursor.style.color).toBe("var(--fg)");
    expect(cursor.style.border).toContain("var(--accent)");
  });
});

describe("PromptStrip / cursor alignment (M12.8)", () => {
  it("cursor height matches the line-area's explicit line-height", () => {
    // Regression guard for "cursor is short — leaves a top/bottom
    // gap around the character it covers." Both the LINE_AREA and
    // every cursor variant use the same 1.3em vertical extent, so
    // the cursor's line-box aligns exactly with the character's
    // line-box. If either value drifts, this test breaks first.
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={singleRow("ls", { cursorCol: 0 })}
        onInput={noop}
        viKeymap="vicmd"
      />,
    );
    const cursor = screen.getByTestId("prompt-cursor");
    // Block cursor should be 1.3em tall (matching LINE_AREA
    // lineHeight of 1.3).
    expect(cursor.style.height).toBe("1.3em");
    // And `line-height` inside the block itself is set so the
    // character centers inside the box.
    expect(cursor.style.lineHeight).toBe("1.3em");
  });

  it("line cursor also gets the 1.3em height (same alignment rule)", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={singleRow("ls")} onInput={noop} />);
    // Line caret only renders when focused (M12.8a).
    fireEvent.focus(screen.getByTestId("prompt-strip"));
    const cursor = screen.getByTestId("prompt-cursor");
    expect(cursor.style.height).toBe("1.3em");
  });

  it("prompt-line area sets an explicit line-height so cursor 1.3em is meaningful", () => {
    // The default browser `line-height: normal` (font-dependent,
    // ~1.2-1.4) makes the cursor's `height: 1.3em` a rough
    // approximation. Setting the line-height explicitly on the
    // LINE_AREA pins the line-box to a known value the cursor
    // can match exactly.
    render(<PromptStrip cwd="/tmp" branch="main" line={singleRow("ls")} onInput={noop} />);
    const lineArea = screen.getByTestId("prompt-line");
    // Style.lineHeight can be "1.3" (unitless) — the browser stores
    // what we set.
    expect(lineArea.style.lineHeight).toBe("1.3");
  });
});
