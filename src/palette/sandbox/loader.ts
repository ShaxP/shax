/**
 * Disk loader for community palette commands (M8.5 spec §14).
 *
 * On app start, scans `~/.config/shax/commands/` (via the
 * backend `list_community_commands` command), parses each
 * manifest, and registers a sandboxed pane-command through
 * `createSandboxedCommand`. Matchers are decoded from the
 * manifest's declarative shape so the host never wakes a
 * Worker just to decide whether the command applies.
 *
 * Per-command parse failures are logged and skipped — one bad
 * add-on doesn't break the rest. The disk-loaded commands never
 * displace built-ins: the palette registry is idempotent by
 * name, and built-ins register first (on module import) so they
 * win by having been there first for that name — but note the
 * pane-command registry is *last-write-wins* on the underlying
 * Map, so a colliding community name would silently overwrite.
 * We reject collisions here in the loader instead.
 */

import { listCommunityCommands } from "../../lib/ipc";
import { listPaneCommands, registerPaneCommand } from "../registry";
import { createSandboxedCommand } from "./createSandboxed";
import { parseCommandManifest } from "./manifest";

/** Discover, validate, and register every community palette
 *  command on disk. Returns the names that were successfully
 *  loaded. Safe to call repeatedly ("Reload commands" panel). */
export async function loadCommunityCommands(): Promise<readonly string[]> {
  const payloads = await listCommunityCommands().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`community commands: list failed: ${msg}`);
    return [];
  });
  const loaded: string[] = [];
  for (const payload of payloads) {
    const manifest = parseCommandManifest(payload.name, payload.manifest_json);
    if (manifest === null) continue;
    if (payload.source_js.length === 0) {
      console.warn(`community command "${payload.name}": empty command.js, skipping`);
      continue;
    }
    // Block collisions with built-ins so a community command
    // can't silently shadow `git commit` or `cd to directory`.
    const collision = listPaneCommands().find(
      (c) => c.name === manifest.name && c.source !== "community",
    );
    if (collision !== undefined) {
      console.warn(
        `community command "${manifest.name}" collides with a built-in of the same name — skipping`,
      );
      continue;
    }
    registerPaneCommand(
      createSandboxedCommand({
        name: manifest.name,
        description: manifest.description ?? "",
        matcher: manifest.matcher,
        source: payload.source_js,
      }),
    );
    loaded.push(manifest.name);
  }
  if (loaded.length > 0) {
    console.info(
      `[shax community commands] loaded ${loaded.length} add-on${
        loaded.length === 1 ? "" : "s"
      }: ${loaded.join(", ")}`,
    );
  }
  return loaded;
}
