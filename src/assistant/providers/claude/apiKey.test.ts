import { describe, expect, it } from "vitest";
import { createClaudeApiKeyProvider } from "./apiKey";
import type { StreamEvent } from "../../provider";

interface CapturedCall {
  command: string;
  args: Record<string, unknown>;
}

/** Build an invoker that stores what it saw and pushes a
 *  fixed sequence of wire events into the caller-supplied
 *  `push` callback. Simulates Rust streaming without a real
 *  Tauri host. */
function makeInvoker(events: Array<Record<string, unknown>>): {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const invoke = (command: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ command, args });
    if (command === "claude_stream") {
      const push = args.onEvent as (event: Record<string, unknown>) => void;
      for (const e of events) push(e);
    }
    return Promise.resolve(undefined);
  };
  return { invoke, calls };
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("createClaudeApiKeyProvider", () => {
  it("declares the expected capabilities and posture", () => {
    const provider = createClaudeApiKeyProvider({ invoker: () => Promise.resolve(undefined) });
    expect(provider.id).toBe("claude");
    expect(provider.authKind).toBe("api-key");
    expect(provider.privacyPosture).toBe("cloud");
    expect(provider.capabilities.tools).toBe(true);
    expect(provider.capabilities.subagents).toBe(true);
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.imageInput).toBe(true);
  });

  it("streams text and done events end-to-end", async () => {
    const { invoke } = makeInvoker([
      { kind: "text", delta: "Hello " },
      { kind: "text", delta: "world" },
      { kind: "done", stop_reason: "end_turn" },
    ]);
    const provider = createClaudeApiKeyProvider({ invoker: invoke });
    const events = await drain(
      provider.stream({
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events).toEqual([
      { kind: "text", delta: "Hello " },
      { kind: "text", delta: "world" },
      { kind: "done", stopReason: "end_turn" },
    ]);
  });

  it("translates tool_call wire events into StreamEvent shape", async () => {
    const { invoke } = makeInvoker([
      { kind: "tool_call", id: "toolu_1", name: "run_bash", input: { cmd: "ls" } },
      { kind: "done", stop_reason: "tool_use" },
    ]);
    const provider = createClaudeApiKeyProvider({ invoker: invoke });
    const events = await drain(provider.stream({ messages: [] }));
    expect(events).toEqual([
      {
        kind: "tool_call",
        call: { id: "toolu_1", name: "run_bash", input: { cmd: "ls" } },
      },
      { kind: "done", stopReason: "tool_use" },
    ]);
  });

  it("passes user messages through as plain text to the Rust command", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createClaudeApiKeyProvider({ invoker: invoke });
    await drain(
      provider.stream({
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    const commandArgs = calls[0]?.args?.input as {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(calls[0]?.command).toBe("claude_stream");
    expect(commandArgs.messages).toHaveLength(1);
    expect(commandArgs.messages[0]?.role).toBe("user");
    expect(commandArgs.messages[0]?.content).toBe("hello");
  });

  it("collapses system messages into the top-level system field", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createClaudeApiKeyProvider({ invoker: invoke });
    await drain(
      provider.stream({
        messages: [
          { role: "system", content: "be terse" },
          { role: "system", content: "and helpful" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    const commandArgs = calls[0]?.args?.input as {
      system: string | null;
      messages: Array<{ role: string }>;
    };
    expect(commandArgs.system).toBe("be terse\n\nand helpful");
    // System messages don't appear in the messages array.
    expect(commandArgs.messages).toHaveLength(1);
    expect(commandArgs.messages[0]?.role).toBe("user");
  });

  it("packs assistant tool calls into structured content blocks", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createClaudeApiKeyProvider({ invoker: invoke });
    await drain(
      provider.stream({
        messages: [
          {
            role: "assistant",
            content: "thinking about it",
            toolCalls: [{ id: "toolu_1", name: "run", input: { x: 1 } }],
          },
        ],
      }),
    );
    const commandArgs = calls[0]?.args?.input as {
      messages: Array<{
        role: string;
        content: Array<{ type: string; text?: string; name?: string }>;
      }>;
    };
    const assistantMsg = commandArgs.messages[0];
    expect(assistantMsg?.role).toBe("assistant");
    expect(assistantMsg?.content).toEqual([
      { type: "text", text: "thinking about it" },
      { type: "tool_use", id: "toolu_1", name: "run", input: { x: 1 } },
    ]);
  });

  it("passes tool results with tool_call_id", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createClaudeApiKeyProvider({ invoker: invoke });
    await drain(
      provider.stream({
        messages: [{ role: "tool", toolCallId: "toolu_1", content: "42" }],
      }),
    );
    const commandArgs = calls[0]?.args?.input as {
      messages: Array<{ role: string; tool_call_id?: string; content: unknown }>;
    };
    expect(commandArgs.messages[0]).toEqual({
      role: "tool",
      content: "42",
      tool_call_id: "toolu_1",
    });
  });

  it("maps unknown stop_reason to end_turn", async () => {
    const { invoke } = makeInvoker([{ kind: "done", stop_reason: "unexpected_value" }]);
    const provider = createClaudeApiKeyProvider({ invoker: invoke });
    const events = await drain(provider.stream({ messages: [] }));
    expect(events).toEqual([{ kind: "done", stopReason: "end_turn" }]);
  });

  it("swallows warnings and does not emit them as StreamEvents", async () => {
    const { invoke } = makeInvoker([
      { kind: "warning", message: "sse hiccup" },
      { kind: "text", delta: "ok" },
      { kind: "done", stop_reason: "end_turn" },
    ]);
    const provider = createClaudeApiKeyProvider({ invoker: invoke });
    const events = await drain(provider.stream({ messages: [] }));
    expect(events).toEqual([
      { kind: "text", delta: "ok" },
      { kind: "done", stopReason: "end_turn" },
    ]);
  });

  it("returns an error event when running outside a Tauri host", async () => {
    // No invoker → provider detects non-Tauri context.
    const provider = createClaudeApiKeyProvider();
    const events = await drain(provider.stream({ messages: [] }));
    expect(events[0]?.kind).toBe("error");
    expect(events[1]).toEqual({ kind: "done", stopReason: "error" });
  });

  it("honours the model override", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createClaudeApiKeyProvider({
      invoker: invoke,
      model: "claude-opus-4-8",
    });
    await drain(provider.stream({ messages: [] }));
    const commandArgs = calls[0]?.args?.input as { model: string };
    expect(commandArgs.model).toBe("claude-opus-4-8");
  });

  it("honours the maxOutputTokens override", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createClaudeApiKeyProvider({ invoker: invoke });
    await drain(
      provider.stream({
        messages: [],
        maxOutputTokens: 8192,
      }),
    );
    const commandArgs = calls[0]?.args?.input as { max_tokens: number };
    expect(commandArgs.max_tokens).toBe(8192);
  });
});
