/**
 * Tokenizer tests for `promptSyntax.ts` (M12.5, spec §18 D5).
 *
 * The tokenizer is the pure/testable seam behind the syntax
 * highlighter. These tests pin the classification rules; the
 * PromptStrip render-path tests live separately.
 *
 * Every test uses the same helper: assert the concatenation of
 * every token's text equals the input (the tokenizer is loss-less
 * by contract) plus assert the specific `(text, kind)` pairs the
 * scenario cares about. That way even a bug that only affects one
 * kind still shows the full run structure in the failure output.
 */

import { describe, expect, it } from "vitest";
import { tokenize, type Token, type SyntaxKind } from "./promptSyntax";

/**
 * Reconstruct a (text, kind) array from a tokenize() result so the
 * test can compare against a readable literal.
 */
function label(line: string, tokens: Token[]): Array<[string, SyntaxKind]> {
  return tokens.map((t) => [line.slice(t.start, t.end), t.kind]);
}

/**
 * The tokenizer's core invariant: joining every token's slice back
 * together reproduces the input exactly. Every test calls this to
 * catch a class of bugs (dropped chars, overlapping ranges, gaps)
 * without listing every char in the expected array.
 */
function assertLossless(line: string, tokens: Token[]): void {
  const joined = tokens.map((t) => line.slice(t.start, t.end)).join("");
  expect(joined).toBe(line);
  // Also assert ranges are strictly monotonic and non-overlapping.
  let prevEnd = 0;
  for (const t of tokens) {
    expect(t.start).toBe(prevEnd);
    expect(t.end).toBeGreaterThan(t.start);
    prevEnd = t.end;
  }
}

describe("promptSyntax / basic classification", () => {
  it("colours a bare command", () => {
    const line = "ls";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)).toEqual([["ls", "command"]]);
  });

  it("colours command + flag", () => {
    const line = "ls -la";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)).toEqual([
      ["ls", "command"],
      [" ", "text"],
      ["-la", "flag"],
    ]);
  });

  it("colours command + subcommand + flag + string (git commit)", () => {
    const line = 'git commit -m "hello world"';
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)).toEqual([
      ["git", "command"],
      [" ", "text"],
      ["commit", "subcommand"],
      [" ", "text"],
      ["-m", "flag"],
      [" ", "text"],
      ['"hello world"', "string"],
    ]);
  });

  it("does NOT paint subcommand for non-multi-tool commands", () => {
    // `echo` isn't in MULTI_TOOLS, so its second word stays as text.
    const line = "echo hello";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)).toEqual([
      ["echo", "command"],
      [" ", "text"],
      ["hello", "text"],
    ]);
  });

  it("only paints the FIRST word after a multi-tool as subcommand", () => {
    // Only `commit` gets the subcommand colour; `origin` is text.
    const line = "git push origin main";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    const kinds = label(line, tokens).map(([, k]) => k);
    expect(kinds.filter((k) => k === "subcommand")).toHaveLength(1);
    expect(label(line, tokens)[2]?.[0]).toBe("push");
    expect(label(line, tokens)[2]?.[1]).toBe("subcommand");
  });
});

describe("promptSyntax / operators + segment resets", () => {
  it("colours pipeline operators and re-treats the next word as a command", () => {
    const line = "echo hi | grep h";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)).toEqual([
      ["echo", "command"],
      [" ", "text"],
      ["hi", "text"],
      [" ", "text"],
      ["|", "operator"],
      [" ", "text"],
      ["grep", "command"],
      [" ", "text"],
      ["h", "text"],
    ]);
  });

  it("distinguishes `&&` from `&` (longest-match)", () => {
    const line = "true && echo ok";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)[2]).toEqual(["&&", "operator"]);
  });

  it("distinguishes `||` from `|` (longest-match)", () => {
    const line = "false || echo bad";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)[2]).toEqual(["||", "operator"]);
  });

  it("distinguishes `>>` from `>` (longest-match)", () => {
    const line = "echo hi >> out";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)[4]).toEqual([">>", "operator"]);
  });

  it("treats `;` as an operator and resets the command position", () => {
    const line = "cd /tmp; ls";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    // cd, space, /tmp, ;, space, ls
    expect(label(line, tokens)[0]).toEqual(["cd", "command"]);
    expect(label(line, tokens)[3]).toEqual([";", "operator"]);
    expect(label(line, tokens)[5]).toEqual(["ls", "command"]);
  });
});

