/**
 * Markdown content renderer (M4 slice 4.2).
 *
 * `react-markdown` (remark) converts the source into a React tree.
 * Markdown can carry raw HTML, which in a webview is a real
 * injection surface — every rendered fragment is sanitised with
 * DOMPurify before it's allowed into the DOM. We sanitise the
 * *whole rendered HTML string* once on each render, then drop it
 * in via `dangerouslySetInnerHTML`; that's safer than relying on
 * `react-markdown`'s own escape rules to keep us out of trouble
 * with embedded `<script>` or `onerror=`.
 *
 * The header includes a rendered ↔ source toggle so the user can
 * fall back to the raw markdown text (in the slice-4.1
 * CodeMirror viewer) when they'd rather read or copy the source.
 */

import { useMemo, useState, type CSSProperties } from "react";
import { renderToString } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify, { type Config as PurifyConfig } from "dompurify";
import { Viewer } from "./Viewer";

export interface MarkdownViewProps {
  text: string;
  /** Inline style for the wrapper. The modal host sets `flex: 1`
   *  so the view fills the modal panel. */
  style?: CSSProperties;
}

const WRAPPER: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  background: "var(--pane2)",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-ui)",
  fontSize: 11,
  color: "var(--fg-faint)",
  letterSpacing: 0.4,
  textTransform: "uppercase",
};

const TOGGLE_BUTTON: CSSProperties = {
  appearance: "none",
  background: "transparent",
  border: "1px solid var(--border-strong)",
  borderRadius: 3,
  padding: "1px 8px",
  fontSize: 11,
  cursor: "pointer",
  color: "var(--fg-dim)",
  fontFamily: "var(--font-ui)",
  letterSpacing: 0.4,
  textTransform: "uppercase",
};

const TOGGLE_BUTTON_ACTIVE: CSSProperties = {
  ...TOGGLE_BUTTON,
  background: "var(--accent-soft)",
  borderColor: "var(--accent)",
  color: "var(--fg)",
};

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
  const [mode, setMode] = useState<"rendered" | "source">("rendered");

  // Pre-render the markdown to an HTML string, then sanitise.
  // Memo on text so toggling the mode doesn't re-pay the parse +
  // sanitise cost when we switch back to "rendered".
  const safeHtml = useMemo(() => {
    if (mode !== "rendered") return "";
    const dirty = renderToString(<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>);
    return DOMPurify.sanitize(dirty, PURIFY_CONFIG);
  }, [text, mode]);

  return (
    <div style={{ ...WRAPPER, ...style }} data-testid="markdown-view">
      <div style={HEADER}>
        <span>markdown</span>
        <span style={{ marginLeft: "auto" }}>
          <button
            type="button"
            data-testid="markdown-toggle-rendered"
            style={mode === "rendered" ? TOGGLE_BUTTON_ACTIVE : TOGGLE_BUTTON}
            onClick={() => setMode("rendered")}
          >
            rendered
          </button>
          <span style={{ display: "inline-block", width: 4 }} />
          <button
            type="button"
            data-testid="markdown-toggle-source"
            style={mode === "source" ? TOGGLE_BUTTON_ACTIVE : TOGGLE_BUTTON}
            onClick={() => setMode("source")}
          >
            source
          </button>
        </span>
      </div>
      {mode === "rendered" ? (
        <div
          className="markdown-rendered"
          style={SCROLL_HOST}
          data-testid="markdown-rendered"
          dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
      ) : (
        <Viewer text={text} language="markdown" style={{ flex: 1 }} />
      )}
    </div>
  );
}
