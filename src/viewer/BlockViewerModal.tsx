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
import {
  blockGetOutput,
  getBlockOutput,
  readFileBytes,
  type BlockSummary,
  type PtyId,
} from "../lib/ipc";
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
/**
 * Resolve the filename argument from a block's command into an
 * absolute path the backend can read. Absolute filenames are
 * passed through verbatim; relative filenames are joined with
 * the block's `cwd`. `~` expansion is not handled here (the
 * shell would have already expanded it before the command ran),
 * but a leading `~` is treated as relative.
 *
 * Returns `null` if we can't form a path — the modal then leaves
 * the captured (likely corrupted) bytes in place rather than
 * showing an empty view.
 */
// Exported for unit tests; not part of the module's public API.
export const __testing = { tokenizeCommand };

function resolveBlockPath(filename: string, cwd: string | null): string | null {
  if (filename.length === 0) return null;
  if (filename.startsWith("/")) return filename;
  if (cwd === null || cwd.length === 0) return null;
  // Trim a trailing slash from cwd so we don't produce `//x`.
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${base}/${filename}`;
}

/**
 * Shell-style word splitter. Honours the three sources of
 * whitespace-with-spaces-in-it the user actually types:
 *
 *   `cat foo\ bar.gif`         → ["cat", "foo bar.gif"]
 *   `cat "foo bar.gif"`        → ["cat", "foo bar.gif"]
 *   `cat 'foo bar.gif'`        → ["cat", "foo bar.gif"]
 *
 * Inside single quotes nothing is special (POSIX rule). Inside
 * double quotes `\` only escapes `\ " $ ` ` \n`. Outside quotes,
 * `\` escapes any single following character (including a
 * space, which is the case the slice-4.2 bug surfaced — a GIF
 * filename `Chainsaw\ Man\ GIF.gif` was being split into three
 * tokens by the previous whitespace-only splitter, so the modal
 * tried to read the file `Chainsaw\\` and got ENOENT).
 *
 * Not a full shell parser: pipelines, redirects, command
 * substitution, `$VAR` expansion are intentionally ignored —
 * the modal only needs the first filename, not a faithful
 * argv reconstruction.
 */
function tokenizeCommand(command: string | null): string[] {
  if (command === null || command.length === 0) return [];
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i] ?? "";
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < command.length) {
        const next = command[i + 1] ?? "";
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
          current += next;
          i += 2;
        } else {
          current += ch;
          i++;
        }
      } else if (ch === '"') {
        inDouble = false;
        i++;
      } else {
        current += ch;
        i++;
      }
      continue;
    }
    // Outside any quotes.
    if (ch === "\\" && i + 1 < command.length) {
      current += command[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
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

  // For image content the *captured* bytes are unreliable — the
  // PTY's line discipline (default ONLCR) mangles every `\n` in
  // binary data into `\r\n`, breaking PNG / JPEG / GIF signatures
  // and every internal length field. Bypass the capture by
  // reading the file straight from disk via the dedicated IPC
  // command. Falls back to captured bytes on read failure (path
  // moved, permission denied, file too large, no filename hint).
  //
  // We keep this as a *separate state* (`overrideBytes`) so the
  // initial render still uses the captured path until the disk
  // read resolves — that way text-content viewers don't wait on
  // a fs op they'll never use.
  const [overrideBytes, setOverrideBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    setOverrideBytes(null);
    if (contentType !== "image" && contentType !== "svg") return;
    if (filenameHint === null) return;
    const path = resolveBlockPath(filenameHint, block.cwd);
    if (path === null) return;
    let cancelled = false;
    void readFileBytes(path).then(
      (fileBytes) => {
        if (cancelled) return;
        if (fileBytes.length > 0) setOverrideBytes(fileBytes);
      },
      (err: unknown) => {
        if (cancelled) return;
        // Fallback to captured bytes is silent for the user, but
        // log so a developer can tell when the size-cap / perms
        // / path-resolution dropped us here (the captured bytes
        // are PTY-mangled for binary content).
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`viewer: read_file_bytes(${path}) failed: ${msg}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [contentType, filenameHint, block.cwd]);

  const renderBytes = overrideBytes ?? bytes;

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
          <ImageView
            bytes={renderBytes ?? bytes}
            kind="raster"
            filenameHint={filenameHint}
            style={{ flex: 1 }}
          />
        ) : contentType === "svg" ? (
          <ImageView bytes={renderBytes ?? bytes} kind="svg" style={{ flex: 1 }} />
        ) : contentType === "markdown" && text !== null ? (
          <MarkdownView text={text} style={{ flex: 1 }} />
        ) : (
          <Viewer text={text ?? ""} language={language} style={{ flex: 1 }} />
        )}
      </div>
    </div>
  );
}
