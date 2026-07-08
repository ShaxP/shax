/**
 * Assistant tool registry.
 *
 * For the M6 architectural loop-close, we ship exactly one
 * tool: `run_command`. The overlay hands this to the
 * provider whenever the provider declares `tools: true` in
 * its capabilities. When the model proposes a `run_command`
 * call, the overlay:
 *
 *   1. Renders a "proposed" bubble in the conversation.
 *   2. Dispatches `shax:emit-command` with
 *      `source: "ai"` — the App-level `SafetyGate` intercepts,
 *      shows the approval modal (spec §10 chokepoint), and
 *      re-dispatches `shax:emit-command-approved` on approve.
 *   3. Waits for the corresponding `shax:block-complete`
 *      (matched by pane + source tag), fetches the block's
 *      output, and feeds a **structured** tool result back
 *      to the model:
 *          { exit_code, duration_ms, output }
 *      Models handle structured JSON better than blob text
 *      and the exit code teaches them whether the command
 *      succeeded.
 *   4. Continues the stream for another turn — the model may
 *      propose more commands or emit a final text answer.
 *
 * Read-only tools (`read_file`, `list_directory`, etc.) are
 * intentionally deferred: the shell can do all of that via
 * `run_command`, and the fewer tools the model sees the
 * cleaner its choices.
 */

import type { Tool } from "./provider";

export const RUN_COMMAND: Tool = {
  name: "run_command",
  description:
    "Execute a shell command in the user's active terminal pane. " +
    "The user MUST approve the exact command via a modal dialog before it runs. " +
    "Returns the command's exit code, wall-clock duration in milliseconds, " +
    "and combined stdout+stderr output (truncated if very long). " +
    "Use this to inspect the system, check state, or perform actions the user asked about. " +
    "Prefer a single well-scoped command over chained pipelines when possible.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The shell command to run. Should be a single command line the user could type. " +
          "Multi-line scripts should be split into multiple tool calls.",
      },
      reason: {
        type: "string",
        description:
          "One short sentence explaining why running this command answers the user's question. " +
          "Shown to the user in the approval modal so they know what you're doing.",
      },
    },
    required: ["command", "reason"],
  },
};

/** Full toolset for the M6 architectural loop-close. */
export const DEFAULT_TOOLS: Tool[] = [RUN_COMMAND];

/** Structured tool result the overlay feeds back to the
 *  model. Serialised as JSON for the `tool` message content
 *  because Anthropic's tool_result content is a plain string. */
export interface CommandToolResult {
  exit_code: number | null;
  duration_ms: number | null;
  /** Combined stdout + stderr as text. Truncated with a
   *  trailing marker if over `MAX_OUTPUT_CHARS`. */
  output: string;
  /** True when the output was truncated to fit. */
  truncated: boolean;
}

export const MAX_OUTPUT_CHARS = 8000;

export function truncateOutput(text: string): {
  output: string;
  truncated: boolean;
} {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { output: text, truncated: false };
  }
  const head = Math.floor(MAX_OUTPUT_CHARS * 0.7);
  const tail = MAX_OUTPUT_CHARS - head - 30;
  return {
    output: `${text.slice(0, head)}\n… (${text.length - head - tail} chars truncated)\n${text.slice(-tail)}`,
    truncated: true,
  };
}
