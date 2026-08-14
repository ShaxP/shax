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
  ReactElement,
  Ref,
} from "react";
import { useAssistantDocked } from "../lib/AssistantDockContext";
import { useHomeDir } from "../lib/HomeDirContext";
import { compactCwd } from "./blockFormat";
import type { PromptLine, PromptRow } from "./promptRenderer";
import { keyToBytes } from "./keyToBytes";
import { ConfirmPasteModal } from "./ConfirmPasteModal";
import { languageChip } from "./languageIcons";
import { CommandSpans } from "./CommandSpans";

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
  /**
   * M12.8: raw zsh KEYMAP / bash-readline mode-string value from the
   * most recent OSC 133;M. Drives the caret/cursor shape:
   *   - `null` / `main` / `emacs` / `viins` → thin insertion caret
   *     (2px vertical bar between chars).
   *   - `vicmd` / `visual` → block cursor over the character at the
   *     cursor position (inverts fg/bg, or hollow outline when the
   *     strip is blurred).
   * Same value the statusline sub-mode chip already consumes; this
   * prop just threads it into the cursor render.
   */
  viKeymap?: string | null;
  /**
   * M12.4: commit counts vs upstream. `null` when the shim omitted
   * the field (no upstream, or both zero). The chrome renders
   * `↑N` / `↓M` in muted tone only when at least one is non-null.
   */
  gitAhead?: number | null;
  gitBehind?: number | null;
  /**
   * M12.4: the primary language detected for the cwd (e.g. `"rust"`,
   * `"typescript"`). `null` when detection didn't match; the chrome
   * then renders no icon.
   */
  language?: string | null;
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

/** M12.4 git ahead/behind chip — sits after the branch label, only
 *  renders when at least one count is non-zero. Muted tone so it
 *  doesn't compete with the branch name for attention. */
const AHEAD_BEHIND_GROUP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: "var(--fg-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
};

/** The `↑` / `↓` arrow inside the ahead/behind chip. */
const ARROW_GLYPH: CSSProperties = {
  marginRight: 1,
};

/** M12.4 language chip — sits after ahead/behind. Nerd Font icon
 *  inherits currentColor via the icon-font fallback stack (see
 *  languageIcons.ts docblock). */
const LANG_GROUP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  color: "var(--fg-dim)",
  fontFamily: "var(--font-ui)",
  fontSize: 11.5,
};

/** The Nerd Font icon inside the language chip. `font-family` names
 *  the Nerd Font first so the glyph resolves even when the user
 *  picked a non-Nerd `font_family` in preferences. */
const LANG_ICON: CSSProperties = {
  fontFamily: "'JetBrainsMono Nerd Font', var(--font-mono), monospace",
  fontSize: 13,
  lineHeight: 1,
};

const LINE_AREA: CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 0,
  whiteSpace: "pre",
  overflow: "hidden",
  minHeight: 18,
  // M12.8: explicit line-height so the cursor's `1.3em` height
  // matches the surrounding characters' line-box exactly. Without
  // this, the browser's default `normal` line-height (font-
  // dependent, ~1.2-1.4) leaves a visible gap top/bottom on the
  // cursor — very obvious on the block variant. 1.3 is mild enough
  // to keep multi-line prompts readable without extra leading.
  lineHeight: 1.3,
};

const LINE_TEXT_PLACEHOLDER: CSSProperties = {
  color: "var(--fg-faint)",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
};

