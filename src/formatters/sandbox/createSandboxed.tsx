/**
 * Factory for sandbox-backed formatters (slice 4.6b1).
 *
 * Turns a community formatter's matcher + JS source into a
 * `Formatter` that plugs into the existing registry. The
 * matcher is a regular (trusted) predicate run on the main
 * thread — cheap and lets us short-circuit obviously-irrelevant
 * blocks without ever waking a Worker. The render is the
 * sandboxed part: matched blocks pay the round-trip cost to
 * the Worker exactly once per render.
 *
 * Caller-supplied `source` is a JS string that, when executed,
 * assigns its render function to
 * `self.__shax_formatter_render`. See `workerEntry.ts` for the
 * scaffolding wrapped around it.
 */

import { useEffect, useState } from "react";
import { PASS, type Formatter, type FormatterContext, type Matcher } from "../types";
import { SandboxRender } from "./render";
import type { SandboxNode } from "./schema";
import { invokeSandboxFormatter, type SandboxInvokeContext } from "./workerHost";

export interface SandboxedFormatterDef {
  /** Identity for registry deduplication + debug. Must be unique. */
  readonly name: string;
  readonly matcher: Matcher;
  /** Same priority semantics as built-in formatters. Default 0,
   *  built-ins typically 0; community formatters at 0 share
   *  registration-order tie-breaking with built-ins. */
  readonly priority?: number;
  /** JS source string — see module header for the contract. */
  readonly source: string;
}

/** Convert a sandboxed-formatter definition into a real
 *  `Formatter` the registry can `register()`. */
export function createSandboxedFormatter(def: SandboxedFormatterDef): Formatter {
  return {
    name: def.name,
    matcher: def.matcher,
    priority: def.priority,
    render: (ctx: FormatterContext) => {
      // The render needs the worker round-trip, which is async.
      // The formatter API is synchronous; we render a host
      // component that fires the async invocation and renders
      // the resulting schema (or falls back to PASS).
      return <SandboxFormatterView name={def.name} source={def.source} ctx={ctx} />;
    },
  };
}

interface ViewProps {
  name: string;
  source: string;
  ctx: FormatterContext;
}

function SandboxFormatterView({ name, source, ctx }: ViewProps): React.ReactElement | null {
  const [node, setNode] = useState<SandboxNode | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setNode(null);
    setDone(false);
    let cancelled = false;
    const invokeCtx: SandboxInvokeContext = {
      argv: ctx.argv,
      cwd: ctx.cwd,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      exitCode: ctx.exitCode,
      durationMs: ctx.durationMs,
    };
    void invokeSandboxFormatter(name, source, invokeCtx).then((result) => {
      if (cancelled) return;
      setNode(result);
      setDone(true);
    });
    return () => {
      cancelled = true;
    };
  }, [name, source, ctx]);

  if (!done) {
    return (
      <div
        data-testid="formatter-sandbox-loading"
        style={{ padding: "4px 0", color: "var(--fg-faint)", fontSize: 12 }}
      >
        Formatting…
      </div>
    );
  }
  if (node === null) {
    // Worker declined, threw, or timed out. RAW takes over via
    // the formatter system's silent-fallback boundary, but we
    // can't return `PASS` from inside a React render — once the
    // host has decided this formatter is the match, the modal /
    // inline view has already mounted us. Rendering `null` is
    // the safest "show nothing" — the BlockRow's `showFormatted`
    // check then falls back to the raw `<pre>`.
    void PASS; // kept in scope to remind future authors that
    //         the registry-level PASS is the *matcher* path,
    //         not the post-mount one.
    return null;
  }
  return <SandboxRender node={node} />;
}
