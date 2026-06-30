/**
 * Community formatter manifest schema (slice 4.6b2).
 *
 * Each add-on under `~/.config/shax/formatters/<dir>/` ships a
 * `manifest.json` describing what it formats. The manifest is
 * the *trust contract* between Shax and the add-on:
 *
 *   - The host runs the **matcher** on the main thread to decide
 *     whether to wake a worker for this block. The matcher is
 *     declarative JSON (no executable code), so we can dispatch
 *     cheaply and the add-on can't make matching decisions on
 *     arbitrary block state.
 *   - The host enforces a **shaxApiVersion** so old add-ons can
 *     be rejected when the schema breaks.
 *   - Everything else is metadata — name, version, description —
 *     surfaced in future "manage add-ons" UI.
 *
 * Pure module — no React, no Tauri.
 */

import type { Matcher } from "../types";

/** Current contract version. Bumped when SandboxNode / matcher
 *  surface changes in a way old add-ons can't tolerate. */
export const SHAX_API_VERSION = 1;

export interface CommunityManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly shaxApiVersion: number;
  readonly matcher: Matcher;
  readonly priority?: number;
}

/** Parse + validate a manifest from a JSON string. Returns the
 *  validated manifest, or `null` (with a human-readable reason
 *  logged) on any failure. The caller treats a `null` as
 *  "skip this add-on" — one bad add-on doesn't break the load. */
export function parseManifest(name: string, json: string): CommunityManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.warn(`community formatter "${name}": invalid manifest JSON: ${String(err)}`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    console.warn(`community formatter "${name}": manifest is not an object`);
    return null;
  }
  const m = parsed as Partial<CommunityManifest>;
  if (typeof m.name !== "string" || m.name.length === 0) {
    console.warn(`community formatter "${name}": manifest missing "name"`);
    return null;
  }
  if (typeof m.version !== "string" || m.version.length === 0) {
    console.warn(`community formatter "${name}": manifest missing "version"`);
    return null;
  }
  if (typeof m.shaxApiVersion !== "number") {
    console.warn(`community formatter "${name}": manifest missing "shaxApiVersion"`);
    return null;
  }
  if (m.shaxApiVersion !== SHAX_API_VERSION) {
    console.warn(
      `community formatter "${name}": shaxApiVersion ${m.shaxApiVersion} ` +
        `not supported (host expects ${SHAX_API_VERSION})`,
    );
    return null;
  }
  if (!isMatcher(m.matcher)) {
    console.warn(`community formatter "${name}": invalid or missing "matcher"`);
    return null;
  }
  if (m.priority !== undefined && typeof m.priority !== "number") {
    console.warn(`community formatter "${name}": "priority" must be a number`);
    return null;
  }
  if (m.description !== undefined && typeof m.description !== "string") {
    console.warn(`community formatter "${name}": "description" must be a string`);
    return null;
  }
  return {
    name: m.name,
    version: m.version,
    description: m.description,
    shaxApiVersion: m.shaxApiVersion,
    matcher: m.matcher,
    priority: m.priority,
  };
}

/** Matchers from add-ons are always declarative — `predicate`
 *  matchers would let the add-on inspect ctx outside the worker
 *  boundary, which we don't allow. Only `argv0` and
 *  `argv0-subcommand` are accepted. */
function isMatcher(value: unknown): value is Matcher {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { kind?: unknown; argv0?: unknown; subcommand?: unknown };
  if (m.kind === "argv0") {
    return typeof m.argv0 === "string" && m.argv0.length > 0;
  }
  if (m.kind === "argv0-subcommand") {
    return (
      typeof m.argv0 === "string" &&
      m.argv0.length > 0 &&
      typeof m.subcommand === "string" &&
      m.subcommand.length > 0
    );
  }
  return false;
}
