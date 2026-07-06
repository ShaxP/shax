/**
 * Promotion gate for the `ls` widget (M5 slice 3).
 *
 * Per user decision: honour `-a` (show dotfiles), accept
 * flags that don't change the widget's own render shape (the
 * widget is always dense-with-details regardless of `-l`),
 * reject unknown flags so unusual invocations degrade to
 * the static formatter, then RAW.
 *
 * Accepted:
 *   - `-a`, `-A`, `--all`, `--almost-all` — dotfile visibility
 *   - `-l`, `--long`, `-1` — no-op for the widget but common
 *   - `-h`, `--human-readable` — always human-readable anyway
 *   - `-t`, `-S`, `-r`, `--reverse` — sort order (applied by
 *     `applyLsView`)
 *   - positional path arguments
 *   - `--` separator
 *
 * Rejected:
 *   - anything else (e.g. `--color=X`, `--sort=X`, `-F`, `-p`).
 *
 * Pure module.
 */

const KNOWN_OK_LONG_FLAGS = new Set<string>([
  "--all",
  "--almost-all",
  "--long",
  "--human-readable",
  "--reverse",
]);

// Short-flag chars that are safe. Combined forms like `-la`
// split into individual chars and each is checked.
const KNOWN_OK_SHORT_CHARS = new Set<string>(["l", "a", "A", "h", "1", "t", "S", "r"]);

/** True iff the widget can render this `ls` invocation. */
export function isWidgetPromotable(argv: readonly string[]): boolean {
  let pastSeparator = false;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok.length === 0) continue;
    if (pastSeparator) continue; // rest is positional path
    if (tok === "--") {
      pastSeparator = true;
      continue;
    }
    if (tok.startsWith("--")) {
      // Inline `--flag=value` — reject unless we recognise the
      // flag name up to the `=`.
      const name = tok.split("=", 1)[0] ?? tok;
      if (!KNOWN_OK_LONG_FLAGS.has(name)) return false;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // Short-flag cluster: every char must be recognised.
      for (const ch of tok.slice(1)) {
        if (!KNOWN_OK_SHORT_CHARS.has(ch)) return false;
      }
      continue;
    }
    // Positional path — always fine.
  }
  return true;
}
