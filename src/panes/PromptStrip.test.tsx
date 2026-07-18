/**
 * PromptStrip unit tests (jsdom / Vitest).
 *
 * Covers the M1.9 1.9b input-ownership behaviour: keydown events map to
 * PTY bytes via keyToBytes and flow through the onInput callback. Visual
 * mirror assertions from 1.9a continue to apply (cwd / branch fallbacks,
 * placeholder, split-around-cursor).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PromptStrip } from "./PromptStrip";

const noop = (): void => {};

afterEach(() => cleanup());

describe("PromptStrip / layout", () => {
  it("renders the wrapper and neutral fallbacks for cwd/branch", () => {
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={noop}
      />,
    );
    expect(screen.getByTestId("prompt-strip")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-cwd")).toHaveTextContent("—");
    expect(screen.getByTestId("prompt-branch")).toHaveTextContent("—");
  });

  it("shows the placeholder hint AND a visible cursor when the line is empty", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={noop}
      />,
    );
    expect(screen.getByTestId("prompt-line")).toHaveTextContent("type a command");
    // The cursor must be visible from the start so the user sees a clear
    // insertion point even before typing.
    expect(screen.getByTestId("prompt-cursor")).toBeInTheDocument();
  });

  it("renders the typed line with the cursor at the end by default", () => {
    render(
      <PromptStrip
        cwd="/tmp"
        branch="main"
        line={{
          text: "ls -la",
          styled: [false, false, false, false, false, false],
          cursor: 6,
          currentStyled: false,
        }}
        onInput={noop}
      />,
    );
    expect(screen.getByTestId("prompt-line-text")).toHaveTextContent("ls -la");
    expect(screen.getByTestId("prompt-cursor")).toBeInTheDocument();
  });

  it("splits the line around a mid-line cursor", () => {
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{
          text: "abcdef",
          styled: [false, false, false, false, false, false],
          cursor: 3,
          currentStyled: false,
        }}
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
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
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
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={onInput}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "a" });
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith(new TextEncoder().encode("a"));
  });

  it("maps Enter to CR for the shell", () => {
    const onInput = vi.fn();
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={onInput}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "Enter" });
    expect(onInput).toHaveBeenCalledWith(new Uint8Array([0x0d]));
  });

  it("maps arrow keys to CSI sequences", () => {
    const onInput = vi.fn();
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={onInput}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "ArrowUp" });
    expect(onInput).toHaveBeenCalledWith(new TextEncoder().encode("\x1b[A"));
  });

  it("ignores modifier-only events (no onInput call)", () => {
    const onInput = vi.fn();
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={onInput}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "Shift", shiftKey: true });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("is focusable (tabIndex=0) so it can claim focus when no input has happened yet", () => {
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={noop}
      />,
    );
    expect(screen.getByTestId("prompt-strip")).toHaveAttribute("tabindex", "0");
  });
});

describe("PromptStrip / M7.6 additions", () => {
  it("? as the first character on an empty prompt opens the assistant", () => {
    const onInput = vi.fn();
    const listener = vi.fn();
    window.addEventListener("shax:assistant-open", listener);
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={onInput}
      />,
    );
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
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{
          text: "grep",
          styled: [false, false, false, false],
          cursor: 4,
          currentStyled: false,
        }}
        onInput={onInput}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "?" });
    expect(listener).not.toHaveBeenCalled();
    expect(onInput).toHaveBeenCalledTimes(1);
    window.removeEventListener("shax:assistant-open", listener);
  });

  it("? with a modifier (e.g. Shift-?) is passed to the shell as normal input", () => {
    // Shift + / on many keyboards is what actually produces `?`;
    // fireEvent sends us a synthetic `?` with shiftKey=true. The
    // handler only intercepts bare `?` — anything else routes to
    // the shell so shell-side `?` bindings still work.
    const onInput = vi.fn();
    const listener = vi.fn();
    window.addEventListener("shax:assistant-open", listener);
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={onInput}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "?", metaKey: true });
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener("shax:assistant-open", listener);
  });

  it("cwd is compacted against the home dir from context (M7.6)", async () => {
    // Import the provider lazily to keep the other tests in this
    // file free of the wrapper.
    const { HomeDirProvider } = await import("../lib/HomeDirContext");
    render(
      <HomeDirProvider value="/Users/ada">
        <PromptStrip
          cwd="/Users/ada/dev/shax"
          branch="main"
          line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
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
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
        onInput={noop}
        assistantDocked
      />,
    );
    const line = screen.getByTestId("prompt-line");
    expect(line).toHaveTextContent(/assistant is working beside you/i);
    expect(line).not.toHaveTextContent(/type a command/i);
  });

  it("does NOT intercept ? when the assistant is docked", () => {
    // The placeholder no longer mentions ? once the dock is open,
    // so intercepting it would surprise the user. ? types normally.
    const onInput = vi.fn();
    const listener = vi.fn();
    window.addEventListener("shax:assistant-open", listener);
    render(
      <PromptStrip
        cwd={null}
        branch={null}
        line={{ text: "", styled: [], cursor: 0, currentStyled: false }}
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
