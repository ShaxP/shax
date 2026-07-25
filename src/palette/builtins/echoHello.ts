/**
 * Stub built-in for the M8.1 palette framework.
 *
 * Registers a single "Echo hello" command that emits a fixed
 * shell command. Serves two purposes:
 *
 *  1. Exit-criterion smoke for M8.1 — proves the end-to-end
 *     pipeline (open palette → filter → select → preview →
 *     submit → shell) works without any of the M8.2+ built-ins.
 *  2. Debug entry that stays useful across all M8 slices as a
 *     "does the palette route reach the shell" heartbeat. Sits
 *     in the "Debug" group so it's easy to filter out.
 *
 * Delete or de-register once the real M8.2 built-in (`cd to
 * directory`) lands and provides a better smoke.
 */

import { registerPaneCommand } from "../registry";

registerPaneCommand({
  name: "Echo hello",
  description: "Emit a harmless shell command — proof of the palette pipeline.",
  group: "Debug",
  matcher: () => true,
  render: () => ({ kind: "preview", command: "echo hello from shax palette" }),
});
