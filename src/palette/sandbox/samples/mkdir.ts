/**
 * Sample community command — `mkdir` (M8.5 spec §14).
 *
 * Ships in-repo so the sandbox pipeline is exercised even
 * without any disk add-ons. Small enough to read at a glance;
 * exercises `text-input` + `toggle` schema nodes and a
 * buildCommand that composes a real shell command with
 * shell-escaping.
 *
 * Structure mirrors `src/formatters/sandbox/samples/wc.ts`:
 * a single file that hand-writes the community JS as a
 * template literal (no build step), then wraps it with
 * `createSandboxedCommand`.
 */

import { createSandboxedCommand } from "../createSandboxed";

const MKDIR_SOURCE = String.raw`
// Community-command sample: mkdir.
// Runs in a Worker with no filesystem / network access — the only
// path to doing anything is the string returned from
// __shax_command_build_command.

self.__shax_command_build_panel = function(_ctx) {
  return {
    kind: "group",
    legend: "Create a directory",
    items: [
      {
        kind: "text-input",
        label: "Path",
        resultKey: "path",
        required: true,
      },
      {
        kind: "toggle",
        label: "-p (create intermediate directories, ignore if exists)",
        resultKey: "parents",
        default: true,
      },
    ],
  };
};

// Simple POSIX-safe shell-escape. Mirrors the host's
// src/lib/shellEscape.ts logic so we don't need to invoke
// anything outside the worker.
function shellEscape(s) {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\\\''") + "'";
}

self.__shax_command_build_command = function(values) {
  var path = (values && typeof values.path === "string") ? values.path.trim() : "";
  if (path.length === 0) return null;
  var parts = ["mkdir"];
  if (values && values.parents === true) parts.push("-p");
  parts.push(shellEscape(path));
  return parts.join(" ");
};
`;

export const mkdirSandboxCommand = createSandboxedCommand({
  name: "mkdir (sample)",
  description: "Create a directory — sandboxed community-command sample.",
  matcher: { kind: "always" },
  source: MKDIR_SOURCE,
});
