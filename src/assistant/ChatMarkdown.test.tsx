import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  it("renders paragraphs and inline emphasis", () => {
    render(<ChatMarkdown text="Hello **world** and *friends*." />);
    const host = screen.getByTestId("chat-markdown");
    expect(host.querySelector("strong")?.textContent).toBe("world");
    expect(host.querySelector("em")?.textContent).toBe("friends");
  });

  it("renders fenced code blocks with a <pre><code> pair", () => {
    render(<ChatMarkdown text={"```\nconst x = 1;\n```"} />);
    const host = screen.getByTestId("chat-markdown");
    const pre = host.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.querySelector("code")?.textContent).toContain("const x = 1;");
  });

  it("renders GitHub-flavoured tables via remark-gfm", () => {
    const table = "| A | B |\n|---|---|\n| 1 | 2 |";
    render(<ChatMarkdown text={table} />);
    const host = screen.getByTestId("chat-markdown");
    expect(host.querySelector("table")).not.toBeNull();
    expect(host.querySelector("thead th")?.textContent).toBe("A");
  });

  it("keeps unordered and ordered lists as HTML lists", () => {
    render(<ChatMarkdown text={"- one\n- two\n- three"} />);
    const host = screen.getByTestId("chat-markdown");
    expect(host.querySelectorAll("ul li")).toHaveLength(3);
  });

  it("scripts pasted into markdown are stripped by DOMPurify", () => {
    render(<ChatMarkdown text={"Hello <script>alert('xss')</script> world"} />);
    const host = screen.getByTestId("chat-markdown");
    // <script> forbidden by the purifier — its presence would
    // mean the sanitiser is broken. We deliberately don't
    // assert on the surrounding "Hello"/"world" text because
    // remark's HTML handling can pull adjacent text into the
    // stripped node; the important guarantee is no live
    // script element made it through.
    expect(host.querySelector("script")).toBeNull();
    expect(host.innerHTML).not.toMatch(/<script\b/i);
  });

  it("javascript: URIs in links are stripped by DOMPurify", () => {
    render(<ChatMarkdown text="[click me](javascript:alert(1))" />);
    const host = screen.getByTestId("chat-markdown");
    const anchor = host.querySelector("a");
    // Either the anchor was removed or its href was blanked.
    // Either way, `javascript:` must not survive.
    if (anchor !== null) {
      expect(anchor.getAttribute("href")).not.toMatch(/^javascript:/i);
    }
  });

  it("safely handles partial markdown mid-stream (unclosed fence)", () => {
    // Should not throw; renders whatever's parseable.
    render(<ChatMarkdown text={"Here is code:\n```\nconst x"} />);
    expect(screen.getByTestId("chat-markdown")).toBeInTheDocument();
  });

  it("renders empty text without crashing", () => {
    render(<ChatMarkdown text="" />);
    expect(screen.getByTestId("chat-markdown")).toBeInTheDocument();
  });
});
