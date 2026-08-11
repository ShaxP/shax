/**
 * PromptStrip — the prompt area at the bottom of the pane. Grew to
 * N rows in M12.3 so multi-line command composition (unclosed quotes,
 * backslash continuation) shows the whole in-progress command, not
 * just the current row.
 *
 * M1.9 slice 1.9b: the strip owns input. A focusable container captures
 * keydown events, maps them to PTY bytes via the keyToBytes helper, and
 * forwards them through the `onInput` callback. xterm.js no longer
 * captures keystrokes in the resting state (only when the alternate
 * screen is active and xterm is revealed).
 *
 * The visible cursor + line text are driven by the renderer fed with
 * `prompt_chunk` events from the shell's echo. We deliberately do not
 * render local echo here: the line the user sees is what the shell has
 * actually committed, which keeps history navigation, completion, and
 * readline shortcuts in lockstep with the strip.
 *
 * Layout:
 *
 *   [ cwd ]  [ ⎇ branch ]  ❯  first row + cursor
 *                             second row (indented to align with input)
 *                             third row
 *
 * Continuation rows reserve the chrome column via `visibility: hidden`
 * so alignment matches automatically even when the cwd is long.
 *
 * The wrapper is exposed via a forwarded ref so the parent can move
 * focus into / out of the strip when alt-screen mode toggles.
 */

import { forwardRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  Ref,
} from "react";
import { useAssistantDocked } from "../lib/AssistantDockContext";
import { useHomeDir } from "../lib/HomeDirContext";
import { compactCwd } from "./blockFormat";
import type { PromptLine, PromptRow } from "./promptRenderer";
import { keyToBytes } from "./keyToBytes";
import { ConfirmPasteModal } from "./ConfirmPasteModal";

const TEXT_ENCODER = new TextEncoder();

/** M12.3 paste-safety thresholds. Above either one, the paste routes
 *  through {@link ConfirmPasteModal} instead of going straight to the
 *  shell. Small pastes (single-line snippets, short commands) skip
 *  the modal so the common case stays frictionless. */
const CONFIRM_PASTE_MIN_LINES = 5;
const CONFIRM_PASTE_MIN_BYTES = 500;

