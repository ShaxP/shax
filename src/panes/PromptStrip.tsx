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
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  Ref,
} from "react";
import { useHomeDir } from "../lib/HomeDirContext";
import { compactCwd } from "./blockFormat";
import type { PromptLine } from "./promptRenderer";
import { keyToBytes } from "./keyToBytes";

const TEXT_ENCODER = new TextEncoder();

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

const STYLED_TEXT: CSSProperties = {
  color: "var(--fg-faint)",
};

interface StyledRun {
  text: string;
  styled: boolean;
}

/**
 * Group consecutive same-styled characters into runs. Empty input → empty
 * array. `text` and `styled` are assumed to be the same length; mismatches
 * fall back to treating extra chars as unstyled.
 */
function styledRuns(text: string, styled: boolean[]): StyledRun[] {
  if (text.length === 0) return [];
  const runs: StyledRun[] = [];
  let runText = "";
  let runStyled = styled[0] ?? false;
  for (let i = 0; i < text.length; i++) {
    const s = styled[i] ?? false;
    if (s !== runStyled) {
      runs.push({ text: runText, styled: runStyled });
      runText = "";
      runStyled = s;
    }
    runText += text.charAt(i);
  }
  if (runText.length > 0) runs.push({ text: runText, styled: runStyled });
  return runs;
}

function PromptStripInner(
  { cwd, branch, line, onInput }: PromptStripProps,
  ref: Ref<HTMLDivElement>,
): React.ReactElement {
  const hasTyping = line.text.length > 0;
  const home = useHomeDir();
  const displayCwd = compactCwd(cwd, home);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // `?` on an empty prompt opens the assistant, matching the strip's
    // placeholder hint (M7.6). Only fires when the user hasn't typed
    // anything yet AND no modifier is held — otherwise `?` is just a
    // character (or part of a shortcut like Shift-/ for search).
    const isBareQuestion =
      event.key === "?" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !hasTyping &&
      line.cursor === 0;
    if (isBareQuestion) {
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent("shax:assistant-open"));
      return;
    }

    const bytes = keyToBytes(event);
    if (bytes === null) return;
    // Any key we map is one the browser shouldn't also handle (Tab moving
    // focus, Backspace navigating, arrows scrolling the page). Suppress.
    event.preventDefault();
    event.stopPropagation();
    onInput(bytes);
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>): void => {
    // Read text from the clipboard and send it through to the shell as
    // if the user had typed each character. The browser would otherwise
    // try to paste *into* this div (no-op for a non-editable element)
    // and the shell would never see the bytes.
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData.getData("text/plain");
    if (text.length === 0) return;
    // Normalise line endings — Windows / web clipboards often deliver
    // CRLF, but the shell expects LF (any CR in the middle of a paste
    // looks like an Enter and prematurely submits whichever line
    // contains it).
    const normalised = text.replace(/\r\n?/g, "\n");
    onInput(TEXT_ENCODER.encode(normalised));
  };

  // Group consecutive same-styled chars into runs so the strip can render
  // styled chunks (zsh-autosuggestions ghost text, syntax-highlighted
  // command parts) in a faint colour while the user's committed input
  // stays at full contrast. Defensive against callers (mostly tests) that
  // pass a partial PromptLine without the styled field.
  const lineStyled = line.styled ?? [];
  const beforeRuns = styledRuns(line.text.slice(0, line.cursor), lineStyled.slice(0, line.cursor));
  const afterRuns = styledRuns(line.text.slice(line.cursor), lineStyled.slice(line.cursor));

  return (
    <div
      data-testid="prompt-strip"
      ref={ref}
      tabIndex={0}
      role="textbox"
      aria-label="Shell prompt"
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      style={ROW}
    >
      <span style={META_GROUP}>
        <span style={CWD_LABEL} data-testid="prompt-cwd">
          {displayCwd}
        </span>
        <span style={BRANCH_LABEL} data-testid="prompt-branch">
          <span style={{ fontSize: 11 }}>⎇</span>
          {branch ?? "—"}
        </span>
      </span>
      <span style={PROMPT_GLYPH}>❯</span>
      <span style={LINE_AREA} data-testid="prompt-line">
        {/*
         * Cursor is always rendered so the user has a visible insertion
         * point from the moment the strip mounts. In the empty state it
         * sits at column 0 with the placeholder hint trailing after.
         * Styled chars (any non-default-fg SGR — e.g., zsh-autosuggestions
         * ghost text) render in `--fg-faint` so the user can tell what
         * the shell suggested vs. what they actually typed.
         */}
        <span data-testid="prompt-line-text">
          {beforeRuns.map((run, idx) => (
            <span key={`before-${idx}`} style={run.styled ? STYLED_TEXT : undefined}>
              {run.text}
            </span>
          ))}
        </span>
        <span style={CURSOR_BAR} data-testid="prompt-cursor" />
        {hasTyping ? (
          <span>
            {afterRuns.map((run, idx) => (
              <span key={`after-${idx}`} style={run.styled ? STYLED_TEXT : undefined}>
                {run.text}
              </span>
            ))}
          </span>
        ) : (
          <span style={LINE_TEXT_PLACEHOLDER}>
            {" "}
            type a command, or <span style={{ fontFamily: "var(--font-mono)" }}>?</span> to ask Shax
          </span>
        )}
      </span>
    </div>
  );
}

export const PromptStrip = forwardRef<HTMLDivElement, PromptStripProps>(PromptStripInner);
PromptStrip.displayName = "PromptStrip";
