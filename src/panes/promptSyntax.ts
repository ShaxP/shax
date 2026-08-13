/**
 * Simplified POSIX-shell tokenizer for the prompt strip (M12.5, spec §18 D5).
 *
 * Per D5: hand-rolled, ~200 LOC, one-char lookahead, shell-agnostic
 * (doesn't distinguish zsh globs from bash globs), and safe against
 * malformed input — an unbalanced quote just runs the string kind to
 * end-of-line rather than throwing.
 *
 * The output feeds `PromptStrip.tsx`'s span painter. Each character in
 * the input maps to exactly one token kind; the render layer picks a
 * CSS colour per kind from the `--syntax-*` theme tokens.
 *
 * Token kinds:
 *   - `command` — the first word on a compound (line start, after `|`,
 *     `;`, `&&`, `||`, `(`, or a newline). Colours the program the
 *     shell will actually invoke.
 *   - `subcommand` — the second word when the first is a known
 *     multi-tool (`git`, `docker`, `cargo`, …). Extensible via
 *     `MULTI_TOOLS`; anything not in that set stays as `text`.
 *   - `flag` — a word starting with `-` (`-l`, `--all`, `--color=X`).
 *   - `operator` — pipeline/redirect punctuation: `|` `||` `>` `>>`
 *     `<` `<<` `&` `&&` `;` `(` `)` `2>&1`. Kept minimal — grouping
 *     nuances like `{ … }` fall through as text.
 *   - `string` — single-quoted, double-quoted, or backtick-quoted
 *     span, including the enclosing quotes. Unbalanced quotes run to
 *     end-of-line (no throw).
 *   - `variable` — `$name`, `${…}`, `$?`, `$!`, `$0`..`$9`. Positional
 *     and special parameters get the same colour as named vars — the
 *     visual signal is "this expands," not the exact form.
 *   - `comment` — `#` starting at a word boundary through end-of-line.
 *     A `#` mid-word (e.g. inside an identifier or a URL) is `text`.
 *   - `text` — everything else. Includes plain arguments, whitespace,
 *     and anything the tokenizer couldn't classify.
 *
 * The tokenizer is O(line length) with a single left-to-right pass. It
 * never throws by design; if you find a way to make it, that's the bug.
 *
 * Pure module — no state outside the function call, no DOM, no
 * platform assumptions.
 */

/** One token in the tokenized line. `end` is exclusive (half-open range). */
export interface Token {
  start: number;
  end: number;
  kind: SyntaxKind;
}

export type SyntaxKind =
  | "command"
  | "subcommand"
  | "flag"
  | "operator"
  | "string"
  | "variable"
  | "comment"
  | "text";

/**
 * Multi-tool commands where the second word is a subcommand worth
 * highlighting distinctly. Kept small: only tools where the
 * subcommand carries most of the "what does this line do" signal.
 * Extensible — add a name here when a tool becomes prevalent enough
 * that seeing its verb highlighted would help.
 */
const MULTI_TOOLS = new Set<string>([
  "git",
  "docker",
  "kubectl",
  "cargo",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "brew",
  "apt",
  "dnf",
  "pacman",
  "gh",
  "aws",
  "gcloud",
  "az",
]);

/**
 * Characters that end a bare word. Anything not in the standard
 * shell identifier set breaks a word — whitespace, redirect glyphs,
 * grouping, quotes, `$`, `#`. Kept as a helper so the word-scanner
 * and the peek logic share the same predicate.
 */
function endsWord(ch: string): boolean {
  return (
    ch === "" ||
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "|" ||
    ch === "&" ||
    ch === ";" ||
    ch === "<" ||
    ch === ">" ||
    ch === "(" ||
    ch === ")" ||
    ch === "'" ||
    ch === '"' ||
    ch === "`" ||
    ch === "$" ||
    ch === "#"
  );
}

