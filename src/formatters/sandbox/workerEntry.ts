/**
 * Worker-side scaffolding for sandboxed formatters
 * (slice 4.6b1). Concatenated with the community formatter's
 * source code into the Worker blob.
 *
 * Protocol with the host (one message in, one message out):
 *
 *   host → worker: { id, ctx }
 *   worker → host: { id, ok: true, node }
 *                  { id, ok: false, reason }
 *
 * The worker entry expects the community formatter to register
 * a render function on a magic global:
 *
 *   self.__shax_formatter_render = (ctx) => SandboxNode;
 *
 * The host injects the formatter source so this assignment runs
 * once at Worker boot; subsequent host messages invoke the
 * registered function per block.
 *
 * Kept as a string-emitting helper rather than a Worker file
 * because we need to concatenate with arbitrary user source
 * at Blob-creation time. The function is exported pure so the
 * worker-host tests can exercise the dispatch logic without
 * spinning a real Worker.
 */

/** The fixed scaffolding string that wraps every community
 *  formatter inside its Worker. Returns it as a string so the
 *  caller can `new Blob([scaffold, "\n", userSource])`. */
export function workerScaffoldSource(): string {
  // Single-quote-free so we can safely embed in a template
  // literal at the call site without escape headaches.
  return [
    "(function(){",
    "  self.__shax_formatter_render = undefined;",
    "  self.onmessage = function(event) {",
    "    var msg = event.data || {};",
    "    var id = msg.id;",
    "    var ctx = msg.ctx;",
    "    var fn = self.__shax_formatter_render;",
    '    if (typeof fn !== "function") {',
    '      self.postMessage({ id: id, ok: false, reason: "no render function registered" });',
    "      return;",
    "    }",
    "    try {",
    "      var result = fn(ctx);",
    "      self.postMessage({ id: id, ok: true, node: result });",
    "    } catch (e) {",
    "      var reason = (e && e.message) ? String(e.message) : String(e);",
    "      self.postMessage({ id: id, ok: false, reason: reason });",
    "    }",
    "  };",
    "})();",
  ].join("\n");
}

/**
 * Build a complete Worker source string from the user's render
 * source. The result is a self-contained JS module that, when
 * loaded as a Worker, accepts host messages and invokes the
 * user's render function for each.
 *
 * The user source is responsible for assigning the render fn
 * to `self.__shax_formatter_render`. The host receives a
 * structured failure rather than a crash if the assignment is
 * missing or the function throws (see `workerScaffoldSource`).
 */
export function buildWorkerSource(userSource: string): string {
  return [workerScaffoldSource(), "// --- user formatter source ---", userSource].join("\n");
}
