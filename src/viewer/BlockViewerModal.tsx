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
import { findFormatter, invokeFormatter, isPass, type FormatterContext } from "../formatters";
import { hasDistinctSource } from "./ContentView";
import { shellTokenize } from "../lib/shellTokenize";
import { detectContentType, firstFilenameArg } from "./detectContentType";
import { detectLanguage } from "./detectLanguage";
import { ImageView } from "./ImageView";
import { MarkdownView } from "./MarkdownView";
import { stripAnsi, stripShellArtifacts } from "./stripAnsi";
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

const TOGGLE_GROUP: CSSProperties = {
  display: "flex",
  padding: 2,
  border: "1px solid var(--border-strong)",
  borderRadius: 4,
  gap: 0,
};

const TOGGLE_BASE: CSSProperties = {
  appearance: "none",
  border: "none",
  background: "transparent",
  fontFamily: "var(--font-ui)",
  fontSize: 10,
  letterSpacing: 0.5,
  padding: "2px 8px",
  borderRadius: 3,
  cursor: "pointer",
};

const TOGGLE_ON: CSSProperties = {
  ...TOGGLE_BASE,
  background: "var(--accent)",
  color: "var(--bg)",
};

const TOGGLE_OFF: CSSProperties = {
  ...TOGGLE_BASE,
  color: "var(--fg-faint)",
};

const COMMUNITY_PILL: CSSProperties = {
  marginLeft: 8,
  padding: "1px 6px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  color: "var(--fg-faint)",
  fontFamily: "var(--font-ui)",
  fontSize: 10,
  letterSpacing: "0.05em",
  textTransform: "lowercase",
  cursor: "help",
};

