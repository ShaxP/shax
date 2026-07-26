/**
 * Community palette-command manifest (M8.5 spec §14).
 *
 * On-disk shape at `~/.config/shax/commands/<dir>/manifest.json`.
 * The manifest is the trust contract:
 *
 *   - The host runs the `matcher` on the main thread to decide
 *     whether to surface the command in the palette. Matchers
 *     are declarative JSON (no code) so we can filter cheaply
 *     on every palette tick without waking a worker.
 *   - `shaxApiVersion` lets us reject add-ons written for an
 *     incompatible surface after we bump the panel schema.
 *   - `permissions` is reserved but currently must be `[]`.
 *     When we grow per-command context perms (cwd wildcards,
 *     block reads) it becomes real.
 *
 * Pure module — no React, no Tauri.
 */

/** Current contract version. Bumped when PanelNode / matcher
 *  shape changes in a way old add-ons can't tolerate. */
export const SHAX_COMMANDS_API_VERSION = 1;

/** Matchers a community command can declare. Restricted to
 *  simple predicates so evaluation stays on the main thread —
 *  a `predicate` shape would need a worker round-trip per
 *  filter tick, which the sandbox can't provide. */
export type CommunityCommandMatcher =
  | { readonly kind: "always" }
  | { readonly kind: "in-git-repo" }
  | { readonly kind: "cwd-prefix"; readonly prefix: string };

export interface CommunityCommandManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly shaxApiVersion: number;
  readonly matcher: CommunityCommandMatcher;
  readonly permissions?: readonly string[];
}

/** Parse + validate a manifest JSON string. Returns the
 *  validated manifest, or `null` (with a human-readable reason
 *  logged) on any failure. Caller treats `null` as "skip this
 *  add-on" — one bad add-on doesn't break the load. */
export function parseCommandManifest(name: string, json: string): CommunityCommandManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.warn(`community command "${name}": invalid manifest JSON: ${String(err)}`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    console.warn(`community command "${name}": manifest is not an object`);
    return null;
  }
  const m = parsed as Partial<CommunityCommandManifest>;
  if (typeof m.name !== "string" || m.name.length === 0) {
    console.warn(`community command "${name}": manifest missing "name"`);
    return null;
  }
  if (typeof m.version !== "string" || m.version.length === 0) {
    console.warn(`community command "${name}": manifest missing "version"`);
    return null;
  }
  if (typeof m.shaxApiVersion !== "number") {
    console.warn(`community command "${name}": manifest missing "shaxApiVersion"`);
    return null;
  }
  if (m.shaxApiVersion !== SHAX_COMMANDS_API_VERSION) {
    console.warn(
      `community command "${name}": shaxApiVersion ${m.shaxApiVersion} ` +
        `not supported (host expects ${SHAX_COMMANDS_API_VERSION})`,
    );
    return null;
  }
  if (!isMatcher(m.matcher)) {
    console.warn(`community command "${name}": invalid or missing "matcher"`);
    return null;
  }
  if (m.description !== undefined && typeof m.description !== "string") {
    console.warn(`community command "${name}": "description" must be a string`);
    return null;
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || m.permissions.length > 0) {
      // Reserved for later. Rejecting anything non-empty makes
      // the future surface additive rather than breaking.
      console.warn(
        `community command "${name}": "permissions" must be an empty array (reserved for future use)`,
      );
      return null;
    }
  }
  return {
    name: m.name,
    version: m.version,
    description: m.description,
    shaxApiVersion: m.shaxApiVersion,
    matcher: m.matcher,
    permissions: m.permissions ?? [],
  };
}

function isMatcher(value: unknown): value is CommunityCommandMatcher {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { kind?: unknown; prefix?: unknown };
  if (m.kind === "always") return true;
  if (m.kind === "in-git-repo") return true;
  if (m.kind === "cwd-prefix") {
    return typeof m.prefix === "string" && m.prefix.length > 0;
  }
  return false;
}

/** Evaluate a declarative matcher against a PaneContext. Kept
 *  as a plain function so `createSandboxed` can drop it into
 *  the trusted-side `matcher` field on the registered
 *  PaneCommand. */
export function evaluateMatcher(
  matcher: CommunityCommandMatcher,
  ctx: { readonly cwd: string | null; readonly gitRoot: string | null },
): boolean {
  switch (matcher.kind) {
    case "always":
      return true;
    case "in-git-repo":
      return ctx.gitRoot !== null;
    case "cwd-prefix":
      return ctx.cwd !== null && ctx.cwd.startsWith(matcher.prefix);
  }
}
