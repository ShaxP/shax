/**
 * Modal host that opens a captured block's output in the slice-4.1
 * CodeMirror viewer. Replaces the inline expanded-output view for
 * blocks where the user explicitly asks for "open" — non-cat
 * blocks still have the inline expand on the row.
 *
 * Lifecycle:
 *   - Caller passes `block` (summary) and optionally a `pty` for
 *     live block fetches. We fetch the captured bytes via the
 *     existing IPC (`getBlockOutput` per-pty, `blockGetOutput` by
 *     id when the pane is gone) and decode to text.
 *   - The viewer renders the text with a language detected from
 *     `block.command`'s argv + content sniffing.
 *   - Esc, backdrop click, or the close button dismisses.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { blockGetOutput, getBlockOutput, type BlockSummary, type PtyId } from "../lib/ipc";
import { detectContentType, firstFilenameArg } from "./detectContentType";
import { detectLanguage } from "./detectLanguage";
import { ImageView } from "./ImageView";
import { MarkdownView } from "./MarkdownView";
import { stripAnsi } from "./stripAnsi";
import { Viewer } from "./Viewer";

export interface BlockViewerModalProps {
  block: BlockSummary;
  /** Live pane id, if the block's originating pane is still alive in
   *  this session. When `null` we fetch by block id straight from
   *  the persistent store. */
  pty: PtyId | null;
  onClose: () => void;
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.5)",
  zIndex: 1500,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const PANEL: CSSProperties = {
  width: "min(1080px, 92vw)",
  height: "min(720px, 86vh)",
  display: "flex",
  flexDirection: "column",
  background: "var(--surface)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius)",
  boxShadow: "0 18px 48px rgba(0, 0, 0, 0.5)",
  overflow: "hidden",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  background: "var(--pane2)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
};

const TITLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "var(--font-mono)",
  color: "var(--fg)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const CLOSE_BTN: CSSProperties = {
  appearance: "none",
  background: "transparent",
  border: "1px solid var(--border-strong)",
  color: "var(--fg-dim)",
  borderRadius: 3,
  padding: "3px 9px",
  fontFamily: "var(--font-ui)",
  fontSize: 11,
  cursor: "pointer",
};

const STATUS_LINE: CSSProperties = {
  padding: 24,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-faint)",
};

/**
 * Best-effort split of a command string into argv-ish tokens.
 * Real shells parse quoting, escapes, and backticks; the viewer
 * just needs the first non-flag positional, so a whitespace split
 * with quote stripping is good enough. We don't try to handle
 * pipelines (`cat foo | jq .`) — for those, the formatter system
 * (4.3) will pick up via a richer matcher.
 */
function tokenizeCommand(command: string | null): string[] {
  if (command === null || command.length === 0) return [];
  // Trim surrounding quotes off each token; leave embedded quotes
  // alone since we're only using this for path extraction.
  return command
    .trim()
    .split(/\s+/)
    .map((tok) => tok.replace(/^['"]/, "").replace(/['"]$/, ""))
    .filter((tok) => tok.length > 0);
}

export function BlockViewerModal({
  block,
  pty,
  onClose,
}: BlockViewerModalProps): React.ReactElement {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes; ignore key events that originated from inside the
  // viewer (its own Esc handlers in vim normal-mode etc. take
  // precedence). The viewer wrapper stops propagation for other
  // keys; Esc bubbles up here.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Fetch the block's captured bytes. The two IPC paths exist
  // because a still-live pane keeps its bytes in memory under
  // a `(pty, block)` key; once the pane is gone we have to go
  // through the persistent store by id alone.
  useEffect(() => {
    let cancelled = false;
    const fetch = pty !== null ? getBlockOutput(pty, block.id) : blockGetOutput(block.id);
    fetch.then(
      (b) => {
        if (cancelled) return;
        setBytes(b);
      },
      (e) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [block.id, pty]);

  // Tokenised argv from the block's command. Cheap; memoise so
  // the render-time detection passes get a stable input.
  const argv = useMemo(() => tokenizeCommand(block.command), [block.command]);

  // Decode bytes to text *only* when we know we'll need a text
  // renderer. Image bytes never get decoded — utf-8 over a PNG
  // would just produce mojibake and waste CPU.
  const contentType = useMemo(() => {
    if (bytes === null) return "code" as const;
    // SVG sniff needs at least the head of the bytes as text, so
    // we peek at the first KiB only.
    const headBytes = bytes.subarray(0, 1024);
    const headText = TEXT_DECODER.decode(headBytes);
    return detectContentType({ bytes, text: headText, argv });
  }, [bytes, argv]);

  const text = useMemo(() => {
    if (bytes === null) return null;
    if (contentType === "image") return null;
    // Strip ANSI / OSC at the modal layer so every text-based
    // renderer downstream (Viewer, MarkdownView) gets clean
    // input. zsh's missing-newline indicator
    // (`\x1b[1m\x1b[7m%\x1b[27m…`) is the most common source of
    // these in captured block bytes; without stripping here, the
    // markdown renderer would surface them as literal text.
    return stripAnsi(TEXT_DECODER.decode(bytes));
  }, [bytes, contentType]);

  const language = useMemo(() => {
    if (text === null) return "plaintext" as const;
    return detectLanguage(text, argv);
  }, [text, argv]);

  const filenameHint = useMemo(() => firstFilenameArg(argv), [argv]);

  return (
    <div
      data-testid="block-viewer-modal"
      style={BACKDROP}
      onClick={(e) => {
        // Backdrop click closes; clicks inside the panel don't.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} style={PANEL}>
        <div style={HEADER}>
          <span style={TITLE} data-testid="block-viewer-title">
            {block.command ?? "(no command)"}
          </span>
          <button
            type="button"
            data-testid="block-viewer-close"
            style={CLOSE_BTN}
            onClick={onClose}
          >
            close · esc
          </button>
        </div>
        {error !== null ? (
          <div style={STATUS_LINE} data-testid="block-viewer-error">
            Couldn't load output: {error}
          </div>
        ) : bytes === null ? (
          <div style={STATUS_LINE} data-testid="block-viewer-loading">
            Loading…
          </div>
        ) : contentType === "image" ? (
          <ImageView bytes={bytes} kind="raster" filenameHint={filenameHint} style={{ flex: 1 }} />
        ) : contentType === "svg" ? (
          <ImageView bytes={bytes} kind="svg" style={{ flex: 1 }} />
        ) : contentType === "markdown" && text !== null ? (
          <MarkdownView text={text} style={{ flex: 1 }} />
        ) : (
          <Viewer text={text ?? ""} language={language} style={{ flex: 1 }} />
        )}
      </div>
    </div>
  );
}
