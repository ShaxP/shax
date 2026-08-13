/**
 * `CommandSpans` component tests (M12.6a).
 *
 * These are the primary tests for the syntax-highlighted span
 * renderer. `PromptStrip` and `BlockRow` both consume this component;
 * their own tests keep a smaller integration check that the wiring
 * works, but every render-behaviour assertion (kind-to-color mapping,
 * precedence rules, fidelity fallback) lives here.
 *
 * Migrated from the M12.5 render-path tests that used to live in
 * `PromptStrip.test.tsx`.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CommandSpans } from "./CommandSpans";

afterEach(() => cleanup());

/**
 * Find the leaf span (no child spans) whose textContent equals
 * `text`, and return its inline `color`. Wrapper spans upstream
 * inherit textContent from their children, so filtering to leaves
 * pins the actual styled run without depending on DOM tree depth.
 * `null` when nothing matches.
 */
function leafSpan(text: string): HTMLSpanElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLSpanElement>("span")).find(
      (s) => s.textContent === text && s.querySelector("span") === null,
    ) ?? null
  );
}
function colorOfSpan(text: string): string | null {
  return leafSpan(text)?.style.color || null;
}

describe("CommandSpans / kind → color mapping", () => {
  it("paints a bare command with --syntax-command", () => {
    render(<CommandSpans text="ls" />);
    expect(colorOfSpan("ls")).toBe("var(--syntax-command)");
  });

  it("paints a subcommand of a multi-tool with --syntax-subcommand", () => {
    render(<CommandSpans text="git commit" />);
    expect(colorOfSpan("git")).toBe("var(--syntax-command)");
    expect(colorOfSpan("commit")).toBe("var(--syntax-subcommand)");
  });

  it("paints flags, strings, variables, and operators", () => {
    render(<CommandSpans text={'echo -n $HOME | grep "hi"'} />);
    expect(colorOfSpan("echo")).toBe("var(--syntax-command)");
    expect(colorOfSpan("-n")).toBe("var(--syntax-flag)");
    expect(colorOfSpan("$HOME")).toBe("var(--syntax-variable)");
    expect(colorOfSpan("|")).toBe("var(--syntax-operator)");
    expect(colorOfSpan("grep")).toBe("var(--syntax-command)");
    expect(colorOfSpan('"hi"')).toBe("var(--syntax-string)");
  });

  it("paints comments with --syntax-comment", () => {
    render(<CommandSpans text="ls # note" />);
    expect(colorOfSpan("# note")).toBe("var(--syntax-comment)");
  });

  it("plain text (arg to a non-multi-tool) gets no color", () => {
    render(<CommandSpans text="echo hello" />);
    expect(colorOfSpan("hello")).toBe(null);
  });

  it("empty text renders nothing (no crash)", () => {
    const { container } = render(<CommandSpans text="" />);
    // Empty fragment — no leaf spans should appear.
    expect(container.querySelectorAll("span")).toHaveLength(0);
  });
});

describe("CommandSpans / precedence rules", () => {
  it("selection (SGR-7) wins over syntax color", () => {
    // With every char selected, each leaf span gets SELECTED_TEXT's
    // accent-soft background and `--fg` foreground — no syntax color.
    render(
      <CommandSpans text="ls -la" selected={[true, true, true, true, true, true]} styled={[]} />,
    );
    for (const text of ["ls", "-la"]) {
      const span = leafSpan(text);
      expect(span, `expected leaf span for ${text}`).not.toBeNull();
      expect(span?.style.background).toBe("var(--accent-soft)");
      expect(span?.style.color).toBe("var(--fg)");
    }
  });

  it("styled (autosuggestion ghost) wins over syntax color", () => {
    // Simulate zsh-autosuggestions ghost text: mirror renderer sets
    // `styled: true` for those cells. Even though `ls` would be a
    // command color, ghost text renders dim.
    render(<CommandSpans text="ls" styled={[true, true]} />);
    expect(leafSpan("ls")?.style.color).toBe("var(--fg-faint)");
  });

  it("styled + syntax kind together = styled dim wins", () => {
    // Belt-and-suspenders: even when a run would qualify for
    // multiple non-null styles, the precedence rule holds.
    render(<CommandSpans text="git" styled={[true, true, true]} />);
    const span = leafSpan("git");
    expect(span?.style.color).toBe("var(--fg-faint)");
    // No selection background.
    expect(span?.style.background).toBe("");
  });
});

describe("CommandSpans / omitted axis arrays", () => {
  it("styled and selected default to all-false when omitted", () => {
    // BlockRow / search-snippet callers pass text only; the
    // component must treat unspecified arrays as "no styled, no
    // selected" and just apply syntax color.
    render(<CommandSpans text="ls -la" />);
    expect(colorOfSpan("ls")).toBe("var(--syntax-command)");
    expect(colorOfSpan("-la")).toBe("var(--syntax-flag)");
  });

  it("shorter styled/selected arrays fall back to false for missing indices", () => {
    // Callers might pass arrays shorter than `text` (e.g. after a
    // slice that included the cursor col). Missing entries treated
    // as false rather than throwing.
    render(<CommandSpans text="ls -la" styled={[true]} />);
    // First char has styled=true, rest fall back to false.
    // Because styled splits runs, the leaf span for `l` alone
    // should be dim; `s` (styled=false) and `-la` (styled=false,
    // flag color) render normally.
    expect(leafSpan("l")?.style.color).toBe("var(--fg-faint)");
  });
});
