import { describe, expect, it } from "vitest";
import { createClaudeSubscriptionProvider } from "./subscription";
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
    if (command === "claude_cli_stream") {
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

describe("createClaudeSubscriptionProvider", () => {
  it("declares subscription-delegate auth and honest text-only capabilities", () => {
    const provider = createClaudeSubscriptionProvider({
      invoker: () => Promise.resolve(undefined),
    });
    expect(provider.id).toBe("claude");
    expect(provider.authKind).toBe("subscription-delegate");
    expect(provider.privacyPosture).toBe("cloud");
    // Streaming works today; tools + subagents are declared
    // false for the MVP subscription lane — the CLI's own
    // tool-call proposal path isn't threaded through the
    // safety gate yet.
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.tools).toBe(false);
    expect(provider.capabilities.subagents).toBe(false);
    expect(provider.capabilities.imageInput).toBe(false);
  });

  it("streams text and done events end-to-end via claude_cli_stream", async () => {
    const { invoke, calls } = makeInvoker([
      { kind: "text", delta: "Hello" },
      { kind: "done", stop_reason: "end_turn" },
    ]);
    const provider = createClaudeSubscriptionProvider({ invoker: invoke });
    const events = await drain(
      provider.stream({
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(calls[0]?.command).toBe("claude_cli_stream");
    expect(events).toEqual([
      { kind: "text", delta: "Hello" },
      { kind: "done", stopReason: "end_turn" },
    ]);
  });

  it("collapses system messages into the top-level system field like the API key lane", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createClaudeSubscriptionProvider({ invoker: invoke });
    await drain(
      provider.stream({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    const commandArgs = calls[0]?.args?.input as { system: string | null };
    expect(commandArgs.system).toBe("be terse");
  });

  it("honours the model override", async () => {
    const { invoke, calls } = makeInvoker([{ kind: "done", stop_reason: "end_turn" }]);
    const provider = createClaudeSubscriptionProvider({
      invoker: invoke,
      model: "claude-opus-4-8",
    });
    await drain(provider.stream({ messages: [] }));
    const commandArgs = calls[0]?.args?.input as { model: string };
    expect(commandArgs.model).toBe("claude-opus-4-8");
  });

  it("returns an error event when running outside a Tauri host", async () => {
    const provider = createClaudeSubscriptionProvider();
    const events = await drain(provider.stream({ messages: [] }));
    expect(events[0]?.kind).toBe("error");
    expect(events[1]).toEqual({ kind: "done", stopReason: "error" });
  });

  it("emits an error event when the CLI stream itself surfaces an error", async () => {
    // Rust emits both `error` and `done` for a failed run;
    // the provider terminates on the error and doesn't emit
    // the trailing done — the error event itself is the
    // final signal.
    const { invoke } = makeInvoker([
      { kind: "error", message: "claude CLI exited with status 1" },
      { kind: "done", stop_reason: "error" },
    ]);
    const provider = createClaudeSubscriptionProvider({ invoker: invoke });
    const events = await drain(provider.stream({ messages: [] }));
    expect(events).toEqual([{ kind: "error", message: "claude CLI exited with status 1" }]);
  });
});
