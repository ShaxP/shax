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
 */

import { useMemo, type CSSProperties } from "react";
import DOMPurify, { type Config as PurifyConfig } from "dompurify";
import { renderToString } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/atom-one-dark.css";
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

export function ChatMarkdown({ text, style }: ChatMarkdownProps): React.ReactElement {
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
      className="chat-markdown"
      data-testid="chat-markdown"
      style={style}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}