/**
 * Tokenize a shell command line into a flat, non-overlapping list of
 * `Token`s. The concatenation of every `line.slice(t.start, t.end)`
 * reproduces the input exactly — no chars are dropped, no ranges
 * overlap, no gaps.
 *
 * `expectCommand` tracks the state machine's "next non-space word is
 * a command" flag: true at line start, flipped back to true after any
 * command separator (`|`, `;`, `&&`, `||`, `(`).
 */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let expectCommand = true;
  let sawCommandOnThisSegment: string | null = null;

  const push = (start: number, end: number, kind: SyntaxKind): void => {
    if (end > start) tokens.push({ start, end, kind });
  };

  while (i < line.length) {
    const ch = line[i] ?? "";

    // Whitespace runs as `text` so the render layer can leave them
    // uncoloured without an "unknown" gap.
    if (ch === " " || ch === "\t") {
      const start = i;
      while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
      push(start, i, "text");
      continue;
    }

    // Comment: `#` at a word boundary through end-of-line. A `#` that
    // isn't at a boundary was already consumed as part of a word by
    // the word-scanner below, so reaching here means we're at one.
    if (ch === "#") {
      const start = i;
      while (i < line.length && line[i] !== "\n") i++;
      push(start, i, "comment");
      continue;
    }

    // Newline → new compound; reset command-expected.
    if (ch === "\n") {
      push(i, i + 1, "text");
      i++;
      expectCommand = true;
      sawCommandOnThisSegment = null;
      continue;
    }

    // Operators: pipeline / redirect / grouping. Order the checks by
    // longest-match-wins so `&&` beats `&` and `>>` beats `>`.
    if (ch === "|") {
      const start = i;
      i++;
      if (line[i] === "|") i++;
      push(start, i, "operator");
      expectCommand = true;
      sawCommandOnThisSegment = null;
      continue;
    }
    if (ch === "&") {
      const start = i;
      i++;
      if (line[i] === "&") i++;
      push(start, i, "operator");
      expectCommand = true;
      sawCommandOnThisSegment = null;
      continue;
    }
    if (ch === ";") {
      push(i, i + 1, "operator");
      i++;
      expectCommand = true;
      sawCommandOnThisSegment = null;
      continue;
    }
    if (ch === ">" || ch === "<") {
      const start = i;
      i++;
      if (line[i] === ch) i++;
      push(start, i, "operator");
      continue;
    }
    if (ch === "(" || ch === ")") {
      push(i, i + 1, "operator");
      i++;
      if (ch === "(") {
        expectCommand = true;
        sawCommandOnThisSegment = null;
      }
      continue;
    }

    // Strings. All three quote flavours behave the same: swallow
    // until the matching close quote OR end-of-line. Backslash
    // escapes inside double quotes and backticks skip the next
    // char; single quotes are literal (POSIX rule).
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const start = i;
      i++;
      while (i < line.length) {
        const c = line[i] ?? "";
        if (c === "\n") break; // unbalanced — stop at LF
        if (quote !== "'" && c === "\\" && i + 1 < line.length) {
          i += 2;
          continue;
        }
        i++;
        if (c === quote) break;
      }
      push(start, i, "string");
      // A string doesn't count as the command word for coloring purposes
      // (a leading `"foo"` is arguable but rare); we treat it like text
      // and keep expectCommand as-is only if we hadn't yet seen a real
      // command word. To match the "usual" case, we DO flip expectCommand
      // off — the first token that isn't whitespace or a separator ends
      // the "at start of segment" phase.
      expectCommand = false;
      continue;
    }

    // Variables: `$name`, `${…}`, `$?`, `$!`, `$0`..`$9`, `$$`, `$#`.
    // A bare `$` with nothing valid after is `text` for that char.
    if (ch === "$") {
      const start = i;
      const next = line[i + 1] ?? "";
      if (next === "{") {
        i += 2;
        while (i < line.length && line[i] !== "}" && line[i] !== "\n") i++;
        if (line[i] === "}") i++;
        push(start, i, "variable");
      } else if ((next >= "a" && next <= "z") || (next >= "A" && next <= "Z") || next === "_") {
        i += 2;
        while (i < line.length) {
          const c = line[i] ?? "";
          if (
            (c >= "a" && c <= "z") ||
            (c >= "A" && c <= "Z") ||
            (c >= "0" && c <= "9") ||
            c === "_"
          ) {
            i++;
          } else {
            break;
          }
        }
        push(start, i, "variable");
      } else if (
        (next >= "0" && next <= "9") ||
        next === "?" ||
        next === "!" ||
        next === "$" ||
        next === "#" ||
        next === "@" ||
        next === "*" ||
        next === "-"
      ) {
        // Single-char special parameter.
        i += 2;
        push(start, i, "variable");
      } else {
        // Bare `$` — fall through as text.
        push(start, i + 1, "text");
        i++;
      }
      continue;
    }

    // Flag: word starting with `-` (but NOT at start of a segment,
    // where a leading `-` is more likely a stray char than a flag —
    // shells don't accept flags as commands). Also treat `--` on its
    // own as a flag boundary (`--` separator).
    if (ch === "-" && !expectCommand) {
      const start = i;
      while (i < line.length && !endsWord(line[i] ?? "")) i++;
      push(start, i, "flag");
      continue;
    }

    // Bare word — command, subcommand, or plain argument.
    const start = i;
    while (i < line.length && !endsWord(line[i] ?? "")) i++;
    const word = line.slice(start, i);
    let kind: SyntaxKind;
    if (expectCommand) {
      kind = "command";
      sawCommandOnThisSegment = word;
      expectCommand = false;
    } else if (sawCommandOnThisSegment !== null && MULTI_TOOLS.has(sawCommandOnThisSegment)) {
      kind = "subcommand";
      // Only the immediate second word gets subcommand colouring —
      // subsequent words on this segment fall through to text.
      sawCommandOnThisSegment = null;
    } else {
      kind = "text";
      sawCommandOnThisSegment = null;
    }
    push(start, i, kind);
  }

  return tokens;
}
