/**
 * Promotion gate for the `git diff` widget (M5 slice 1).
 *
 * Per spec §08: a widget renders only when the invocation is
 * interactive-friendly. For `git diff` that means the diff
 * arguments emit unified-diff output — the format the parser
 * understands. Anything that emits a summary (`--stat`,
 * `--name-only`, `--numstat`, `--shortstat`, `--summary`,
 * `--name-status`) falls back to the static formatter (which
 * then falls back to raw).
 *
 * The gate is deliberately permissive on positional args
 * (revspecs, path filters) and on flags that affect *what* is
 * diffed (`--cached`, `--staged`, `HEAD`, `--merge-base`, …)
 * but not *how* it's presented.
 *
 * Pure module.
 */

/** Flags that change git diff's output format enough that the
 *  parser can't turn it into a widget. Matching is exact; a
 *  flag like `--stat=80` is treated as `--stat`. */
const OUTPUT_KILLING_FLAGS = new Set([
  "--stat",
  "--numstat",
  "--shortstat",
  "--summary",
  "--name-only",
  "--name-status",
  "--check",
  "--dirstat",
  "--compact-summary",
  "--raw",
  "--patch-with-stat",
  "--patch-with-raw",
]);

/** Returns true iff the given post-`diff` arguments emit
 *  standard unified-diff output that the widget can render. */
export function isWidgetPromotable(diffArgs: readonly string[]): boolean {
  for (const arg of diffArgs) {
    // Split on `=` so `--stat=80` matches `--stat`.
    const flagPart = arg.startsWith("--") ? (arg.split("=", 1)[0] ?? arg) : arg;
    if (OUTPUT_KILLING_FLAGS.has(flagPart)) return false;
  }
  return true;
}
