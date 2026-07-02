/**
 * Promotion gate for the `git status` widget (M5 slice 2).
 *
 * Per spec §08: a widget renders only when the invocation
 * matches its structured probe. The widget always probes
 * `git status --porcelain=v2 --branch -z` internally, so we
 * only need to reject flags that reshape output *away* from
 * what a machine-readable status covers.
 *
 * Accepted (pass through to widget):
 *   - bare `git status`
 *   - `-s` / `--short`
 *   - `-b` / `--branch`
 *   - `--porcelain[=…]`
 *   - `-u` / `--untracked-files[=…]`
 *   - `--ignored[=…]`
 *   - path filters (`git status -- src/`)
 *
 * Rejected (fall through to static formatter, then raw):
 *   - `--long` (already the default, but non-machine)
 *   - anything else the widget doesn't understand — err on the
 *     side of static rather than misrepresent.
 *
 * Pure module.
 */

const KNOWN_OK_FLAGS = new Set([
  "-s",
  "--short",
  "-b",
  "--branch",
  "--porcelain",
  "-u",
  "--untracked-files",
  "--ignored",
  "--ignore-submodules",
  "-z",
]);

/** True iff the widget can render this `git status` invocation.
 *  `args` is the post-`status` portion of argv. */
export function isWidgetPromotable(statusArgs: readonly string[]): boolean {
  let sawPathSeparator = false;
  for (const arg of statusArgs) {
    if (sawPathSeparator) continue; // everything after `--` is a path filter
    if (arg === "--") {
      sawPathSeparator = true;
      continue;
    }
    if (!arg.startsWith("-")) continue; // positional (revspec / path): fine.
    // Split on `=` so `--porcelain=v1` maps to `--porcelain`.
    const flagPart = arg.split("=", 1)[0] ?? arg;
    if (!KNOWN_OK_FLAGS.has(flagPart)) return false;
  }
  return true;
}