/**
 * M12.8 cursor shapes.
 *
 * `line` — thin insertion caret. Sits BETWEEN characters (the
 * classic `|` cursor). Used for emacs, vi INSERT (`viins`), and
 * when the shim isn't reporting a keymap (default to the safer
 * "insertion" shape).
 *
 * `block` — full-cell block over the character at `cursorCol`.
 * Used for vi NORMAL (`vicmd`) and VISUAL. Inverts the character
 * (`background: accent, color: bg`) so the letter under the cursor
 * stays readable against the fill. When the cursor sits past the
 * last character, we render an empty block containing a space so
 * it stays visible at end-of-line.
 *
 * Each has a focused and a blurred variant:
 *
 *   - Focused → solid fill (accent).
 *   - Blurred → hollow outline (1.5px border, no fill). Same
 *     shape, so the mode read stays consistent whether or not the
 *     strip owns keys; the SOLIDITY tells you the focus state.
 *
 * Height uses `1em` (relative to the strip's font-size, currently
 * `var(--font-size-terminal)`) so the cursor scales with the
 * terminal font-size preference — the same reason mode strings on
 * the statusline scale, not a magic number.
 */
type CursorKind = "line" | "block";

/** Cursor height. `1.3em` matches `LINE_AREA.lineHeight` × 1em so
 *  the cursor's line-box aligns exactly with the surrounding text's
 *  line-box. Prior `1em` value undershot the box by ~0.3em, visible
 *  as a top/bottom gap around the block cursor. */
const CURSOR_HEIGHT = "1.3em";

/** All cursor variants share the same vertical alignment — `top`
 *  anchors the cursor's top edge to the line-box top, so with
 *  matching heights the cursor and the character it covers occupy
 *  the same vertical extent. */
const CURSOR_VERTICAL_ALIGN = "top";

const CURSOR_LINE_FOCUSED: CSSProperties = {
  display: "inline-block",
  width: 2,
  height: CURSOR_HEIGHT,
  background: "var(--accent)",
  verticalAlign: CURSOR_VERTICAL_ALIGN,
  // Sit tight against the following character.
  marginRight: -2,
};

const CURSOR_BLOCK_FOCUSED: CSSProperties = {
  display: "inline-block",
  minWidth: "1ch",
  height: CURSOR_HEIGHT,
  background: "var(--accent)",
  color: "var(--bg)",
  verticalAlign: CURSOR_VERTICAL_ALIGN,
  // Zero horizontal padding so the block aligns with the
  // underlying character's width exactly. `lineHeight` matches
  // the block's height so the character inside centers naturally
  // within the block.
  padding: 0,
  lineHeight: CURSOR_HEIGHT,
  // `pre` preserves any whitespace char (space, tab) under the
  // block so the width matches the actual character rather than
  // collapsing to zero.
  whiteSpace: "pre",
};

const CURSOR_BLOCK_BLURRED: CSSProperties = {
  display: "inline-block",
  minWidth: "1ch",
  height: CURSOR_HEIGHT,
  background: "transparent",
  color: "var(--fg)",
  border: "1.5px solid var(--accent)",
  boxSizing: "border-box",
  verticalAlign: CURSOR_VERTICAL_ALIGN,
  padding: 0,
  lineHeight: CURSOR_HEIGHT,
  whiteSpace: "pre",
  // 1.5px border subtracts from the visible cell area; pull it
  // back with a tiny negative margin so the visible width still
  // matches a plain character cell.
  marginLeft: -1.5,
  marginRight: -1.5,
};

/**
 * Whether the cursor should render at all for a given (kind, focused)
 * combination. The line caret is hidden entirely when blurred — the
 * 2px hollow outline was barely visible at typical font sizes and
 * read as a rendering glitch. The block cursor keeps its blurred
 * outline because a full-cell outline stays legible at any size and
 * still communicates position (useful when a user tabs away in vi
 * NORMAL and wants to see where the cursor sat).
 */
function shouldRenderCursor(kind: CursorKind, focused: boolean): boolean {
  if (kind === "line" && !focused) return false;
  return true;
}

function cursorStyle(kind: CursorKind, focused: boolean): CSSProperties {
  if (kind === "block") return focused ? CURSOR_BLOCK_FOCUSED : CURSOR_BLOCK_BLURRED;
  // Line only ever renders when focused (see `shouldRenderCursor`).
  return CURSOR_LINE_FOCUSED;
}

