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
    render(<PromptStrip cwd={null} branch={null} line={{ text: "", cursor: 0 }} onInput={noop} />);
    expect(screen.getByTestId("prompt-strip")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-cwd")).toHaveTextContent("—");
    expect(screen.getByTestId("prompt-branch")).toHaveTextContent("—");
  });

  it("shows the placeholder hint when the line is empty", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={{ text: "", cursor: 0 }} onInput={noop} />);
    expect(screen.getByTestId("prompt-line")).toHaveTextContent("type a command");
    expect(screen.queryByTestId("prompt-cursor")).toBeNull();
  });

  it("renders the typed line with the cursor at the end by default", () => {
    render(
      <PromptStrip cwd="/tmp" branch="main" line={{ text: "ls -la", cursor: 6 }} onInput={noop} />,
    );
    expect(screen.getByTestId("prompt-line-text")).toHaveTextContent("ls -la");
    expect(screen.getByTestId("prompt-cursor")).toBeInTheDocument();
  });

  it("splits the line around a mid-line cursor", () => {
    render(
      <PromptStrip cwd={null} branch={null} line={{ text: "abcdef", cursor: 3 }} onInput={noop} />,
    );
    expect(screen.getByTestId("prompt-line-text")).toHaveTextContent("abc");
    expect(screen.getByTestId("prompt-line")).toHaveTextContent("abcdef");
  });

  it("renders the supplied cwd and branch", () => {
    render(
      <PromptStrip
        cwd="/Users/ada/dev/shax"
        branch="feat/x"
        line={{ text: "", cursor: 0 }}
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
      <PromptStrip cwd={null} branch={null} line={{ text: "", cursor: 0 }} onInput={onInput} />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "a" });
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith(new TextEncoder().encode("a"));
  });

  it("maps Enter to CR for the shell", () => {
    const onInput = vi.fn();
    render(
      <PromptStrip cwd={null} branch={null} line={{ text: "", cursor: 0 }} onInput={onInput} />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "Enter" });
    expect(onInput).toHaveBeenCalledWith(new Uint8Array([0x0d]));
  });

  it("maps arrow keys to CSI sequences", () => {
    const onInput = vi.fn();
    render(
      <PromptStrip cwd={null} branch={null} line={{ text: "", cursor: 0 }} onInput={onInput} />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "ArrowUp" });
    expect(onInput).toHaveBeenCalledWith(new TextEncoder().encode("\x1b[A"));
  });

  it("ignores modifier-only events (no onInput call)", () => {
    const onInput = vi.fn();
    render(
      <PromptStrip cwd={null} branch={null} line={{ text: "", cursor: 0 }} onInput={onInput} />,
    );
    fireEvent.keyDown(screen.getByTestId("prompt-strip"), { key: "Shift", shiftKey: true });
    expect(onInput).not.toHaveBeenCalled();
  });

  it("is focusable (tabIndex=0) so it can claim focus when no input has happened yet", () => {
    render(<PromptStrip cwd={null} branch={null} line={{ text: "", cursor: 0 }} onInput={noop} />);
    expect(screen.getByTestId("prompt-strip")).toHaveAttribute("tabindex", "0");
  });
});
