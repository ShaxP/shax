/**
 * PromptStrip unit tests (jsdom / Vitest).
 *
 * Visual-only mirror at slice 1.9a: assertions cover the cwd / branch
 * fallbacks, the placeholder rendering when nothing has been typed, and
 * the split-around-cursor rendering when there is text to show.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PromptStrip } from "./PromptStrip";

afterEach(() => cleanup());

describe("PromptStrip", () => {
  it("renders the wrapper and neutral fallbacks for cwd/branch", () => {
    render(<PromptStrip cwd={null} branch={null} line={{ text: "", cursor: 0 }} />);
    expect(screen.getByTestId("prompt-strip")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-cwd")).toHaveTextContent("—");
    expect(screen.getByTestId("prompt-branch")).toHaveTextContent("—");
  });

  it("shows the placeholder hint when the line is empty", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={{ text: "", cursor: 0 }} />);
    expect(screen.getByTestId("prompt-line")).toHaveTextContent("type a command");
    expect(screen.queryByTestId("prompt-cursor")).toBeNull();
  });

  it("renders the typed line with the cursor at the end by default", () => {
    render(<PromptStrip cwd="/tmp" branch="main" line={{ text: "ls -la", cursor: 6 }} />);
    expect(screen.getByTestId("prompt-line-text")).toHaveTextContent("ls -la");
    expect(screen.getByTestId("prompt-cursor")).toBeInTheDocument();
  });

  it("splits the line around a mid-line cursor", () => {
    render(<PromptStrip cwd={null} branch={null} line={{ text: "abcdef", cursor: 3 }} />);
    const line = screen.getByTestId("prompt-line");
    // before-cursor: "abc"
    expect(screen.getByTestId("prompt-line-text")).toHaveTextContent("abc");
    // The whole line still reads "abcdef" — before + cursor + after.
    expect(line).toHaveTextContent("abcdef");
  });

  it("renders the supplied cwd and branch", () => {
    render(
      <PromptStrip cwd="/Users/ada/dev/shax" branch="feat/x" line={{ text: "", cursor: 0 }} />,
    );
    expect(screen.getByTestId("prompt-cwd")).toHaveTextContent("/Users/ada/dev/shax");
    expect(screen.getByTestId("prompt-branch")).toHaveTextContent("feat/x");
  });
});
