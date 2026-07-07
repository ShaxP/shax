import { describe, expect, it } from "vitest";
import { createOllamaProvider } from "./ollama";
import type { StreamEvent } from "../../provider";

interface CapturedCall {
  command: string;
  args: Record<string, unknown>;
}

function makeInvoker(events: Array<Record<string, unknown>>): {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const invoke = (command: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ command, args });
    if (command === "ollama_stream") {
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

describe("createOllamaProvider", () => {
  it("declares local auth + local privacy posture — the whole point of shipping Ollama", () => {
    const provider = createOllamaProvider({ invoker: () => Promise.resolve(undefined) });
    expect(provider.id).toBe("ollama");
    expect(provider.authKind).toBe("local");
    expect(provider.privacyPosture).toBe("local");
  });

  it("declares honest capabilities: streaming yes, tools/subagents/imageInput no", () => {
    const provider = createOllamaProvider({ invoker: () => Promise.resolve(undefined) });
    // These are the "requires tool-calling" hints the chat
    // surface will surface on features that need them.
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.tools).toBe(false);
    expect(provider.capabilities.subagents).toBe(false);
    expect(provider.capabilities.imageInput).toBe(false);
  });

  it("streams text and done events through ollama_stream", async () => {
    const { invoke, calls } = makeInvoker([
      { kind: "text", delta: "Hello" },
      { kind: "text", delta: " world" },
      { kind: "done", stop_reason: "end_turn" },
    ]);
    const provider = createOllamaProvider({ invoker: invoke });
    const events = await drain(
      provider.stream({
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(calls[0]?.command).toBe("ollama_stream");
    expect(events).toEqual([
      { kind: "text", delta: "Hello" },
      { kind: "text", delta: " world" },
      { kind: "done", stopReason: "end_turn" },
    ]);
  });

  it("honours the model override", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createOllamaProvider({ invoker: invoke, model: "qwen2.5:7b" });
    await drain(provider.stream({ messages: [] }));
    const commandArgs = calls[0]?.args?.input as { model: string };
    expect(commandArgs.model).toBe("qwen2.5:7b");
  });

  it("collapses system messages into the top-level system field", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createOllamaProvider({ invoker: invoke });
    await drain(
      provider.stream({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    const commandArgs = calls[0]?.args?.input as {
      system: string | null;
      messages: Array<{ role: string }>;
    };
    expect(commandArgs.system).toBe("be terse");
    expect(commandArgs.messages).toHaveLength(1);
    expect(commandArgs.messages[0]?.role).toBe("user");
  });

  it("maps max_tokens correctly from maxOutputTokens", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createOllamaProvider({ invoker: invoke });
    await drain(provider.stream({ messages: [], maxOutputTokens: 2048 }));
    const commandArgs = calls[0]?.args?.input as { max_tokens: number };
    expect(commandArgs.max_tokens).toBe(2048);
  });

  it("returns an error event when running outside a Tauri host", async () => {
    const provider = createOllamaProvider();
    const events = await drain(provider.stream({ messages: [] }));
    expect(events[0]?.kind).toBe("error");
    expect(events[1]).toEqual({ kind: "done", stopReason: "error" });
  });

  it("propagates ollama error events (e.g. 'model not found')", async () => {
    const { invoke } = makeInvoker([
      { kind: "error", message: "model llama3.1 not found, try `ollama pull llama3.1`" },
    ]);
    const provider = createOllamaProvider({ invoker: invoke });
    const events = await drain(provider.stream({ messages: [] }));
    expect(events).toEqual([
      { kind: "error", message: "model llama3.1 not found, try `ollama pull llama3.1`" },
    ]);
  });
});
