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

// ── M12.6c: shell fences route through the Shax tokenizer ─────────

describe("ChatMarkdown / shell fences (M12.6c)", () => {
  /** All four aliases the interceptor recognises should behave
   *  identically. Parametrised so a regression in one language
   *  registration shows up as one specific failure, not four. */
  const SHELL_ALIASES = ["bash", "sh", "shell", "zsh"] as const;

  for (const lang of SHELL_ALIASES) {
    it(`\`\`\`${lang} fences render with shax-syntax-* classes, not hljs`, () => {
      render(<ChatMarkdown text={`\`\`\`${lang}\ngit commit -m "hi"\n\`\`\``} />);
      const host = screen.getByTestId("chat-markdown");
      const code = host.querySelector("pre code");
      expect(code).not.toBeNull();
      // Shax classes present.
      expect(code?.querySelector(".shax-syntax-command")?.textContent).toBe("git");
      expect(code?.querySelector(".shax-syntax-subcommand")?.textContent).toBe("commit");
      expect(code?.querySelector(".shax-syntax-flag")?.textContent).toBe("-m");
      expect(code?.querySelector(".shax-syntax-string")?.textContent).toBe('"hi"');
      // hljs classes absent — the interceptor bypassed hljs for
      // this fence.
      expect(code?.querySelector('[class*="hljs-"]')).toBeNull();
    });
  }

  it("non-shell fences (e.g. rust) still use hljs classes", () => {
    render(<ChatMarkdown text={"```rust\nlet x: u32 = 1;\n```"} />);
    const host = screen.getByTestId("chat-markdown");
    const code = host.querySelector("pre code");
    expect(code).not.toBeNull();
    // hljs classes present for rust.
    expect(code?.querySelector('[class*="hljs-"]')).not.toBeNull();
    // Shax syntax classes absent — the interceptor left hljs
    // alone for non-shell languages.
    expect(code?.querySelector('[class*="shax-syntax-"]')).toBeNull();
  });

  it("mixed shell + rust in the same message: each fence uses its own renderer", () => {
    const md = "```bash\nls -la\n```\n\n```rust\nlet x = 1;\n```";
    render(<ChatMarkdown text={md} />);
    const host = screen.getByTestId("chat-markdown");
    const codes = host.querySelectorAll("pre code");
    expect(codes).toHaveLength(2);
    // First code block is bash → Shax classes.
    expect(codes[0]?.querySelector(".shax-syntax-command")?.textContent).toBe("ls");
    expect(codes[0]?.querySelector('[class*="hljs-"]')).toBeNull();
    // Second is rust → hljs classes.
    expect(codes[1]?.querySelector('[class*="hljs-"]')).not.toBeNull();
    expect(codes[1]?.querySelector('[class*="shax-syntax-"]')).toBeNull();
  });

  it("unfenced inline `code` stays plain (no shell interception)", () => {
    render(<ChatMarkdown text="Try `git status` for details." />);
    const host = screen.getByTestId("chat-markdown");
    // Inline code has no `language-*` class, so the interceptor's
    // regex doesn't match and it renders as a plain <code>.
    const code = host.querySelector("code");
    expect(code?.textContent).toBe("git status");
    expect(code?.querySelector('[class*="shax-syntax-"]')).toBeNull();
    expect(code?.querySelector('[class*="hljs-"]')).toBeNull();
  });

  it("unknown language (e.g. `foo`) falls through to hljs (auto-detect)", () => {
    // rehype-highlight auto-detects language when the fence tag
    // isn't a registered one. Behaviour depends on hljs's picker;
    // the guarantee that matters here is we DON'T route unknown
    // languages through our shell tokenizer.
    render(<ChatMarkdown text={"```foo\nsome text\n```"} />);
    const host = screen.getByTestId("chat-markdown");
    const code = host.querySelector("pre code");
    expect(code?.querySelector('[class*="shax-syntax-"]')).toBeNull();
  });

  it("multi-line shell fence: each line tokenizes with its own segment", () => {
    // The tokenizer treats `\n` as a segment reset (M12.5 spec),
    // so `echo` on line 2 gets `command` color despite being
    // preceded by `ls` on line 1.
    render(<ChatMarkdown text={"```bash\nls -la\necho done\n```"} />);
    const host = screen.getByTestId("chat-markdown");
    const commands = host.querySelectorAll("pre code .shax-syntax-command");
    const commandTexts = Array.from(commands).map((el) => el.textContent);
    expect(commandTexts).toContain("ls");
    expect(commandTexts).toContain("echo");
  });

  it("fidelity fallback: an unbalanced quote still renders the fence", () => {
    // The tokenizer never throws (M12.5 contract), but even if
    // it did, `renderShellSpans` catches and returns raw text.
    // Regardless: the fence must render its content, even if
    // colouring degrades to monochrome.
    render(<ChatMarkdown text={'```bash\necho "unterminated\n```'} />);
    const host = screen.getByTestId("chat-markdown");
    const code = host.querySelector("pre code");
    // The raw text is present regardless of colouring.
    expect(code?.textContent).toContain('echo "unterminated');
  });
});
