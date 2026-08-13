/**
 * `CommandSpans` — syntax-highlighted render of a shell command line
 * (M12.6a, spec §18 D6).
 *
 * Single source of truth for "render this shell command with the
 * `--syntax-*` theme palette." Consumed by:
 *
 *   - `PromptStrip` — the live-typing surface (M12.5); also carries
 *     the mirror renderer's per-character `styled` (autosuggestion
 *     ghost) and `selected` (SGR-7 / mark region) axes.
 *   - `BlockRow`'s `CommandText` — the block-header command row
 *     (M12.6a); text-only, no styled/selected inputs.
 *   - Future surfaces per M12.6b/c — search snippets, palette
 *     command-recall, assistant shell fences.
 *
 * Rendering contract:
 *
 *   - Runs the M12.5 tokenizer against `text`, groups characters
 *     into runs by (styled, selected, syntaxKind), emits one
 *     `<span style={{color:…}}>` per run. No wrapper element —
 *     callers get a React fragment of leaf spans to place inside
 *     their own layout container.
 *   - Precedence in `runStyle` matches the M12.5 spec:
 *       selected background > styled dim > syntax color.
 *   - Fidelity fallback: any tokenizer throw drops the whole text
 *     to monochrome. Never breaks rendering because the highlighter
 *     hit an unexpected shape.
 *
 * `styled` / `selected` default to all-false arrays when omitted, so
 * text-only callers (block header, search snippets, assistant fences)
 * don't have to construct dummy arrays.
 */

import type { CSSProperties, ReactElement } from "react";
import { tokenize, type SyntaxKind } from "./promptSyntax";

/** M12.2: cells the shell painted as selected via SGR 7 (reverse
 *  video) or a non-default background — vi visual mode, emacs
 *  mark-and-region, etc. Rendered with an accent-soft background so
 *  the user can see what will be operated on. */
const SELECTED_TEXT: CSSProperties = {
  background: "var(--accent-soft)",
  color: "var(--fg)",
  borderRadius: 2,
};

/** M12.5: cells the shell painted with a non-default foreground SGR
 *  (zsh-autosuggestions ghost text, other dim hints). Rendered in
 *  `--fg-faint` so the hint stays visibly secondary to committed
 *  input. Wins over syntax color per M12.5 spec. */
const STYLED_TEXT: CSSProperties = {
  color: "var(--fg-faint)",
};

interface StyledRun {
  text: string;
  styled: boolean;
  selected: boolean;
  syntaxKind: SyntaxKind | null;
}

/** Per-character syntax kind array. Empty on tokenizer failure OR
 *  when `text` is empty — both render as monochrome (see
 *  `styledRuns`). */
function syntaxPerChar(text: string): (SyntaxKind | null)[] {
  if (text.length === 0) return [];
  const out: (SyntaxKind | null)[] = new Array<SyntaxKind | null>(text.length).fill(null);
  try {
    for (const tok of tokenize(text)) {
      const kind = tok.kind === "text" ? null : tok.kind;
      for (let i = tok.start; i < tok.end && i < text.length; i++) {
        out[i] = kind;
      }
    }
  } catch {
    // Fidelity contract (CLAUDE.md §"non-negotiable" #2): any
    // tokenizer throw drops the row back to monochrome. Never break
    // input rendering because a highlighter hit an unexpected shape.
    return new Array<SyntaxKind | null>(text.length).fill(null);
  }
  return out;
}

/** Group consecutive characters that share all three axes
 *  (styled + selected + syntaxKind) into runs. Empty input →
 *  empty array. */
function styledRuns(text: string, styled: boolean[], selected: boolean[]): StyledRun[] {
  if (text.length === 0) return [];
  const syntax = syntaxPerChar(text);
  const runs: StyledRun[] = [];
  let runText = "";
  let runStyled = styled[0] ?? false;
  let runSelected = selected[0] ?? false;
  let runSyntax = syntax[0] ?? null;
  for (let i = 0; i < text.length; i++) {
    const s = styled[i] ?? false;
    const sel = selected[i] ?? false;
    const syn = syntax[i] ?? null;
    if (s !== runStyled || sel !== runSelected || syn !== runSyntax) {
      runs.push({
        text: runText,
        styled: runStyled,
        selected: runSelected,
        syntaxKind: runSyntax,
      });
      runText = "";
      runStyled = s;
      runSelected = sel;
      runSyntax = syn;
    }
    runText += text.charAt(i);
  }
  if (runText.length > 0) {
    runs.push({
      text: runText,
      styled: runStyled,
      selected: runSelected,
      syntaxKind: runSyntax,
    });
  }
  return runs;
}

/** Map a syntax kind to its CSS color variable. `null` (plain text /
 *  tokenizer failure) yields no color override so the run renders in
 *  the ambient `--fg`. */
function syntaxColor(kind: SyntaxKind | null): string | undefined {
  switch (kind) {
    case "command":
      return "var(--syntax-command)";
    case "subcommand":
      return "var(--syntax-subcommand)";
    case "flag":
      return "var(--syntax-flag)";
    case "operator":
      return "var(--syntax-operator)";
    case "string":
      return "var(--syntax-string)";
    case "variable":
      return "var(--syntax-variable)";
    case "comment":
      return "var(--syntax-comment)";
    default:
      return undefined;
  }
}

/** Compose the three per-run flags into an inline style. Precedence
 *  (per spec §18 M12.5):
 *    selected (accent background) > styled (ghost dim) > syntax color.
 *  Selected wins because the background bar needs foreground
 *  contrast; dim wins over syntax so ghost text stays visibly
 *  secondary regardless of what the tokenizer paints it as. */
function runStyle(run: StyledRun): CSSProperties | undefined {
  if (run.selected) return SELECTED_TEXT;
  if (run.styled) return STYLED_TEXT;
  const color = syntaxColor(run.syntaxKind);
  return color === undefined ? undefined : { color };
}

/**
 * Props for `CommandSpans`. `text` is the shell line to render;
 * `styled` and `selected` are optional per-character axis arrays for
 * the prompt-strip case. Defaults to all-false arrays so text-only
 * callers can just pass `<CommandSpans text={cmd} />`.
 */
export interface CommandSpansProps {
  text: string;
  styled?: readonly boolean[];
  selected?: readonly boolean[];
}

/**
 * Render `text` as a fragment of syntax-coloured `<span>` runs. No
 * wrapper element — the caller supplies whatever container fits
 * their layout (a `<span>`, `<code>`, `<div>`, etc.).
 */
export function CommandSpans({ text, styled, selected }: CommandSpansProps): ReactElement {
  // Copy readonly arrays to mutable ones so `styledRuns` can index
  // them uniformly; missing entries default to false (see the `??`
  // fallbacks inside `styledRuns`).
  const styledArr: boolean[] = styled ? Array.from(styled) : [];
  const selectedArr: boolean[] = selected ? Array.from(selected) : [];
  const runs = styledRuns(text, styledArr, selectedArr);
  return (
    <>
      {runs.map((run, idx) => (
        <span key={idx} style={runStyle(run)}>
          {run.text}
        </span>
      ))}
    </>
  );
}
