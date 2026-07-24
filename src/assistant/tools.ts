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
    "Execute a shell command in the user's active terminal pane that has side effects — " +
    "writes, deletes, moves, `git add`/`checkout`/`push`, package installs, `cd`, or anything " +
    "that mutates state. The user sees an APPROVAL REQUIRED card in the assistant with Approve / " +
    "Decline buttons and MUST approve before it runs. Returns the command's exit code, " +
    "wall-clock duration in milliseconds, and combined stdout+stderr output (truncated if " +
    "very long). Prefer a single well-scoped command over chained pipelines when possible. " +
    "For read-only probes (`ls`, `git status`, `git diff`, `pwd`, …), use `probe` instead — " +
    "it renders a lighter SUGGESTED — READ ONLY card with a single Run button.",
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
          "Shown to the user on the approval card so they know what you're doing.",
      },
    },
    required: ["command", "reason"],
  },
};

/** Read-only probe tool (M7.7e). The user still sees the command
 *  visibly and clicks Run — the single-click confirmation IS the
 *  approval for pure reads per spec §10. If the model calls this
 *  with a destructive command, the safety gate refuses and returns
 *  a structured error so the model can retry with `run_command`. */
export const PROBE_COMMAND: Tool = {
  name: "probe",
  description:
    "Run a read-only shell probe to inspect the user's system. Use for pure reads: `ls`, " +
    "`pwd`, `cat`, `git status`, `git diff`, `git log`, `env`, `ps`, `df`, `du`, `stat`, `wc`, " +
    "`head`, `tail`, `grep`, `find` (without `-delete`), and similar. NO side effects — no " +
    "writes, no deletes, no network mutations, no `cd`. The user sees a SUGGESTED — READ ONLY " +
    "card with a single Run button and no approval modal. If the command would modify state in " +
    "ANY way, use `run_command` instead. If you probe with a destructive command by accident, " +
    "the tool returns a `Refused:` error and you should retry with `run_command`.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The read-only shell command. Single line, no side effects. " +
          "Anything that mutates state belongs in `run_command`.",
      },
      reason: {
        type: "string",
        description:
          "One short sentence explaining what you're checking and why. " +
          "Shown on the SUGGESTED card so the user knows why to click Run.",
      },
    },
    required: ["command", "reason"],
  },
};

/** Full toolset for the M6 architectural loop-close, extended
 *  with the M7.7e read-only probe. */
export const DEFAULT_TOOLS: Tool[] = [RUN_COMMAND, PROBE_COMMAND];

/**
 * System prompt prepended to the conversation whenever tools
 * are enabled. Without this, models see the `run_command`
 * schema but often default to hedging responses like
 * "here's how you can do it yourself: run pwd" — the schema
 * doesn't tell the model *when* to use it.
 *
 * The prompt positions the assistant as the terminal
 * assistant and makes the tool the default answer path for
 * factual queries about the user's system.
 */
export const SYSTEM_PROMPT_WITH_TOOLS = `You are the AI assistant embedded in Shax, a terminal emulator. The user is at a shell prompt.

Respond in the same language the user writes in. If the user's language is unclear, default to English. Do not switch languages mid-conversation.

You have two tools for executing shell commands in the user's active terminal pane:

- \`probe\` — read-only probes (\`ls\`, \`pwd\`, \`cat\`, \`git status\`, \`git diff\`, \`git log\`, \`env\`, \`ps\`, \`grep\`, \`find\` without \`-delete\`, etc.). The user sees a lightweight SUGGESTED — READ ONLY card with a single Run button. Prefer this for factual queries about the user's system.
- \`run_command\` — anything that mutates state (writes, deletes, moves, \`git add\`/\`checkout\`/\`push\`, package installs, \`cd\`, network mutations). The user sees an APPROVAL REQUIRED card with Approve / Decline buttons and must explicitly approve.

Prefer tool use over asking the user to run commands themselves. When the user asks about their system, use the appropriate tool to find out, then answer with the result. In the \`reason\` argument, briefly explain what you're checking and why.

Choose \`probe\` whenever the command is a pure read — if unsure, prefer \`probe\` when the command's only effect is stdout; prefer \`run_command\` if it could change any file, ref, or process. If you accidentally probe a destructive command, the tool will refuse; retry with \`run_command\`.

Do not propose destructive commands (\`rm -rf\` on important paths, force push, history rewrites) unless the user explicitly asked for them.`;

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
