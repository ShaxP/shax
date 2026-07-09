import { describe, expect, it } from "vitest";
import { DEFAULT_TOOLS, MAX_OUTPUT_CHARS, RUN_COMMAND, truncateOutput } from "./tools";

describe("run_command tool schema", () => {
  it("declares command and reason as required parameters", () => {
    expect(RUN_COMMAND.name).toBe("run_command");
    expect(RUN_COMMAND.input_schema.required).toEqual(["command", "reason"]);
  });

  it("is included in the default toolset", () => {
    expect(DEFAULT_TOOLS).toContainEqual(RUN_COMMAND);
  });
});

describe("truncateOutput", () => {
  it("passes short output through unchanged", () => {
    const { output, truncated } = truncateOutput("hello");
    expect(output).toBe("hello");
    expect(truncated).toBe(false);
  });

  it("passes exactly-max-length output through unchanged", () => {
    const text = "a".repeat(MAX_OUTPUT_CHARS);
    const { output, truncated } = truncateOutput(text);
    expect(output).toBe(text);
    expect(truncated).toBe(false);
  });

  it("head+tail truncates long output with a marker", () => {
    const text = "a".repeat(20000);
    const { output, truncated } = truncateOutput(text);
    expect(truncated).toBe(true);
    expect(output.length).toBeLessThan(text.length);
    expect(output).toContain("chars truncated");
    // The head is at the front, the tail at the back.
    expect(output.startsWith("a")).toBe(true);
    expect(output.endsWith("a")).toBe(true);
  });

  it("preserves distinct head + tail so the model sees both", () => {
    const head = "HEAD_MARKER" + "a".repeat(10000);
    const tail = "b".repeat(10000) + "TAIL_MARKER";
    const combined = head + tail;
    const { output, truncated } = truncateOutput(combined);
    expect(truncated).toBe(true);
    expect(output).toContain("HEAD_MARKER");
    expect(output).toContain("TAIL_MARKER");
  });
});