/** Bracketed-paste start/end sequences (xterm convention, required by
 *  bracketed-paste mode `\e[?2004h`). Wrapping every paste in these
 *  tells the shell "the bytes between these markers are a paste" so it
 *  can suppress its own interpretation of embedded newlines / control
 *  chars. All shells we support (zsh, bash 4.4+, fish) enable bracketed
 *  paste by default. */
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** Build the byte payload for a paste. Always wraps in bracketed-paste
 *  markers with raw LFs — modern shells' bracketed-paste behaviour
 *  inserts the payload into the line-editor buffer as multi-line text
 *  and waits for Enter before executing anything. No client-side
 *  `\`-prefix or `;`-substitution — those attempts to "help" produce
 *  broken semantics (backslash-continuation folds newlines to nothing;
 *  `;`-joining loses safety around comments). Delegate to the shell. */
function encodePaste(text: string): Uint8Array {
  return TEXT_ENCODER.encode(BRACKETED_PASTE_START + text + BRACKETED_PASTE_END);
}

/** Is this paste large enough to warrant the confirmation modal? */
function isLargePaste(text: string): boolean {
  if (text.length >= CONFIRM_PASTE_MIN_BYTES) return true;
  // `split("\n").length` counts lines-of-text (empty trailing after
  // a final LF becomes an empty entry — same as file line count).
  return text.split("\n").length >= CONFIRM_PASTE_MIN_LINES;
}

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
  /**
   * True when the assistant dock is open (M7.7b). Swaps the placeholder
   * hint from "type a command, or ? to ask Shax" to "assistant is
   * working beside you" — the ? shortcut isn't useful when the
   * assistant is already visible.
   */
  assistantDocked?: boolean;
}

/** Outer wrapper — a flex column so continuation rows stack below
 *  row 0. Border + padding + font settings apply to the whole strip,
 *  not per row. */
const WRAPPER: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: "10px 18px",
  borderTop: "1px solid var(--border)",
  background: "var(--pane)",
  fontFamily: "var(--font-mono)",
  // M10.5: the prompt strip mirrors what will become the next
  // terminal command, so it uses the same size as the terminal
  // itself (not the smaller "secondary" tier).
  fontSize: "var(--font-size-terminal)",
  color: "var(--fg)",
  flexShrink: 0,
  minHeight: 40,
  outline: "none",
};

/** One row inside the strip — a horizontal flex containing the chrome
 *  column on the left and the mirrored input on the right. Row 0
 *  paints the chrome; continuation rows reserve the same width with
 *  `visibility: hidden` so alignment holds regardless of cwd length. */
const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 11,
  minHeight: 22,
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

/** M12.2: selected cells (mark/region in vi visual or emacs Ctrl-Space)
 *  are painted with an accent background so the user can see what will
 *  be operated on. The shell already broadcasts the selection via SGR 7
 *  (reverse video) — the mirror renderer captures it as the per-cell
 *  `selected` bit, and this style is applied to any run whose cells
 *  carry it. Kept to a soft accent tone so it doesn't compete with
 *  attention going to the cursor. */
const SELECTED_TEXT: CSSProperties = {
  background: "var(--accent-soft)",
  color: "var(--fg)",
  borderRadius: 2,
};

interface StyledRun {
  text: string;
  styled: boolean;
  selected: boolean;
}

/**
 * Group consecutive characters that share both flags (styled + selected)
 * into runs. Empty input → empty array. Arrays are assumed to be the same
 * length as `text`; mismatches fall back to treating extra chars as
 * unstyled + unselected.
 */
function styledRuns(text: string, styled: boolean[], selected: boolean[]): StyledRun[] {
  if (text.length === 0) return [];
  const runs: StyledRun[] = [];
  let runText = "";
  let runStyled = styled[0] ?? false;
  let runSelected = selected[0] ?? false;
  for (let i = 0; i < text.length; i++) {
    const s = styled[i] ?? false;
    const sel = selected[i] ?? false;
    if (s !== runStyled || sel !== runSelected) {
      runs.push({ text: runText, styled: runStyled, selected: runSelected });
      runText = "";
      runStyled = s;
      runSelected = sel;
    }
    runText += text.charAt(i);
  }
  if (runText.length > 0) runs.push({ text: runText, styled: runStyled, selected: runSelected });
  return runs;
}

/** Compose the two per-run flags into an inline style. Selected wins the
 *  colour axis (the accent background needs contrast; dimming a selected
 *  run to `--fg-faint` would kill the point). */
function runStyle(run: StyledRun): CSSProperties | undefined {
  if (run.selected && run.styled) return SELECTED_TEXT;
  if (run.selected) return SELECTED_TEXT;
  if (run.styled) return STYLED_TEXT;
  return undefined;
}

function PromptStripInner(
  { cwd, branch, line, onInput, assistantDocked: assistantDockedProp }: PromptStripProps,
  ref: Ref<HTMLDivElement>,
): React.ReactElement {
  const hasTyping = line.rows.some((r) => r.text.length > 0);
  const home = useHomeDir();
  const contextDocked = useAssistantDocked();
  // Prop wins over context for tests that render the strip in
  // isolation; App-level rendering always relies on context.
  const assistantDocked = assistantDockedProp ?? contextDocked;
  const displayCwd = compactCwd(cwd, home);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // `?` on an empty prompt opens the assistant, matching the strip's
    // placeholder hint (M7.6). Only fires when the user hasn't typed
    // anything yet AND no modifier is held — otherwise `?` is just a
    // character (or part of a shortcut like Shift-/ for search).
    // When the assistant dock is already open (M7.7b), the shortcut
    // is disabled — the placeholder swaps to "assistant is working
    // beside you" and no longer mentions `?`, so intercepting it
    // would surprise the user.
    const isBareQuestion =
      event.key === "?" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !hasTyping &&
      line.cursorRow === 0 &&
      line.cursorCol === 0 &&
      !assistantDocked;
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

  // M12.3: large pastes (≥ CONFIRM_PASTE_MIN_LINES lines OR
  // ≥ CONFIRM_PASTE_MIN_BYTES bytes) are held in `pendingPaste` state
  // and rendered through `ConfirmPasteModal` so the user can review
  // before the bytes hit the shell. Small pastes bypass the modal.
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);

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
    if (isLargePaste(normalised)) {
      setPendingPaste(normalised);
      return;
    }
    // Small paste: bracketed-paste-wrapped, straight through.
    onInput(encodePaste(normalised));
  };

  return (
    <div
      data-testid="prompt-strip"
      ref={ref}
      tabIndex={0}
      role="textbox"
      aria-label="Shell prompt"
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      style={WRAPPER}
    >
      {line.rows.map((row, rowIdx) => (
        <PromptRowView
          key={rowIdx}
          rowIdx={rowIdx}
          row={row}
          isFirst={rowIdx === 0}
          cwd={displayCwd}
          branch={branch}
          cursorCol={rowIdx === line.cursorRow ? line.cursorCol : null}
          showPlaceholder={rowIdx === 0 && !hasTyping}
          assistantDocked={assistantDocked}
        />
      ))}
      {pendingPaste !== null && (
        <ConfirmPasteModal
          payload={pendingPaste}
          onCancel={() => setPendingPaste(null)}
          onConfirm={() => {
            onInput(encodePaste(pendingPaste));
            setPendingPaste(null);
          }}
        />
      )}
    </div>
  );
}

/** One rendered row of the strip. Row 0 paints the chrome (cwd, branch,
 *  `❯`); continuation rows reserve the same width via `visibility: hidden`
 *  so the input column aligns automatically. Only the row containing the
 *  cursor renders the cursor bar. Only row 0 renders the placeholder
 *  hint (and only when nothing has been typed anywhere). */
function PromptRowView({
  rowIdx,
  row,
  isFirst,
  cwd,
  branch,
  cursorCol,
  showPlaceholder,
  assistantDocked,
}: {
  rowIdx: number;
  row: PromptRow;
  isFirst: boolean;
  cwd: string;
  branch: string | null;
  /** Column the cursor sits at within this row, or `null` if the cursor
   *  is on a different row. */
  cursorCol: number | null;
  showPlaceholder: boolean;
  assistantDocked: boolean;
}): React.ReactElement {
  const chromeStyle: CSSProperties = isFirst ? {} : { visibility: "hidden" };
  const beforeText = cursorCol !== null ? row.text.slice(0, cursorCol) : row.text;
  const afterText = cursorCol !== null ? row.text.slice(cursorCol) : "";
  const beforeRuns = styledRuns(
    beforeText,
    row.styled.slice(0, beforeText.length),
    row.selected.slice(0, beforeText.length),
  );
  const afterRuns = styledRuns(
    afterText,
    row.styled.slice(beforeText.length),
    row.selected.slice(beforeText.length),
  );
  return (
    <div style={ROW} data-testid={`prompt-row-${rowIdx}`}>
      <span style={{ ...META_GROUP, ...chromeStyle }}>
        <span
          style={CWD_LABEL}
          data-testid={isFirst ? "prompt-cwd" : undefined}
          aria-hidden={!isFirst}
        >
          {cwd}
        </span>
        <span
          style={BRANCH_LABEL}
          data-testid={isFirst ? "prompt-branch" : undefined}
          aria-hidden={!isFirst}
        >
          <span style={{ fontSize: 11 }}>⎇</span>
          {branch ?? "—"}
        </span>
      </span>
      <span style={{ ...PROMPT_GLYPH, ...chromeStyle }} aria-hidden={!isFirst}>
        ❯
      </span>
      <span style={LINE_AREA} data-testid={isFirst ? "prompt-line" : undefined} data-row={rowIdx}>
        <span data-testid={isFirst ? "prompt-line-text" : undefined}>
          {beforeRuns.map((run, idx) => (
            <span key={`before-${idx}`} style={runStyle(run)}>
              {run.text}
            </span>
          ))}
        </span>
        {cursorCol !== null && <span style={CURSOR_BAR} data-testid="prompt-cursor" />}
        {row.text.length > 0 || cursorCol !== null ? (
          <span>
            {afterRuns.map((run, idx) => (
              <span key={`after-${idx}`} style={runStyle(run)}>
                {run.text}
              </span>
            ))}
          </span>
        ) : null}
        {showPlaceholder && (
          <span style={LINE_TEXT_PLACEHOLDER}>
            {" "}
            {assistantDocked ? (
              "assistant is working beside you"
            ) : (
              <>
                type a command, or <span style={{ fontFamily: "var(--font-mono)" }}>?</span> to ask
                Shax
              </>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

export const PromptStrip = forwardRef<HTMLDivElement, PromptStripProps>(PromptStripInner);
PromptStrip.displayName = "PromptStrip";
