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
import { exaFormatter, ezaFormatter, lsFormatter } from "./ls";

// Side-effect registration on first import. Idempotent: `register`
// no-ops on duplicate `name`.
register(catFormatter);
register(batFormatter);
register(lsFormatter);
register(ezaFormatter);
register(exaFormatter);

export { findFormatter, invokeFormatter, isPass, PASS } from "./registry";
export type { Formatter, FormatterContext, FormatterResult, Matcher, Pass } from "./types";
