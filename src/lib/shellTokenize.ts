/**
 * Shell-style word splitter.
 *
 * Honours the three sources of whitespace-with-spaces-in-it the user
 * actually types:
 *
 *   `cat foo\ bar.gif`     → ["cat", "foo bar.gif"]
 *   `cat "foo bar.gif"`    → ["cat", "foo bar.gif"]
 *   `cat 'foo bar.gif'`    → ["cat", "foo bar.gif"]
 *
 * Rules (POSIX-ish):
 *
 *   - Inside single quotes nothing is special — no backslash escapes.
 *   - Inside double quotes, `\` only escapes `\ " $ ` \n`.
 *   - Outside quotes, `\` escapes any single following character
 *     (including a space, which is the case the slice-4.2 GIF bug
 *     surfaced — a filename `Chainsaw\ Man\ GIF.gif` was being
 *     split into three tokens by a whitespace-only splitter).
 *
 * Not a full shell parser: pipelines, redirects, command
 * substitution, `$VAR` expansion are intentionally ignored. Callers
 * use this for "extract a filename" / "match argv[0]" cases, not
 * for faithful argv reconstruction.
 */
export function shellTokenize(command: string | null): string[] {
  if (command === null || command.length === 0) return [];
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i] ?? "";
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < command.length) {
        const next = command[i + 1] ?? "";
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
          current += next;
          i += 2;
        } else {
          current += ch;
          i++;
        }
      } else if (ch === '"') {
        inDouble = false;
        i++;
      } else {
        current += ch;
        i++;
      }
      continue;
    }
    // Outside any quotes.
    if (ch === "\\" && i + 1 < command.length) {
      current += command[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}
