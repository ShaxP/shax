/**
 * Formatter system entry point.
 *
 * Importing this module side-effect-registers every built-in
 * formatter. The block row imports from here once at module load.
 *
 * Public surface:
 *   - `findFormatter(ctx)` — registry lookup.
 *   - `invokeFormatter(f, ctx)` — render with silent-fallback-on-throw.
 *   - `FormatterContext`, `Formatter`, `PASS`, `isPass` — types.
 *
 * Built-ins so far: `cat`, `bat` (this slice). Slices 4.4 → 4.6
 * will add `ls`, `git status`, `git diff`, JSON.
 */

import { register } from "./registry";
import { batFormatter, catFormatter } from "./cat";
import { gitDiffFormatter } from "./gitDiff";
import { gitStatusFormatter } from "./gitStatus";
import { jsonFormatter } from "./json";
import { exaFormatter, ezaFormatter, lsFormatter } from "./ls";
import { wcSandboxFormatter } from "./sandbox/samples/wc";

// Side-effect registration on first import. Idempotent: `register`
// no-ops on duplicate `name`. JSON wins on priority over `cat` so
// `cat foo.json` lands in the tree view, not the source viewer.
register(catFormatter);
register(batFormatter);
register(lsFormatter);
register(ezaFormatter);
register(exaFormatter);
register(gitStatusFormatter);
register(gitDiffFormatter);
register(jsonFormatter);
// `wc` is the first sandboxed-shape formatter — runs in a Web
// Worker via the slice-4.6b1 scaffolding even though it ships
// bundled with the app. Disk-loaded community formatters land
// in 4.6b2 and flow through the same factory.
register(wcSandboxFormatter);

export { findFormatter, invokeFormatter, isPass, PASS } from "./registry";
export type { Formatter, FormatterContext, FormatterResult, Matcher, Pass } from "./types";
