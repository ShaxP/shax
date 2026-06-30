/**
 * Formatter registry (M4 slice 4.3).
 *
 * Process-wide, append-only list of registered formatters. The
 * lookup walks the list in (priority desc, registration order)
 * order and returns the first whose matcher accepts the context.
 * No formatter? Caller falls back to RAW.
 *
 * Two boundaries the rest of the app shouldn't have to think about:
 *
 *   1. **Silent fallback on throw** lives in `invokeFormatter` —
 *      a render that throws is logged and returns `PASS` so the
 *      caller treats it identically to a deliberate decline.
 *      Spec §07 rule 1 ("never let a pretty view hide ground
 *      truth"); the rendering surface always falls back to RAW.
 *
 *   2. **Determinism for tests** — `resetRegistryForTests`
 *      clears the registry; `withTestRegistry` runs a callback
 *      against a fresh registry without touching the real one.
 *      Built-ins re-register themselves when their module is
 *      re-imported in tests.
 */

import { isPass, PASS, type Formatter, type FormatterContext, type FormatterResult } from "./types";

let REGISTRY: Formatter[] = [];

/**
 * Register a formatter. Multiple calls with the same `name` are
 * silently ignored — built-ins re-register themselves on every
 * module load (HMR, test reset) and we don't want duplicates
 * piling up.
 */
export function register(formatter: Formatter): void {
  if (REGISTRY.some((f) => f.name === formatter.name)) return;
  REGISTRY = [...REGISTRY, formatter];
}

/** Find the highest-priority formatter whose matcher accepts `ctx`. */
export function findFormatter(ctx: FormatterContext): Formatter | null {
  // Stable sort: by priority desc, otherwise preserve registration
  // order. Built-ins all use priority 0, so registration order
  // wins — which means the first `register()` call wins ties.
  const ordered = [...REGISTRY].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const f of ordered) {
    if (matches(f, ctx)) return f;
  }
  return null;
}

function matches(formatter: Formatter, ctx: FormatterContext): boolean {
  const m = formatter.matcher;
  switch (m.kind) {
    case "argv0":
      return ctx.argv[0] === m.argv0;
    case "argv0-subcommand":
      // Subcommand is the first non-flag positional after the program name.
      if (ctx.argv[0] !== m.argv0) return false;
      for (let i = 1; i < ctx.argv.length; i++) {
        const tok = ctx.argv[i];
        if (tok === undefined || tok.startsWith("-")) continue;
        return tok === m.subcommand;
      }
      return false;
    case "predicate":
      try {
        return m.test(ctx);
      } catch (err) {
        // Matcher predicates can be authored to be lax (they're
        // not safety-critical), but a throw here mustn't crash
        // the whole render. Treat as "doesn't match".
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`formatter ${formatter.name}: matcher threw: ${msg}`);
        return false;
      }
  }
}

/**
 * Invoke a formatter with a try/catch around `render` that
 * converts any throw into `PASS`. Callers can then treat throws
 * and deliberate declines identically. The throw is logged so
 * a developer can see in dev tools when a formatter is silently
 * falling back.
 */
export function invokeFormatter(
  formatter: Formatter,
  ctx: FormatterContext,
  lens?: "rendered" | "source",
): FormatterResult {
  try {
    return formatter.render(ctx, lens);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`formatter ${formatter.name} threw, falling back to RAW: ${msg}`);
    return PASS;
  }
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Clear the registry. Tests only. */
export function resetRegistryForTests(): void {
  REGISTRY = [];
}

/** Snapshot of currently-registered formatters. Tests only. */
export function listFormattersForTests(): readonly Formatter[] {
  return REGISTRY;
}

// Re-export the PASS sentinel so callers only need to import from
// one module.
export { PASS, isPass };
