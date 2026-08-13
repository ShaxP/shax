/**
 * Markdown renderer for assistant messages.
 *
 * Follows the same pattern as `viewer/MarkdownView`:
 * `react-markdown` → HTML string → DOMPurify → dropped in via
 * `dangerouslySetInnerHTML`. The chat surface has slightly
 * different visual needs though:
 *
 *   - Tighter spacing (bubble, not a document).
 *   - Text sizing that matches the chat bubble font.
 *   - Streaming tolerance: react-markdown handles unclosed
 *     fences and lists sensibly during streaming — it just
 *     renders what's there and recovers when complete.
 *
 * We sanitise on every render even during streaming; the
 * cost is negligible for the short-message case and avoids
 * having to reason about "sanitise only when done".
 *
 * M12.6c: shell fences (` ```bash `, ` ```sh `, ` ```shell `,
 * ` ```zsh `) get intercepted before hljs runs and rendered
 * with the same syntax palette the prompt strip / block
 * header / search overlay use. See spec §18 D6 for the
 * design rationale. Other-language fences still use hljs.
 */

import { useMemo, type CSSProperties, type ReactNode } from "react";
import DOMPurify, { type Config as PurifyConfig } from "dompurify";
import { renderToString } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { tokenize, type SyntaxKind } from "../panes/promptSyntax";
import "../theme/syntax.css";
import "./ChatMarkdown.css";

export interface ChatMarkdownProps {
  text: string;
  style?: CSSProperties;
}

// Same strict sanitiser as MarkdownView. Chat content is
// untrusted (comes from the AI); the safe-URI regex allows
// the usual `https`, `mailto`, and relative paths.
const PURIFY_CONFIG: PurifyConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
  FORBID_ATTR: ["style", "onerror", "onload", "onclick", "onmouseover", "onfocus"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data):|[/.#]|$)/i,
};

/** Language aliases that should route through our shell tokenizer
 *  instead of hljs. Matches what react-markdown / rehype-highlight
 *  set as `className="language-<name>"`. */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh"]);

/** Map a syntax kind to a CSS class. Class-based (not inline-style)
 *  so the output survives DOMPurify's `style` attribute stripping —
 *  chat runs through `renderToString → sanitise → innerHTML`, and
 *  the sanitiser strips inline styles from all elements for defence
 *  in depth. `null` (plain text / tokenizer failure) yields no class
 *  so the run renders in the ambient `--fg`. */
function syntaxClass(kind: SyntaxKind | null): string | undefined {
  return kind === null || kind === "text" ? undefined : `shax-syntax-${kind}`;
}

/** Render a shell command line with `shax-syntax-*` class-tagged
 *  spans. Same tokenizer as `CommandSpans`, but emits classes
 *  instead of inline styles so the output survives the sanitiser.
 *
 *  Fidelity fallback: any tokenizer throw drops the whole block to
 *  plain text — the fence still renders, just uncoloured. */
function renderShellSpans(text: string): ReactNode {
  let tokens;
  try {
    tokens = tokenize(text);
  } catch {
    return text;
  }
  if (tokens.length === 0) return text;
  return tokens.map((tok, i) => {
    const cls = syntaxClass(tok.kind);
    const chunk = text.slice(tok.start, tok.end);
    return cls === undefined ? (
      chunk
    ) : (
      <span key={i} className={cls}>
        {chunk}
      </span>
    );
  });
}

/** Extract raw text from react-markdown's `children` for a code
 *  block. When rehype-highlight has been told (via `plainText`) to
 *  skip a language, children is a plain string. This helper is a
 *  belt-and-suspenders guard for edge cases where children might
 *  be an array or an element tree — we walk and concatenate. */
function textOf(children: ReactNode): string {
  if (children === null || children === undefined) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (typeof children === "object" && "props" in children) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    return textOf(props?.children);
  }
  return "";
}

/** react-markdown `code` component override. Fenced blocks whose
 *  language is in `SHELL_LANGS` render via our shell tokenizer;
 *  everything else falls through to react-markdown's default
 *  render (which includes rehype-highlight's `hljs-*` classes). */
const codeComponent: Components["code"] = ({ className, children, ...rest }) => {
  const match = /language-([\w-]+)/.exec(className ?? "");
  const lang = match?.[1]?.toLowerCase();
  if (lang !== undefined && SHELL_LANGS.has(lang)) {
    const raw = textOf(children).replace(/\n$/, "");
    return <code className={className}>{renderShellSpans(raw)}</code>;
  }
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
};

// Passed as `components` prop. Kept as a module-level constant so
// react-markdown doesn't re-create the mapping on every render.
const MARKDOWN_COMPONENTS: Components = { code: codeComponent };

// Passed as options to rehype-highlight. Shell fences are excluded
// from hljs processing so `codeComponent` receives raw text
// (children is a plain string) instead of pre-highlighted span
// tree, avoiding a redundant tokenize-then-discard cycle.
const REHYPE_HIGHLIGHT_OPTIONS = {
  plainText: ["bash", "sh", "shell", "zsh"],
} as const;

export function ChatMarkdown({ text, style }: ChatMarkdownProps): React.ReactElement {
  const safeHtml = useMemo(() => {
    const dirty = renderToString(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, REHYPE_HIGHLIGHT_OPTIONS]]}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>,
    );
    return DOMPurify.sanitize(dirty, PURIFY_CONFIG);
  }, [text]);

  return (
    <div
      className="chat-markdown"
      data-testid="chat-markdown"
      style={style}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}
