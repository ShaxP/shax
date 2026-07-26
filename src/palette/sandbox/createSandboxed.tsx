/**
 * Turn a community command spec (manifest + source) into a
 * `PaneCommand` that renders a panel driven by the sandboxed
 * Worker (M8.5 spec §14).
 *
 * The registered command's `render` returns a `panel`-kind
 * PaneCommandRender whose Panel is `SandboxedCommandPanel`. On
 * mount that panel:
 *
 *   1. Calls `invokeBuildPanel(ctx)` on the worker.
 *   2. Shows a "Loading…" state until it resolves.
 *   3. Renders `<SchemaPanel node={schema}>` on success.
 *   4. On Enter / Submit: calls `invokeBuildCommand(values)`.
 *      A returned string is passed to the host as the command
 *      to emit; `null` cancels the panel; `undefined` (worker
 *      failure) shows a "Refused: …" state.
 *
 * The matcher stays trusted (main-thread) — evaluated per
 * palette filter tick via `evaluateMatcher`. Group is forced
 * to `"Custom"` regardless of what the manifest says.
 */

import { useEffect, useState, type CSSProperties } from "react";
import type { PaneCommand, PaneContext } from "../registry";
import { evaluateMatcher, type CommunityCommandMatcher } from "./manifest";
import { SchemaPanel, type SchemaValues } from "./SchemaPanel";
import type { PanelNode } from "./schema";
import type { CommunityCommandContext } from "./types";
import { invokeBuildCommand, invokeBuildPanel } from "./workerHost";

export interface CommunityCommandSpec {
  readonly name: string;
  readonly description: string;
  readonly matcher: CommunityCommandMatcher;
  readonly source: string;
}

const STATUS_ROW: CSSProperties = {
  padding: 16,
  fontSize: 12,
  color: "var(--fg-dim)",
  textAlign: "center",
};

const ERROR_ROW: CSSProperties = {
  ...STATUS_ROW,
  color: "var(--red)",
};

/** Build a `PaneCommand` from a validated community spec. Group
 *  is always `"Custom"` (§14), source is always `"community"`. */
export function createSandboxedCommand(spec: CommunityCommandSpec): PaneCommand {
  const Panel: React.ComponentType<{
    ctx: PaneContext;
    onSubmit: (command: string | null) => void;
  }> = ({ ctx, onSubmit }) => (
    <SandboxedCommandPanel name={spec.name} source={spec.source} ctx={ctx} onSubmit={onSubmit} />
  );
  return {
    name: spec.name,
    description: spec.description,
    group: "Custom",
    source: "community",
    matcher: (ctx) => evaluateMatcher(spec.matcher, ctx),
    render: () => ({ kind: "panel", Panel }),
  };
}

interface SandboxedCommandPanelProps {
  readonly name: string;
  readonly source: string;
  readonly ctx: PaneContext;
  readonly onSubmit: (command: string | null) => void;
}

type PanelState =
  | { kind: "loading" }
  | { kind: "ready"; node: PanelNode }
  | { kind: "error"; reason: string };

/** Rendered inside the palette overlay's panel slot. Owns the
 *  worker round-trip lifecycle for this command. */
export function SandboxedCommandPanel({
  name,
  source,
  ctx,
  onSubmit,
}: SandboxedCommandPanelProps): React.ReactElement {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    const sandboxCtx: CommunityCommandContext = {
      cwd: ctx.cwd,
      branch: ctx.branch,
      gitRoot: ctx.gitRoot,
    };
    void invokeBuildPanel(name, source, sandboxCtx)
      .then((node) => {
        if (cancelled) return;
        if (node === null) {
          setState({
            kind: "error",
            reason: `Refused: sandboxed command "${name}" failed to build its panel.`,
          });
        } else {
          setState({ kind: "ready", node });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [name, source, ctx.cwd, ctx.branch, ctx.gitRoot]);

  if (state.kind === "loading") {
    return (
      <div data-testid="palette-community-loading" style={STATUS_ROW}>
        Loading community command…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div data-testid="palette-community-error" style={ERROR_ROW}>
        {state.reason}
      </div>
    );
  }

  const handleSubmit = (values: SchemaValues): void => {
    setSubmitError(null);
    void invokeBuildCommand(name, values).then((result) => {
      if (result === undefined) {
        setSubmitError(`Refused: sandboxed command "${name}" failed to build the command string.`);
        return;
      }
      onSubmit(result);
    });
  };

  return (
    <>
      <SchemaPanel node={state.node} onSubmit={handleSubmit} />
      {submitError !== null && (
        <div data-testid="palette-community-submit-error" style={ERROR_ROW}>
          {submitError}
        </div>
      )}
    </>
  );
}
