/**
 * PromptStrip — the single-row prompt area at the bottom of the pane.
 *
 * M1.9 slice 1.9a (this slice): the strip is a *read-only mirror* of the
 * shell's current prompt line. It consumes `prompt_chunk` events through
 * the tiny VT renderer (see `promptRenderer.ts`) and renders the resulting
 * line + cursor position. xterm.js still owns input; the strip is purely
 * visual at this stage and exists so we can verify the renderer faithfully
 * tracks what the shell is drawing before we hand it the input hose in
 * 1.9b.
 *
 * Layout follows the design at `/design/Shax Main Shell.dc.html`:
 *
 *   [ cwd ]  [ ⎇ branch ]  ❯  <prompt text + blinking cursor>
 *
 * cwd and branch come from the parent (same source the title bar and
 * statusline use). The blinking cursor is a thin accent bar positioned by
 * column count using the line's rendered text width — close enough for
 * monospaced output. Real glyph-position cursoring lands in 1.9b when the
 * strip actually owns input.
 */

import type { CSSProperties } from "react";
import type { PromptLine } from "./promptRenderer";

export interface PromptStripProps {
  /** The current working directory, sourced from OSC 133 A. */
  cwd: string | null;
  /** The current git branch, sourced from OSC 133 A. */
  branch: string | null;
  /** The mirror of the shell's current prompt line. */
  line: PromptLine;
}

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 11,
  padding: "10px 18px",
  borderTop: "1px solid var(--border)",
  background: "var(--pane)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--fg)",
  flexShrink: 0,
  minHeight: 40,
};

const META_GROUP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  fontSize: 11.5,
  fontFamily: "var(--font-ui)",
  flexShrink: 0,
};

const CWD_LABEL: CSSProperties = {
  color: "var(--fg-dim)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 280,
};

const BRANCH_LABEL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  color: "var(--accent)",
  whiteSpace: "nowrap",
};

const PROMPT_GLYPH: CSSProperties = {
  color: "var(--accent)",
  fontSize: 14,
  fontWeight: 700,
  flexShrink: 0,
};

const LINE_AREA: CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 0,
  whiteSpace: "pre",
  overflow: "hidden",
  // Reserve enough vertical space for the line + cursor bar; the line is
  // 13px font on a 1.4 line-height so ~18px is a safe minimum.
  minHeight: 18,
};

const LINE_TEXT_PLACEHOLDER: CSSProperties = {
  color: "var(--fg-faint)",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
};

const CURSOR_BAR: CSSProperties = {
  display: "inline-block",
  width: 8,
  height: 16,
  background: "var(--accent)",
  opacity: 0.85,
  verticalAlign: "middle",
  marginLeft: 1,
};

export function PromptStrip({ cwd, branch, line }: PromptStripProps): React.ReactElement {
  const hasTyping = line.text.length > 0;

  // Render the line as two spans + cursor so the cursor appears at the
  // mid-line position when the user has moved it left from the end. With
  // a monospaced font and pure text content, this is visually accurate.
  const before = line.text.slice(0, line.cursor);
  const after = line.text.slice(line.cursor);

  return (
    <div data-testid="prompt-strip" style={ROW}>
      <span style={META_GROUP}>
        <span style={CWD_LABEL} data-testid="prompt-cwd">
          {cwd ?? "—"}
        </span>
        <span style={BRANCH_LABEL} data-testid="prompt-branch">
          <span style={{ fontSize: 11 }}>⎇</span>
          {branch ?? "—"}
        </span>
      </span>
      <span style={PROMPT_GLYPH}>❯</span>
      <span style={LINE_AREA} data-testid="prompt-line">
        {hasTyping ? (
          <>
            <span data-testid="prompt-line-text">{before}</span>
            <span style={CURSOR_BAR} data-testid="prompt-cursor" />
            <span>{after}</span>
          </>
        ) : (
          <span style={LINE_TEXT_PLACEHOLDER}>
            type a command, or <span style={{ fontFamily: "var(--font-mono)" }}>?</span> to ask Shax
          </span>
        )}
      </span>
    </div>
  );
}
