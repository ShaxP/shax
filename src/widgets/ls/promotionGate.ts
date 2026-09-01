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
 *   - `--color[=WHEN]` — noise flag for the widget; we probe the
 *     filesystem rather than parse ls output bytes (spec §07
 *     rule 2), so ANSI colour codes in the raw output are
 *     irrelevant to us. Whitelisting matters because Fedora /
 *     Ubuntu ship `alias ls='ls --color=auto'` in their default
 *     rc files, and rejecting that alias was silently degrading
 *     every Linux user's ls to the non-interactive formatter.
 *   - `--group-directories-first` — ordering, applied by
 *     `applyLsView`; see the `--icons` note below for why both
 *     matter on eza-aliasing distros
 *   - `--icons[=WHEN]` — decoration of the raw bytes only. Omarchy
 *     ships `alias ls='eza -lh --group-directories-first
 *     --icons=auto'`, and rejecting it degraded every pane's `ls`
 *     to the non-interactive formatter — the same failure the
 *     `--color=auto` entry above was added to fix.
 *   - positional path arguments
 *   - `--` separator
 *
 * Rejected:
 *   - anything else (e.g. `--sort=X`, `-F`, `-p`) — flags that
 *     would change entry ordering or filename decoration we
 *     don't have parser support for.
 *
 * Positional paths — including glob patterns, tilde, and env vars —
 * always promote here: the actual filesystem resolution happens in
 * the formatter via the backend `resolve_ls_arg` command, which
 * mirrors what the shell did at execution time. If that resolution
 * fails, the formatter itself renders a "check RAW" line (not the
 * widget), so the promotion gate can be permissive about paths.
 *
 * Pure module.
 */

/** Long flags accepted with no value (`--flag`) or with any value
 *  after `=` (`--flag=whatever`) when the flag itself is a "noise"
 *  flag — no effect on the widget render. */
const KNOWN_OK_LONG_FLAGS = new Set<string>([
  "--all",
  "--almost-all",
  "--long",
  "--human-readable",
  "--reverse",
  // Noise flag: filesystem-probe render is unaffected by colouring
  // of the raw ls bytes. See header comment for why this matters
  // on Linux specifically.
  "--color",
  // Ordering flag, honoured for real by `applyLsView` rather than
  // waved through as noise — the widget must not show a different
  // order than the bytes the user actually got.
  "--group-directories-first",
  // Noise flag, same reasoning as `--color`: the widget draws its
  // own icons from a filesystem probe, so whatever eza decorated
  // the raw bytes with is irrelevant. `--icons` takes an optional
  // `=WHEN` value, handled by the `split("=")` below.
  "--icons",
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
      // flag name up to the `=`. We accept any value for known
      // noise flags (e.g. `--color=auto` and `--color=always`
      // both promote because the widget ignores the value).
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
    // Positional path — always fine. Backend expansion via
    // `resolve_ls_arg` handles globs, tilde, and env vars; the
    // widget doesn't need to gate on them.
  }
  return true;
}
