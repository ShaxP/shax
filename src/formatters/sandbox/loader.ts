/**
 * Disk loader for community formatters (slice 4.6b2).
 *
 * On app start, scans `~/.config/shax/formatters/` (via the
 * backend `list_community_formatters` command), parses each
 * manifest, registers a sandboxed formatter via the existing
 * factory. The matcher is decoded from the manifest's
 * declarative shape so the host doesn't need to wake a Worker
 * to decide whether the add-on applies — only when it does,
 * the source string runs in its sandbox.
 *
 * One bad add-on doesn't break the rest: per-formatter parse
 * failures are logged and skipped. The disk-loaded formatters
 * never displace built-in ones with the same name (registry
 * is name-idempotent), so a malicious add-on cannot shadow
 * `git diff` or `ls`.
 */

import { listCommunityFormatters } from "../../lib/ipc";
import { register } from "../registry";
import { createSandboxedFormatter } from "./createSandboxed";
import { parseManifest } from "./manifest";

/** Discover, validate, and register every community formatter
 *  on disk. Returns the names that were successfully loaded.
 *  Idempotent — calling twice is a no-op because the registry
 *  skips duplicates by name. */
export async function loadCommunityFormatters(): Promise<readonly string[]> {
  const payloads = await listCommunityFormatters().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`community formatters: list failed: ${msg}`);
    return [];
  });
  const loaded: string[] = [];
  for (const payload of payloads) {
    const manifest = parseManifest(payload.name, payload.manifest_json);
    if (manifest === null) continue;
    if (payload.source_js.length === 0) {
      console.warn(`community formatter "${payload.name}": empty formatter.js, skipping`);
      continue;
    }
    register(
      createSandboxedFormatter({
        name: manifest.name,
        matcher: manifest.matcher,
        priority: manifest.priority,
        source: payload.source_js,
      }),
    );
    loaded.push(manifest.name);
  }
  if (loaded.length > 0) {
    console.info(
      `[shax community] loaded ${loaded.length} add-on${
        loaded.length === 1 ? "" : "s"
      }: ${loaded.join(", ")}`,
    );
  }
  return loaded;
}
