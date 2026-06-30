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
import { readFileBytes, type BlockId } from "../lib/ipc";
import { ContentView, type ContentLens } from "../viewer/ContentView";
import { detectContentType, firstFilenameArg } from "../viewer/detectContentType";
import { detectLanguage } from "../viewer/detectLanguage";
import { stripAnsi } from "../viewer/stripAnsi";
import { PASS, type Formatter, type FormatterContext } from "./types";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

const HOST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  // Inline blocks get a fixed cap. The modal overrides
  // `--formatter-max-height` (to e.g. `100%`) so the viewer
  // fills the panel.
  height: "var(--formatter-max-height, 320px)",
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

  useEffect(() => {
    setDiskBytes(null);
    setDiskRead(false);
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

  return (
    <div data-testid="formatter-cat" style={HOST}>
      <ContentView
        contentType={contentType}
        bytes={bytes}
        text={text}
        language={language}
        mode={lens}
        filenameHint={filename}
        style={{ flex: 1 }}
      />
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

export const catFormatter: Formatter = {
  name: "cat",
  matcher: { kind: "argv0", argv0: "cat" },
  // Now useful in the modal: ContentView gives us the same
  // markdown / image / hex experience the modal used to wire
  // by itself, and the lens system lets the user toggle FMT /
  // SRC for content that has a meaningful source view.
  useInModal: true,
  render,
};

/** `bat` is `cat` with extra chrome the user already gets from
 *  CodeMirror; same content-aware routing. */
export const batFormatter: Formatter = {
  name: "bat",
  matcher: { kind: "argv0", argv0: "bat" },
  useInModal: true,
  render,
};
