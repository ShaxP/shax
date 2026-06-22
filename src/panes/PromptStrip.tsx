/**
 * PromptStrip — the single-row prompt area at the bottom of the pane.
 *
 * M1.9 slice 1.9b: the strip now *owns input*. A focusable container
 * captures keydown events, maps them to PTY bytes via the keyToBytes
 * helper, and forwards them through the `onInput` callback. xterm.js no
 * longer captures keystrokes in the resting state (only when the
 * alternate screen is active and xterm is revealed).
 *
 * The visible cursor + line text are still driven by the renderer fed
 * with `prompt_chunk` events from the shell's echo. We deliberately do
 * not render local echo here: the line the user sees is what the shell
 * has actually committed, which keeps history navigation, completion,
 * and readline shortcuts in lockstep with the strip.
 *
 * Layout follows the design at `/design/Shax Main Shell.dc.html`:
 *
 *   [ cwd ]  [ ⎇ branch ]  ❯  <prompt text + blinking cursor>
 *
 * The wrapper is exposed via a forwarded ref so the parent can move
 * focus into / out of the strip when alt-screen mode toggles.
 */

import { forwardRef } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, Ref } from "react";
import type { PromptLine } from "./promptRenderer";
import { keyToBytes } from "./keyToBytes";

export interface PromptStripProps {
  /** The current working directory, sourced from OSC 133 A. */
  cwd: string | null;
  /** The current git branch, sourced from OSC 133 A. */
  branch: string | null;
  /** The mirror of the shell's current prompt line. */
  line: PromptLine;
  /**
   * Forward typed bytes to the PTY. Receives the bytes produced by
   * `keyToBytes(event)`; never called for ignored events (modifier-only,
   * Cmd shortcuts, unmapped keys).
   */
  onInput: (bytes: Uint8Array) => void;
  /**
   * True while the host is in alt-screen mode. The strip is hidden by
   * the parent in that case and never captures input — this is just for
   * its own internal styling (e.g., the focus ring).
   */
  altScreen?: boolean;
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
  outline: "none",
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

function PromptStripInner(
  { cwd, branch, line, onInput }: PromptStripProps,
  ref: Ref<HTMLDivElement>,
): React.ReactElement {
  const hasTyping = line.text.length > 0;
  const before = line.text.slice(0, line.cursor);
  const after = line.text.slice(line.cursor);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const bytes = keyToBytes(event);
    if (bytes === null) return;
    // Any key we map is one the browser shouldn't also handle (Tab moving
    // focus, Backspace navigating, arrows scrolling the page). Suppress.
    event.preventDefault();
    event.stopPropagation();
    onInput(bytes);
  };

  return (
    <div
      data-testid="prompt-strip"
      ref={ref}
      tabIndex={0}
      role="textbox"
      aria-label="Shell prompt"
      onKeyDown={handleKeyDown}
      style={ROW}
    >
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

export const PromptStrip = forwardRef<HTMLDivElement, PromptStripProps>(PromptStripInner);
PromptStrip.displayName = "PromptStrip";
