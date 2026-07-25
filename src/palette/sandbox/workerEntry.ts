/**
 * Worker-side scaffolding for sandboxed palette commands
 * (M8.5 spec §14). Concatenated with the community command's
 * source into the Worker blob.
 *
 * Two-round-trip protocol with the host:
 *
 *   host → worker: { id, phase: "buildPanel",   ctx }
 *   worker → host: { id, ok: true,  node }       // PanelNode
 *                 { id, ok: false, reason }
 *
 *   host → worker: { id, phase: "buildCommand", values }
 *   worker → host: { id, ok: true,  command }    // string | null
 *                 { id, ok: false, reason }
 *
 * Two phases (unlike formatters which had one) because the
 * user fills in the panel between calls — the worker has to
 * produce the panel schema first, then consume the filled-in
 * values later.
 *
 * The community source must register two magic globals at
 * boot:
 *
 *   self.__shax_command_build_panel   = (ctx)    => PanelNode
 *   self.__shax_command_build_command = (values) => string | null
 *
 * Kept as a string-emitting helper rather than a Worker file
 * so we can concatenate arbitrary user source at Blob-creation
 * time. Exports are pure so unit tests can exercise the
 * dispatch without spinning a real Worker.
 */

/** The fixed scaffold that wraps every community command's
 *  source inside its Worker. */
export function workerScaffoldSource(): string {
  return [
    "(function(){",
    "  self.__shax_command_build_panel = undefined;",
    "  self.__shax_command_build_command = undefined;",
    "  self.onmessage = function(event) {",
    "    var msg = event.data || {};",
    "    var id = msg.id;",
    "    var phase = msg.phase;",
    '    if (phase === "buildPanel") {',
    "      var buildPanel = self.__shax_command_build_panel;",
    '      if (typeof buildPanel !== "function") {',
    '        self.postMessage({ id: id, ok: false, reason: "no build-panel function registered" });',
    "        return;",
    "      }",
    "      try {",
    "        var node = buildPanel(msg.ctx || {});",
    "        self.postMessage({ id: id, ok: true, node: node });",
    "      } catch (e) {",
    "        var reason = (e && e.message) ? String(e.message) : String(e);",
    "        self.postMessage({ id: id, ok: false, reason: reason });",
    "      }",
    "      return;",
    "    }",
    '    if (phase === "buildCommand") {',
    "      var buildCommand = self.__shax_command_build_command;",
    '      if (typeof buildCommand !== "function") {',
    '        self.postMessage({ id: id, ok: false, reason: "no build-command function registered" });',
    "        return;",
    "      }",
    "      try {",
    "        var cmd = buildCommand(msg.values || {});",
    '        if (cmd === null || typeof cmd === "string") {',
    "          self.postMessage({ id: id, ok: true, command: cmd });",
    "        } else {",
    '          self.postMessage({ id: id, ok: false, reason: "build-command must return a string or null" });',
    "        }",
    "      } catch (e) {",
    "        var reason2 = (e && e.message) ? String(e.message) : String(e);",
    "        self.postMessage({ id: id, ok: false, reason: reason2 });",
    "      }",
    "      return;",
    "    }",
    '    self.postMessage({ id: id, ok: false, reason: "unknown phase: " + String(phase) });',
    "  };",
    "})();",
  ].join("\n");
}

/** Build a complete Worker source string from the user's
 *  command source. */
export function buildWorkerSource(userSource: string): string {
  return [workerScaffoldSource(), "// --- user command source ---", userSource].join("\n");
}
