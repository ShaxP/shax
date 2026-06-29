/**
 * Formatter contract (M4 slice 4.3, per `specs/07-formatters.md`).
 *
 * A formatter turns a completed block's output bytes into a richer
 * tier-1 view. The registry picks the highest-priority formatter
 * whose matcher returns true; the formatter returns a React node,
 * structured data, or the `PASS` sentinel to decline and let the
 * next-lower tier (raw bytes) handle it.
 *
 * Three rules hard-baked into the registry:
 *
 *   1. **Raw is always one click away.** Every formatted block has
 *      a visible RAW toggle that bypasses the formatter entirely.
 *   2. **Silent fallback on throw.** A formatter that errors falls
 *      back to RAW with no visible breakage. Enforced at the
 *      registry's invoke boundary.
 *   3. **Built-ins run trusted; community runs sandboxed.** This
 *      file describes the trusted-formatter contract. The sandbox
 *      lands in slice 4.6; until then, all formatters are
 *      built-in and run on the main thread.
 *
 * Pure type module — no React imports, no DOM access, no Tauri.
 */

import type { ReactNode } from "react";
import type { PtyId } from "../lib/ipc";

/**
 * Everything a formatter sees about the block it's rendering.
 * Mirrors spec §07 except for two notes:
 *
 *   - `stderr` is currently always the empty string: the backend
 *     captures combined stdout+stderr into `stdout`. Splitting
 *     the streams is M4 polish / M5 prep.
 *   - `env` is the empty object today: the backend doesn't
 *     capture per-block env. Formatters that need it (M5
 *     widgets, mainly) will surface that gap.
 *
 * Both gaps are honest non-fidelity, not silent corruption —
 * formatters can write `if (ctx.stderr.length === 0)` and still
 * be correct.
 */
export interface FormatterContext {
  /** Tokenised command (`["cat", "README.md"]`). Output of
   *  `shellTokenize(block.command)`. Empty for blocks with a
   *  null command. */
  readonly argv: readonly string[];
  /** cwd reported by OSC 133 D at block completion. */
  readonly cwd: string | null;
  /** Filtered env (no secrets). Empty object today. */
  readonly env: Readonly<Record<string, string>>;
  /** Exit code; `null` if the block is still running or aborted. */
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** ANSI-stripped, utf-8 decoded captured output. */
  readonly stdout: string;
  /** Always `""` for now (see header note). */
  readonly stderr: string;
  /** Original captured bytes as a utf-8 string, *with* ANSI
   *  escapes preserved. The `ls` formatter uses this to read
   *  SGR colours; most formatters can ignore. */
  readonly rawAnsi: string;
  /** The pane the block came from. */
  readonly paneId: PtyId;
}

/** Sentinel returned from `render` to decline this block. The
 *  registry will move on to the next matching formatter, or fall
 *  back to RAW. */
export const PASS: unique symbol = Symbol("formatter-pass");
export type Pass = typeof PASS;

export type FormatterResult = ReactNode | Pass;

/**
 * Matcher predicates. Three shapes covered:
 *
 *   - argv0-only: matches when `ctx.argv[0] === argv0`.
 *   - argv0 + subcommand: matches when `ctx.argv[0] === argv0`
 *     AND `ctx.argv[1] === subcommand` (the first non-flag
 *     positional). Used for `git diff`, `git status`, etc.
 *   - predicate: arbitrary function over the context. Escape
 *     hatch for matchers we don't have a shorthand for yet.
 */
export type Matcher =
  | { kind: "argv0"; argv0: string }
  | { kind: "argv0-subcommand"; argv0: string; subcommand: string }
  | { kind: "predicate"; test: (ctx: FormatterContext) => boolean };

/**
 * A registered formatter. `priority` is the resolver tie-break:
 * higher wins. Built-ins all live at priority 0 today; the
 * sandbox in 4.6 will run community formatters at a lower
 * priority so a built-in always wins on overlap.
 */
export interface Formatter {
  /** Display name (logs, debug). */
  readonly name: string;
  readonly matcher: Matcher;
  readonly priority?: number;
  /** Whether the modal viewer should defer to this formatter when
   *  the user opens the block via the eye icon. Defaults to
   *  `true`. Set `false` on formatters whose modal-context output
   *  is strictly less rich than the built-in viewer's
   *  content-type routing — e.g. `cat README.md` rendered through
   *  the cat formatter would lose the modal's MarkdownView /
   *  ImageView specialisations. The inline-block FMT pill still
   *  uses the formatter regardless of this flag. */
  readonly useInModal?: boolean;
  readonly render: (ctx: FormatterContext) => FormatterResult;
}

/**
 * Type guard: did the render call decline? Use this on the
 * call-site to know whether to fall back to RAW.
 */
export function isPass(result: FormatterResult): result is Pass {
  return result === PASS;
}