/**
 * Render helper: slice `row.text` / `.styled` / `.selected` at
 * `endCol` and pass through `<CommandSpans>`. Used twice per row —
 * once for the pre-cursor half and once for the post-cursor half —
 * so the cursor bar can sit between them in document order.
 *
 * The tokenizer, styled-runs grouping, and colour selection all
 * live in `CommandSpans` now (M12.6a). This function just handles
 * the cursor-split slicing so the strip's row layout stays
 * self-contained.
 */
function rowSpans(row: PromptRow, startCol: number, endCol: number): ReactElement {
  const text = row.text.slice(startCol, endCol);
  const styled = row.styled.slice(startCol, endCol);
  const selected = row.selected.slice(startCol, endCol);
  return <CommandSpans text={text} styled={styled} selected={selected} />;
}

function PromptStripInner(
  {
    cwd,
    branch,
    gitAhead = null,
    gitBehind = null,
    language = null,
    line,
    onInput,
    assistantDocked: assistantDockedProp,
    viKeymap = null,
  }: PromptStripProps,
  ref: Ref<HTMLDivElement>,
): React.ReactElement {
  const hasTyping = line.rows.some((r) => r.text.length > 0);
  const home = useHomeDir();
  const contextDocked = useAssistantDocked();
  // Prop wins over context for tests that render the strip in
  // isolation; App-level rendering always relies on context.
  const assistantDocked = assistantDockedProp ?? contextDocked;
  const displayCwd = compactCwd(cwd, home);

  // M12.8: cursor shape derives from the shell's active keymap.
  //   `vicmd` / `visual` → block cursor over the char at cursorCol.
  //   everything else (viins, main, emacs, null) → thin insertion
  //     caret between chars.
  // The statusline's `viSubModeFromKeymap` normalises these strings
  // already; we reuse that logic to keep the two surfaces in sync
  // (if the pill says NORMAL, the cursor shows the block; if the
  // pill says INSERT or hides, the cursor shows the caret).
  const cursorKind: CursorKind = viKeymap === "vicmd" || viKeymap === "visual" ? "block" : "line";

  // Focus tracked internally rather than accepted as a prop: the
  // strip's focus state is naturally a DOM concern, and threading
  // it as a prop from every caller would be tedious. `focus` and
  // `blur` bubble through the outer div; we listen on the same
  // element the ref points to.
  const [isFocused, setIsFocused] = useState(false);

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
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
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
          gitAhead={gitAhead}
          gitBehind={gitBehind}
          language={language}
          cursorCol={rowIdx === line.cursorRow ? line.cursorCol : null}
          cursorKind={cursorKind}
          cursorFocused={isFocused}
          showPlaceholder={rowIdx === 0 && !hasTyping}
          assistantDocked={assistantDocked}
        />
      ))}
      {pendingPaste !== null && (
        <ConfirmPasteModal
          payload={pendingPaste}
          onCancel={() => {
            setPendingPaste(null);
            // The modal grabbed focus when it opened; without an explicit
            // hand-back, focus lands on `<body>` after the modal unmounts
            // and the user has to click the strip before typing works.
            // `shax:refocus-pane` is the app-wide "give focus back to
            // the active pane's prompt strip" signal — TerminalPane
            // listens for it and calls promptStripRef.focus().
            window.dispatchEvent(new CustomEvent("shax:refocus-pane"));
          }}
          onConfirm={() => {
            onInput(encodePaste(pendingPaste));
            setPendingPaste(null);
            window.dispatchEvent(new CustomEvent("shax:refocus-pane"));
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
  gitAhead,
  gitBehind,
  language,
  cursorCol,
  cursorKind,
  cursorFocused,
  showPlaceholder,
  assistantDocked,
}: {
  rowIdx: number;
  row: PromptRow;
  isFirst: boolean;
  cwd: string;
  branch: string | null;
  gitAhead: number | null;
  gitBehind: number | null;
  language: string | null;
  /** Column the cursor sits at within this row, or `null` if the cursor
   *  is on a different row. */
  cursorCol: number | null;
  /** M12.8 cursor shape (line vs block). Only meaningful when
   *  `cursorCol` is non-null; ignored otherwise. */
  cursorKind: CursorKind;
  /** True while the outer prompt-strip div owns focus. Drives the
   *  solid-vs-hollow rendering of the cursor. */
  cursorFocused: boolean;
  showPlaceholder: boolean;
  assistantDocked: boolean;
}): React.ReactElement {
  const chromeStyle: CSSProperties = isFirst ? {} : { visibility: "hidden" };
  const langChip = languageChip(language);
  const showAhead = gitAhead !== null && gitAhead > 0;
  const showBehind = gitBehind !== null && gitBehind > 0;
  // Split around the cursor. For a `line` cursor (thin caret), the
  // cursor sits BETWEEN characters at `cursorCol`, so the row splits
  // into `[0..cursorCol) | cursor | [cursorCol..end)`. For a `block`
  // cursor, the block covers ONE character at `cursorCol`, so the
  // row splits into `[0..cursorCol) | block(text[cursorCol]) |
  // [cursorCol+1..end)`. When `cursorCol` is past the last
  // character (i.e., at end-of-line), the block wraps a single
  // space so it stays visible.
  const cursorCharCol = cursorCol ?? row.text.length;
  const isBlockCursor = cursorCol !== null && cursorKind === "block";
  const beforeEnd = cursorCharCol;
  const afterStart = isBlockCursor ? cursorCharCol + 1 : cursorCharCol;
  const cursorChar = cursorCharCol < row.text.length ? row.text.charAt(cursorCharCol) : " ";
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
        {(showAhead || showBehind) && (
          <span
            style={AHEAD_BEHIND_GROUP}
            data-testid={isFirst ? "prompt-git-ahead-behind" : undefined}
            aria-hidden={!isFirst}
            title={
              showAhead && showBehind
                ? `${gitAhead} ahead, ${gitBehind} behind upstream`
                : showAhead
                  ? `${gitAhead} ahead of upstream`
                  : `${gitBehind} behind upstream`
            }
          >
            {showAhead && (
              <span>
                <span style={ARROW_GLYPH}>↑</span>
                {gitAhead}
              </span>
            )}
            {showBehind && (
              <span>
                <span style={ARROW_GLYPH}>↓</span>
                {gitBehind}
              </span>
            )}
          </span>
        )}
        {langChip !== null && (
          <span
            style={LANG_GROUP}
            data-testid={isFirst ? "prompt-language" : undefined}
            data-language={langChip.label}
            aria-hidden={!isFirst}
            title={`Detected language: ${langChip.displayName}`}
          >
            <span style={LANG_ICON}>{langChip.icon}</span>
            {langChip.displayName}
          </span>
        )}
      </span>
      <span style={{ ...PROMPT_GLYPH, ...chromeStyle }} aria-hidden={!isFirst}>
        ❯
      </span>
      <span style={LINE_AREA} data-testid={isFirst ? "prompt-line" : undefined} data-row={rowIdx}>
        <span data-testid={isFirst ? "prompt-line-text" : undefined}>
          {rowSpans(row, 0, beforeEnd)}
        </span>
        {cursorCol !== null && shouldRenderCursor(cursorKind, cursorFocused) && (
          <span
            style={cursorStyle(cursorKind, cursorFocused)}
            data-testid="prompt-cursor"
            data-cursor-kind={cursorKind}
            data-cursor-focused={cursorFocused ? "true" : "false"}
            aria-hidden="true"
          >
            {isBlockCursor ? cursorChar : ""}
          </span>
        )}
        {row.text.length > 0 || cursorCol !== null ? (
          <span>{rowSpans(row, afterStart, row.text.length)}</span>
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