// Wrapper around a modal-rendered formatter. The flex:1 sizing
// + `--formatter-max-height: 100%` override lets each formatter's
// own `max-height` track the modal panel instead of the
// fixed-pixel cap they use inside the block list.
const FORMATTER_HOST: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: "10px 14px",
  // Custom properties for the formatter's layout. `--formatter-flex`
  // flips the cat formatter's host from a fixed-height box to a
  // flex item that grows to fill the modal panel (mirrors the
  // fit-to-pane maximised row in BlockRow). CSSProperties type
  // doesn't enumerate custom properties; the DOM accepts them fine.
  ["--formatter-flex" as never]: "1 1 0",
  ["--formatter-max-height" as never]: "100%",
  display: "flex",
  flexDirection: "column",
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
function resolveBlockPath(filename: string, cwd: string | null): string | null {
  if (filename.length === 0) return null;
  if (filename.startsWith("/")) return filename;
  if (cwd === null || cwd.length === 0) return null;
  // Trim a trailing slash from cwd so we don't produce `//x`.
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${base}/${filename}`;
}

export function BlockViewerModal({
  block,
  pty,
  onClose,
}: BlockViewerModalProps): React.ReactElement {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes the modal. Registered in **capture** phase so we
  // see the keystroke before PromptStrip's React onKeyDown — that
  // handler maps Esc to byte 0x1b and calls stopPropagation, which
  // in React 17+ also stops the native event from reaching window
  // bubble listeners. Without capture, an Esc with the prompt
  // strip focused would just hit the PTY and the modal would stay
  // open. The Viewer-internal Esc (vim normal-mode) is dispatched
  // at the host element below this listener and short-circuits
  // before bubbling up, so this doesn't double-fire when the user
  // intended an in-editor Esc.
  // Key handler — Esc closes, Tab cycles the FMT/SRC/RAW lens.
  // Registered in **capture** phase so we beat PromptStrip's
  // React onKeyDown (which maps Esc to byte 0x1b and stops
  // propagation) and the browser's default Tab focus-shift.
  // Refs keep the latest state visible to the closure without
  // re-registering on every render.
  const modalModeRef = useRef<"fmt" | "src" | "info" | "raw">("fmt");
  const modalSrcAvailableRef = useRef(false);
  const modalInfoAvailableRef = useRef(false);
  const hasFormatterRef = useRef(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // Viewer.tsx explicitly does NOT stopPropagation for Esc
        // but does for other keys — Esc anywhere (prompt strip,
        // editor host, backdrop) closes the modal.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Cycle the lens. Without a formatter the toggle isn't
        // rendered, so let Tab fall through (the modal has no
        // other focusable chrome that benefits from default
        // Tab behaviour either, but we don't want to swallow
        // keystrokes we have no use for).
        if (!hasFormatterRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        const cycle: ("fmt" | "src" | "info" | "raw")[] = [
          "fmt",
          ...(modalSrcAvailableRef.current ? (["src"] as const) : []),
          ...(modalInfoAvailableRef.current ? (["info"] as const) : []),
          "raw",
        ];
        const idx = cycle.indexOf(modalModeRef.current);
        const next = cycle[(idx + 1) % cycle.length] ?? "fmt";
        setModalMode(next);
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
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
  const argv = useMemo(() => shellTokenize(block.command), [block.command]);

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

  const filenameHint = useMemo(() => firstFilenameArg(argv), [argv]);

  // Disk-read override (defined further down in the file). Declare
  // here so the `text` / `language` memos can read from it.
  const [overrideBytes, setOverrideBytes] = useState<Uint8Array | null>(null);
  const renderBytes = overrideBytes ?? bytes;

  const text = useMemo(() => {
    if (renderBytes === null) return null;
    if (contentType === "image") return null;
    // Prefer the disk-read override (clean file bytes) over the
    // captured stdout (which carries zsh's missing-newline
    // indicator `%` and other shell artifacts). ANSI stripping
    // still applies for the captured-fallback path.
    return stripAnsi(TEXT_DECODER.decode(renderBytes));
  }, [renderBytes, contentType]);

  // Captured-only text: what the command actually wrote to its
  // stdout (ANSI-stripped). Distinct from `text` above (which
  // prefers the disk-read override for the file-viewer fallback).
  // The RAW-mode branch of the modal uses this so "raw" on a
  // formatter block shows the *command's* output, not the file
  // the command happened to operate on.
  const capturedText = useMemo(() => {
    if (bytes === null) return "";
    return stripShellArtifacts(stripAnsi(TEXT_DECODER.decode(bytes)));
  }, [bytes]);

  const language = useMemo(() => {
    if (text === null) return "plaintext" as const;
    return detectLanguage(text, argv);
  }, [text, argv]);

  // Formatter lookup for the modal. ctx.stdout must be the
  // *captured* command output, not the disk-read override —
  // formatters that consume stdout (`wc`, future `json`, etc.)
  // expect to parse what the command produced. The disk-read
  // override exists for the *fallback* content-type renderers
  // (MarkdownView / Viewer) when the user opens a cat-like
  // block, and feeding it as ctx.stdout would mis-render any
  // formatter that doesn't re-probe (the wc sample, for
  // example, would parse README.md content as if it were wc's
  // tabular output). Formatters that re-probe (ls, git status,
  // git diff) don't read ctx.stdout, so they're unaffected.
  // The `pty` may be `null` (block opened from search after
  // the source pane closed); `paneId: ""` is the convention.
  const formatterCtx: FormatterContext | null = useMemo(() => {
    if (bytes === null) return null;
    const rawText = TEXT_DECODER.decode(bytes);
    const capturedText = stripShellArtifacts(stripAnsi(rawText));
    return {
      argv,
      cwd: block.cwd,
      env: {},
      exitCode: block.exit_code,
      durationMs: block.duration_ms,
      stdout: capturedText,
      stderr: "",
      rawAnsi: rawText,
      paneId: pty ?? "",
    };
  }, [bytes, argv, block.cwd, block.exit_code, block.duration_ms, pty]);

  const modalFormatter = useMemo(() => {
    if (formatterCtx === null) return null;
    const f = findFormatter(formatterCtx);
    if (f === null) return null;
    // `useInModal === false` opt-outs (cat / bat) fall through to
    // the content-type routing below — that path renders rendered
    // markdown / images / etc., which is what the user actually
    // wants in the modal.
    if (f.useInModal === false) return null;
    return f;
  }, [formatterCtx]);

  // FMT/SRC/INFO/RAW toggle local to the modal. Defaults to
  // FMT when a formatter applies. Hidden entirely when no
  // formatter matches — non-formatter blocks keep today's look
  // exactly. SRC / INFO buttons only appear when the content
  // type / formatter opts in.
  const [modalMode, setModalMode] = useState<"fmt" | "src" | "info" | "raw">("fmt");
  modalModeRef.current = modalMode;
  // When opening a new block, snap back to FMT — the previous
  // toggle state is meaningless across blocks.
  useEffect(() => {
    setModalMode("fmt");
  }, [block.id]);

  const modalSrcAvailable = modalFormatter !== null && hasDistinctSource(contentType);
  const modalInfoAvailable =
    modalFormatter !== null &&
    modalFormatter.supportsInfo !== undefined &&
    formatterCtx !== null &&
    modalFormatter.supportsInfo(formatterCtx);
  // Mirror toggle state into refs so the capture-phase key
  // handler picks the latest values without re-registering on
  // every render.
  modalSrcAvailableRef.current = modalSrcAvailable;
  modalInfoAvailableRef.current = modalInfoAvailable;
  hasFormatterRef.current = modalFormatter !== null;

  const formatterOutput = useMemo(() => {
    if (modalFormatter === null || formatterCtx === null) return null;
    if (modalMode === "raw") return null;
    const lens = modalMode === "src" ? "source" : modalMode === "info" ? "info" : "rendered";
    const result = invokeFormatter(modalFormatter, formatterCtx, lens);
    return isPass(result) ? null : result;
  }, [modalFormatter, formatterCtx, modalMode]);

  // Whenever we can resolve a filename, prefer reading it
  // straight from disk over the captured stdout — for *every*
  // detected content type, not just images. The captured-stdout
  // path has two failure modes that affect the viewer:
  //
  //   1. PTY line discipline (default ONLCR) converts `\n` →
  //      `\r\n` on the way out, corrupting binary content
  //      (PNG / JPEG / GIF signatures, internal length fields).
  //   2. Shell prompt artifacts leak in — zsh's
  //      "no-trailing-newline" indicator (`%` in inverse video)
  //      ends up at the end of any command whose stdout doesn't
  //      end with `\n`. ANSI stripping cleans the styling but
  //      the literal `%` survives, polluting Markdown / source
  //      file views.
  //
  // Disk bytes are authoritative. Falls back to the captured
  // path silently when there's no filename to read (`ls`, piped
  // commands, `echo …`) or when the read fails (file moved,
  // permission denied, file too large).
  //
  // Kept as a separate state (`overrideBytes`, declared with the
  // text memo above) so the initial render uses the captured
  // bytes until the async disk read resolves — avoids a
  // "loading…" double-flash for blocks whose captured bytes
  // were already adequate.
  useEffect(() => {
    setOverrideBytes(null);
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
        // / path-resolution dropped us here.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`viewer: read_file_bytes(${path}) failed: ${msg}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [contentType, filenameHint, block.cwd]);

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
          {modalFormatter !== null && (
            <>
              <div data-testid="block-viewer-fmt-raw" style={TOGGLE_GROUP}>
                <button
                  type="button"
                  data-testid="block-viewer-fmt-pill"
                  style={modalMode === "fmt" ? TOGGLE_ON : TOGGLE_OFF}
                  data-active={modalMode === "fmt" ? "true" : "false"}
                  title={`formatter: ${modalFormatter.name}`}
                  onClick={() => setModalMode("fmt")}
                >
                  FMT
                </button>
                {modalSrcAvailable && (
                  <button
                    type="button"
                    data-testid="block-viewer-src-pill"
                    style={modalMode === "src" ? TOGGLE_ON : TOGGLE_OFF}
                    data-active={modalMode === "src" ? "true" : "false"}
                    title="View source (markdown source, image hex, …)"
                    onClick={() => setModalMode("src")}
                  >
                    SRC
                  </button>
                )}
                {modalInfoAvailable && (
                  <button
                    type="button"
                    data-testid="block-viewer-info-pill"
                    style={modalMode === "info" ? TOGGLE_ON : TOGGLE_OFF}
                    data-active={modalMode === "info" ? "true" : "false"}
                    title="File info (name, size, dates, format-specific stats)"
                    onClick={() => setModalMode("info")}
                  >
                    INFO
                  </button>
                )}
                <button
                  type="button"
                  data-testid="block-viewer-raw-pill"
                  style={modalMode === "raw" ? TOGGLE_ON : TOGGLE_OFF}
                  data-active={modalMode === "raw" ? "true" : "false"}
                  onClick={() => setModalMode("raw")}
                >
                  RAW
                </button>
              </div>
              {modalFormatter.source === "community" && (
                <span
                  data-testid="block-viewer-community-pill"
                  style={COMMUNITY_PILL}
                  title="Add-on — runs in an isolated sandbox with no access to your files, network, or app internals."
                >
                  add-on
                </span>
              )}
            </>
          )}
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
        ) : formatterOutput !== null ? (
          // FMT in modal: uncap the formatter's own height via the
          // CSS variable so it fills the panel. The wrapper is a
          // flex:1 column so the formatter's overflow:auto scrolls
          // inside the modal rather than the modal scrolling
          // itself.
          <div data-testid="block-viewer-formatter" style={FORMATTER_HOST}>
            {formatterOutput}
          </div>
        ) : modalFormatter !== null && modalMode === "raw" ? (
          // RAW on a formatter block — show the *command's*
          // captured output, not the disk-read fallback. Without
          // this branch a wc / json / ls block in RAW would
          // render the file the command happened to operate on
          // (rendered markdown for `wc README.md`, etc.), which
          // is misleading.
          <Viewer text={capturedText} language={"plaintext" as const} style={{ flex: 1 }} />
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
