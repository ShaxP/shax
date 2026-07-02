/**
 * Git-aware argv helpers.
 *
 * The generic `argv0-subcommand` matcher walks argv looking
 * for the first non-flag positional. That's fine for most
 * subcommand-style tools, but git has global options that
 * take a value in the *next* argv slot (`-C <path>`,
 * `-c <name>=<value>`, `--git-dir <path>`, …). Without
 * skipping the value, `git -C /repo status` shows up as
 * having `/repo` before `status`, and the matcher gives up.
 *
 * These helpers do the git-specific tokenisation so the
 * git-status and git-diff formatters can:
 *
 *   - Match reliably regardless of `-C` / `-c` / …
 *   - Resolve the effective cwd from `-C` when the user
 *     scoped the command that way, falling back to
 *     `FormatterContext.cwd` otherwise.
 *   - Pull the args after the subcommand for gate checks
 *     and re-probes.
 *
 * Pure module — string in, string out.
 */

/** Git global options that consume the next argv slot as
 *  their value. `--flag=value` forms are handled separately
 *  (they carry the value inline and don't consume a slot). */
const GIT_VALUE_FLAGS = new Set<string>([
  "-C",
  "-c",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

/** Return the git subcommand name (`"status"`, `"diff"`, …)
 *  or `null` when argv doesn't start with `git` or the walk
 *  runs out before finding a positional. Skips known
 *  value-taking flags along with their value slot. */
export function findGitSubcommand(argv: readonly string[]): string | null {
  if (argv[0] !== "git") return null;
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i] ?? "";
    if (tok.length === 0) {
      i++;
      continue;
    }
    // `--flag=value` — inline value, no next-slot consume.
    if (tok.startsWith("--") && tok.includes("=")) {
      i++;
      continue;
    }
    if (tok.startsWith("-")) {
      i += GIT_VALUE_FLAGS.has(tok) ? 2 : 1;
      continue;
    }
    return tok;
  }
  return null;
}

/** Return the value the user passed after `-C`, or `null` if
 *  no `-C` was on the command line (or it was malformed).
 *  Only reads the value form; the widget doesn't need to
 *  understand `-c` config overrides. */
export function findGitDashC(argv: readonly string[]): string | null {
  if (argv[0] !== "git") return null;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "-C") {
      const value = argv[i + 1];
      return value ?? null;
    }
  }
  return null;
}

/** Return every argv token that follows the subcommand.
 *  Skips `git` and its global options (with their value
 *  slots), then the subcommand itself, then returns the rest
 *  verbatim. Used by promotion gates and args extraction so
 *  they see exactly what the user typed after the subcommand,
 *  independent of any `-C` / `-c` prefix. */
export function argsAfterSubcommand(argv: readonly string[]): string[] {
  if (argv[0] !== "git") return [];
  const out: string[] = [];
  let i = 1;
  let pastSubcommand = false;
  while (i < argv.length) {
    const tok = argv[i] ?? "";
    if (!pastSubcommand) {
      if (tok.length === 0) {
        i++;
        continue;
      }
      if (tok.startsWith("--") && tok.includes("=")) {
        i++;
        continue;
      }
      if (tok.startsWith("-")) {
        i += GIT_VALUE_FLAGS.has(tok) ? 2 : 1;
        continue;
      }
      pastSubcommand = true;
      i++;
      continue;
    }
    out.push(tok);
    i++;
  }
  return out;
}