describe("promptSyntax / strings and quotes", () => {
  it("closes a well-formed double-quoted string", () => {
    const line = 'echo "hi"';
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)[2]).toEqual(['"hi"', "string"]);
  });

  it("closes a well-formed single-quoted string", () => {
    const line = "echo 'hi'";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)[2]).toEqual(["'hi'", "string"]);
  });

  it("runs an unbalanced quote to end-of-line without throwing", () => {
    const line = 'echo "unterminated';
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    // The string kind should cover from `"` through end-of-input.
    expect(label(line, tokens)[2]).toEqual(['"unterminated', "string"]);
  });

  it("respects backslash escape inside double quotes (not single)", () => {
    // Double: \" is escaped, string continues.
    const dq = 'echo "a\\"b"';
    const dqTokens = tokenize(dq);
    assertLossless(dq, dqTokens);
    expect(label(dq, dqTokens)[2]).toEqual(['"a\\"b"', "string"]);
    // Single: \' does NOT escape (POSIX), so the string ends at `'`.
    const sq = "echo 'a\\'b'";
    const sqTokens = tokenize(sq);
    assertLossless(sq, sqTokens);
    // First single-string is 'a\' (up to and including the next ').
    expect(label(sq, sqTokens)[2]).toEqual(["'a\\'", "string"]);
  });

  it("colours a backtick command substitution as a string", () => {
    const line = "echo `date`";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)[2]).toEqual(["`date`", "string"]);
  });
});

describe("promptSyntax / variables", () => {
  it("colours simple $name", () => {
    const line = "echo $HOME";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)[2]).toEqual(["$HOME", "variable"]);
  });

  it("colours ${braced} form (well-formed)", () => {
    const line = "echo ${HOME}";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)[2]).toEqual(["${HOME}", "variable"]);
  });

  it("colours single-char special parameters ($? $! $$ $0..$9)", () => {
    for (const p of ["$?", "$!", "$$", "$#", "$@", "$*", "$-", "$0", "$9"]) {
      const line = `echo ${p}`;
      const tokens = tokenize(line);
      assertLossless(line, tokens);
      expect(label(line, tokens)[2]).toEqual([p, "variable"]);
    }
  });

  it("a bare `$` with no valid follower is text", () => {
    const line = "echo $ end";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    // $ alone is text.
    const dollarToken = tokens.find((t) => line.slice(t.start, t.end) === "$");
    expect(dollarToken?.kind).toBe("text");
  });
});

describe("promptSyntax / comments", () => {
  it("colours a `#`-comment to end-of-line", () => {
    const line = "ls # inline note";
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    // Last token is the comment.
    const last = tokens[tokens.length - 1];
    expect(last && line.slice(last.start, last.end)).toBe("# inline note");
    expect(last?.kind).toBe("comment");
  });

  it("does NOT treat `#` inside a string as a comment", () => {
    const line = 'echo "hash # inside"';
    const tokens = tokenize(line);
    assertLossless(line, tokens);
    expect(label(line, tokens)[2]).toEqual(['"hash # inside"', "string"]);
    // No comment token in the output.
    expect(tokens.some((t) => t.kind === "comment")).toBe(false);
  });
});

describe("promptSyntax / fidelity contract", () => {
  it("never throws on arbitrary shell-shaped fuzz input", () => {
    // A grab-bag of malformed inputs a user could plausibly type.
    // The tokenizer is spec'd to never throw — even output that
    // groups things "wrongly" is acceptable as long as we get an
    // array back and its ranges are lossless.
    const fuzz = [
      "",
      " ",
      "\n\n\n",
      "$",
      '"',
      "'",
      "`",
      "|||",
      "&&&&",
      ">>>",
      "((((",
      "$$$$$",
      "$@$*$?$!",
      '"unclosed \\',
      "'still open",
      "#",
      "# ",
      "cmd 'a\"b' \"c'd\"",
      "a|b&c;d>e<f>>g<<h||i&&j",
      "git commit -m",
      "git ",
      "\\",
      "\\\\",
    ];
    for (const line of fuzz) {
      const tokens = tokenize(line);
      // Lossless invariant holds even on garbage.
      const joined = tokens.map((t) => line.slice(t.start, t.end)).join("");
      expect(joined).toBe(line);
    }
  });

  it("empty input returns an empty token list", () => {
    expect(tokenize("")).toEqual([]);
  });
});
