/**
 * Markdown content renderer (M4 slice 4.2; chrome stripped in
 * M4.5 slice 1).
 *
 * `react-markdown` (remark) converts the source into a React tree.
 * Markdown can carry raw HTML, which in a webview is a real
 * injection surface — every rendered fragment is sanitised with
 * DOMPurify before it's allowed into the DOM. We sanitise the
 * *whole rendered HTML string* once on each render, then drop it
 * in via `dangerouslySetInnerHTML`; that's safer than relying on
 * `react-markdown`'s own escape rules.
 *
 * The component renders *only* the rendered markdown. The
 * rendered ↔ source toggle that used to live here is now driven
 * by the BlockRow / Modal FMT/SRC/RAW lens, so two layers of
 * "which view?" chrome don't compete for the same decision.
 * Source view goes through `Viewer` directly when the lens
 * selects SRC.
 */

import { useMemo, type CSSProperties } from "react";
import { renderToString } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "../theme/syntax.css";
import "./MarkdownView.css";
import DOMPurify, { type Config as PurifyConfig } from "dompurify";

export interface MarkdownViewProps {
  text: string;
  /** Inline style for the wrapper. The modal host sets `flex: 1`
   *  so the view fills the modal panel. */
  style?: CSSProperties;
}

const SCROLL_HOST: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  background: "var(--pane)",
  padding: "16px 24px",
  fontFamily: "var(--font-ui)",
  fontSize: 14,
  color: "var(--fg)",
  lineHeight: 1.55,
};

// DOMPurify config: strict text content. We strip every script
// vector and event handler, keep typical markdown-y elements,
// and forbid the few that have historically carried payloads
// even with attribute scrubbing. `iframe`, `object`, `embed` are
// out; so is `style` (a CSS injection vector).
const PURIFY_CONFIG: PurifyConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
  FORBID_ATTR: ["style", "onerror", "onload", "onclick", "onmouseover", "onfocus"],
  // Allow `data:image/*` and `https://` / relative URLs in img / a;
  // strip everything else (notably `javascript:`).
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data):|[/.#]|$)/i,
};

export function MarkdownView({ text, style }: MarkdownViewProps): React.ReactElement {
  // Pre-render the markdown to an HTML string, then sanitise.
  // Memo on text so re-rendering the parent doesn't re-pay the
  // parse + sanitise cost when the text hasn't changed.
  const safeHtml = useMemo(() => {
    const dirty = renderToString(
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>,
    );
    return DOMPurify.sanitize(dirty, PURIFY_CONFIG);
  }, [text]);

  return (
    <div
      className="markdown-rendered"
      data-testid="markdown-rendered"
      style={{ ...SCROLL_HOST, ...style }}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}
