/**
 * `cat` / `bat` content-aware formatter (M4 + M4.5 slice 1).
 *
 * Routes the cat'd file's bytes through the shared
 * `ContentView` — markdown renders, images display inline,
 * SVG sanitises, source code goes through CodeMirror with the
 * detected language. Same routing the modal uses, so inline
 * and modal stay in sync.
 *
 * Disk-reads the file (via the slice-4.2 `read_file_bytes`
 * IPC) so binary content isn't subject to PTY corruption
 * (ONLCR turns every `\n` into `\r\n`, mangling every PNG /
 * JPEG / GIF signature). Falls back to the captured stdout
 * silently when the read fails — the user still sees
 * *something*, just less faithful.
 *
 * The `lens` parameter selects between rendered (FMT) and
 * source (SRC) views. RAW is handled by the surface (BlockRow
 * / modal), not here.
 *
 * `useInModal: true` so the modal defers to this formatter
 * rather than duplicating the content-type routing.
 */

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { readFileBytes, statFile, type BlockId, type FileStat } from "../lib/ipc";
import { buildMetadata } from "../metadata/buildMetadata";
import { MetadataRenderer } from "../metadata/renderMetadata";
import { ContentView, type ContentLens } from "../viewer/ContentView";
import { detectContentType, firstFilenameArg } from "../viewer/detectContentType";
import { detectLanguage } from "../viewer/detectLanguage";
import { stripAnsi } from "../viewer/stripAnsi";
import { PASS, type Formatter, type FormatterContext } from "./types";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

const HOST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  // Two layout modes via `--formatter-flex`:
  //   - default (`none` ⇒ flex: 0 0 auto): inline block — the
  //     host gets a fixed height (`--formatter-max-height`,
  //     default 320px) so the row has a natural size inside
  //     the BlockList.
  //   - fit-to-pane / modal (`1 1 0`): the host grows to fill
  //     the remaining space in its flex parent — exactly the
  //     pane-height-minus-meta-and-command in the maximised
  //     row, or the modal panel below the header. `height` is
  //     ignored once flex-basis is `0`, so the fixed-height
  //     value can stay as the default fallback for normal
  //     mode.
  flex: "var(--formatter-flex, none)",
  height: "var(--formatter-max-height, 320px)",
  minHeight: 0,
  margin: "8px 0 0 0",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  overflow: "hidden",
};

interface CatViewProps {
  ctx: FormatterContext;
  lens: ContentLens; // "rendered" | "source"
}

