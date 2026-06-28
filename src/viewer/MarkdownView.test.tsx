/**
 * Tests for the Markdown content renderer (M4 slice 4.2). The
 * critical-path concern here is DOMPurify sanitisation — markdown
 * in a webview is an injection surface. We verify the renderer
 * strips scripts, event handlers, and `javascript:` URLs.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./MarkdownView";

describe("MarkdownView", () => {
  it("renders headings and paragraphs", () => {
    render(<MarkdownView text={"# Hello\n\nworld"} />);
    const out = screen.getByTestId("markdown-rendered");
    expect(out.querySelector("h1")?.textContent).toBe("Hello");
    expect(out.querySelector("p")?.textContent).toBe("world");
  });

  it("renders GFM tables (remark-gfm)", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    render(<MarkdownView text={md} />);
    const table = screen.getByTestId("markdown-rendered").querySelector("table");
    expect(table).not.toBeNull();
  });

  it("strips embedded <script> tags", () => {
    const malicious = "Hello\n\n<script>window.compromised = true</script>";
    render(<MarkdownView text={malicious} />);
    const out = screen.getByTestId("markdown-rendered");
    expect(out.querySelector("script")).toBeNull();
    expect((window as unknown as { compromised?: true }).compromised).toBeUndefined();
  });

  it("strips javascript: URLs on links", () => {
    const md = "[click](javascript:alert(1))";
    render(<MarkdownView text={md} />);
    const a = screen.getByTestId("markdown-rendered").querySelector("a");
    // DOMPurify either drops the href or rewrites it; the only
    // wrong outcome is leaving the literal `javascript:` URL on.
    expect(a?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("does not surface inline event handlers", () => {
    // react-markdown's default config strips raw HTML before
    // DOMPurify even sees it (that's our first line of defence).
    // Verify the malicious markup is gone — either the anchor
    // doesn't appear at all, or it appears stripped of the
    // `onclick`. Both are acceptable; the only wrong outcome is
    // a live event handler in the DOM.
    const md = '<a onclick="boom()" href="https://example.com">x</a>';
    render(<MarkdownView text={md} />);
    const a = screen.getByTestId("markdown-rendered").querySelector("a");
    if (a !== null) {
      expect(a.getAttribute("onclick")).toBeNull();
    }
    // And no script anywhere either.
    expect(screen.getByTestId("markdown-rendered").querySelector("script")).toBeNull();
  });

  it("toggles between rendered and source", () => {
    render(<MarkdownView text={"# Title"} />);
    expect(screen.queryByTestId("markdown-rendered")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("markdown-toggle-source"));
    expect(screen.queryByTestId("markdown-rendered")).toBeNull();
    expect(screen.getByTestId("viewer")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("markdown-toggle-rendered"));
    expect(screen.queryByTestId("markdown-rendered")).toBeInTheDocument();
  });
});
