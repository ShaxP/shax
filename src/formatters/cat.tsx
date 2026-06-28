/**
 * `cat` / `bat` built-in formatter (M4 slice 4.3).
 *
 * The reference implementation that wires the formatter pipeline
 * end-to-end. Both `cat` and `bat` produce file content on
 * stdout; we route the captured text through the slice-4.1
 * CodeMirror Viewer inline in the block, with the language
 * picked by the same `detectLanguage` pipeline the modal uses.
 *
 * Bounded height so a 10k-line file doesn't take over the pane —
 * the eye icon on the block row still opens the full
 * `BlockViewerModal` for unbounded vim navigation.
 *
 * Markdown / image rendering inline are intentionally *not* in
 * this slice; opening the modal gives those. The point of this
 * slice is to prove the registry + RAW/FMT toggle.
 */

import type { CSSProperties } from "react";
import { Viewer } from "../viewer/Viewer";
import { detectLanguage } from "../viewer/detectLanguage";
import { PASS, type Formatter, type FormatterContext } from "./types";

const HOST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: 320,
  margin: "8px 0 0 0",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  overflow: "hidden",
};

function render(ctx: FormatterContext): React.ReactNode | typeof PASS {
  // Nothing to format if there's no captured text.
  if (ctx.stdout.length === 0) return PASS;
  const language = detectLanguage(ctx.stdout, ctx.argv);
  return (
    <div data-testid="formatter-cat" style={HOST}>
      <Viewer text={ctx.stdout} language={language} style={{ flex: 1 }} />
    </div>
  );
}

export const catFormatter: Formatter = {
  name: "cat",
  matcher: { kind: "argv0", argv0: "cat" },
  render,
};

/** `bat` is `cat` with syntax-highlight + line numbers — exactly
 *  what our Viewer already does, so the formatter is identical
 *  apart from the matcher. */
export const batFormatter: Formatter = {
  name: "bat",
  matcher: { kind: "argv0", argv0: "bat" },
  render,
};