function CatView({ ctx, lens }: CatViewProps): React.ReactElement {
  // Argv → filename → content-type + language. Stable per
  // ctx.argv ref.
  const filename = useMemo(() => firstFilenameArg(ctx.argv), [ctx.argv]);
  const contentType = useMemo(() => {
    // For the initial render we only know the filename; the
    // disk-read effect below replaces bytes once it lands and
    // we re-compute. Argv-based detection covers the common
    // case anyway (`.md`, `.png`, `.svg`, …).
    return detectContentType({ argv: ctx.argv });
  }, [ctx.argv]);

  const [diskBytes, setDiskBytes] = useState<Uint8Array | null>(null);
  const [diskRead, setDiskRead] = useState(false);
  const [fileStat, setFileStat] = useState<FileStat | null>(null);

  useEffect(() => {
    setDiskBytes(null);
    setDiskRead(false);
    setFileStat(null);
    if (filename === null) {
      setDiskRead(true);
      return;
    }
    const path = resolvePath(filename, ctx.cwd);
    if (path === null) {
      setDiskRead(true);
      return;
    }
    let cancelled = false;
    // Two independent fetches: bytes for FMT / SRC, stats for
    // INFO. Race them so lens switches don't wait on the wrong
    // one.
    void readFileBytes(path).then(
      (bytes) => {
        if (cancelled) return;
        setDiskBytes(bytes.length > 0 ? bytes : null);
        setDiskRead(true);
      },
      (err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`cat formatter: read_file_bytes(${path}) failed: ${msg}`);
        setDiskRead(true);
      },
    );
    void statFile(path).then((stat) => {
      if (cancelled) return;
      setFileStat(stat);
    });
    return () => {
      cancelled = true;
    };
    // ctx.argv / ctx.stdout change identity per parent render
    // for the same block; only the filename + cwd really matter.
  }, [filename, ctx.cwd]);

  // Pick the bytes we'll feed ContentView. Prefer disk-read
  // (clean), fall back to captured stdout (subject to PTY
  // corruption but at least *something*).
  const bytes = useMemo(() => {
    if (diskBytes !== null) return diskBytes;
    return new TextEncoder().encode(ctx.stdout);
  }, [diskBytes, ctx.stdout]);

  const text = useMemo(() => {
    if (contentType === "image") return null;
    if (diskBytes !== null) {
      return stripAnsi(TEXT_DECODER.decode(diskBytes));
    }
    return ctx.stdout;
  }, [contentType, diskBytes, ctx.stdout]);

  const language = useMemo(() => {
    return detectLanguage(text ?? "", ctx.argv);
  }, [text, ctx.argv]);

  // Don't flash "loading…" for the common (already-cached or
  // small-file) case — the disk-read effect resolves in tens
  // of milliseconds on local files. Render with captured bytes
  // immediately and let the disk-read override land when ready.
  void diskRead;

  // INFO lens: universal FILE stats + format-specific parsers
  // (PNG / JPEG / GIF) + TEXT for non-image content. Composed
  // synchronously off whatever we currently have — bytes may
  // still be captured stdout (mojibake for binaries), which is
  // fine because the signature parsers only touch the first
  // few bytes and gracefully return null when they don't
  // match.
  const metadataView = useMemo(() => {
    if (lens !== "info") return null;
    if (fileStat === null) return null;
    return buildMetadata({ stat: fileStat, bytes, contentType, text, language });
  }, [lens, fileStat, bytes, contentType, text, language]);

  return (
    <div data-testid="formatter-cat" style={HOST}>
      {lens === "info" ? (
        metadataView === null ? (
          <div
            data-testid="formatter-cat-info-loading"
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--fg-faint)",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
            }}
          >
            Reading file stats…
          </div>
        ) : (
          <MetadataRenderer sections={metadataView} style={{ flex: 1 }} />
        )
      ) : (
        <ContentView
          contentType={contentType}
          bytes={bytes}
          text={text}
          language={language}
          mode={lens}
          filenameHint={filename}
          style={{ flex: 1 }}
        />
      )}
    </div>
  );
}

function resolvePath(filename: string, cwd: string | null): string | null {
  if (filename.length === 0) return null;
  if (filename.startsWith("/")) return filename;
  if (cwd === null || cwd.length === 0) return null;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${base}/${filename}`;
}

// Tag for `BlockId` import (kept so future formatter signatures
// can reference it without re-importing). Cheap, no runtime.
void (null as BlockId | null);

function render(ctx: FormatterContext, lens?: ContentLens): React.ReactNode | typeof PASS {
  // Empty captured output AND no filename means there's nothing
  // to render in any lens. Decline so RAW kicks in (still empty,
  // but at least the user sees an empty `<pre>` rather than the
  // formatter's bordered host with no content).
  if (ctx.stdout.length === 0 && firstFilenameArg(ctx.argv) === null) return PASS;
  return <CatView ctx={ctx} lens={lens ?? "rendered"} />;
}

/** INFO needs a real file to stat, so it's only supported when
 *  the argv has a filename we can resolve to an absolute path. */
function catSupportsInfo(ctx: FormatterContext): boolean {
  const filename = firstFilenameArg(ctx.argv);
  if (filename === null) return false;
  return resolvePath(filename, ctx.cwd) !== null;
}

export const catFormatter: Formatter = {
  name: "cat",
  matcher: { kind: "argv0", argv0: "cat" },
  // Now useful in the modal: ContentView gives us the same
  // markdown / image / hex experience the modal used to wire
  // by itself, and the lens system lets the user toggle FMT /
  // SRC for content that has a meaningful source view.
  useInModal: true,
  render,
  supportsInfo: catSupportsInfo,
};

/** `bat` is `cat` with extra chrome the user already gets from
 *  CodeMirror; same content-aware routing. */
export const batFormatter: Formatter = {
  name: "bat",
  matcher: { kind: "argv0", argv0: "bat" },
  useInModal: true,
  render,
  supportsInfo: catSupportsInfo,
};
