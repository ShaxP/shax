import { describe, expect, it } from "vitest";
import { estimateNodeBytes, isPanelNode } from "./schema";

describe("isPanelNode — accepts every schema kind", () => {
  it("text-input with minimal fields", () => {
    expect(isPanelNode({ kind: "text-input", label: "L", resultKey: "k" })).toBe(true);
  });

  it("text-input with all optional fields", () => {
    expect(
      isPanelNode({
        kind: "text-input",
        label: "L",
        resultKey: "k",
        default: "hi",
        required: true,
      }),
    ).toBe(true);
  });

  it("multiline-input", () => {
    expect(isPanelNode({ kind: "multiline-input", label: "L", resultKey: "k" })).toBe(true);
  });

  it("dropdown with options", () => {
    expect(isPanelNode({ kind: "dropdown", label: "L", options: ["a", "b"], resultKey: "k" })).toBe(
      true,
    );
  });

  it("multi-select", () => {
    expect(isPanelNode({ kind: "multi-select", label: "L", options: ["a"], resultKey: "k" })).toBe(
      true,
    );
  });

  it("toggle", () => {
    expect(isPanelNode({ kind: "toggle", label: "L", resultKey: "k" })).toBe(true);
  });

  it("file-picker (file mode)", () => {
    expect(isPanelNode({ kind: "file-picker", label: "L", mode: "file", resultKey: "k" })).toBe(
      true,
    );
  });

  it("file-picker (dir mode)", () => {
    expect(isPanelNode({ kind: "file-picker", label: "L", mode: "dir", resultKey: "k" })).toBe(
      true,
    );
  });

  it("list-picker", () => {
    expect(
      isPanelNode({
        kind: "list-picker",
        label: "L",
        items: [{ label: "First", value: "1" }],
        resultKey: "k",
      }),
    ).toBe(true);
  });

  it("group with nested items", () => {
    expect(
      isPanelNode({
        kind: "group",
        legend: "Options",
        items: [
          { kind: "toggle", label: "verbose", resultKey: "v" },
          { kind: "text-input", label: "name", resultKey: "n" },
        ],
      }),
    ).toBe(true);
  });

  it("deeply nested group", () => {
    expect(
      isPanelNode({
        kind: "group",
        items: [
          {
            kind: "group",
            items: [{ kind: "toggle", label: "L", resultKey: "k" }],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("isPanelNode — rejects invalid input", () => {
  it("null / undefined / primitives", () => {
    expect(isPanelNode(null)).toBe(false);
    expect(isPanelNode(undefined)).toBe(false);
    expect(isPanelNode("string")).toBe(false);
    expect(isPanelNode(42)).toBe(false);
    expect(isPanelNode(true)).toBe(false);
  });

  it("unknown kind", () => {
    expect(isPanelNode({ kind: "iframe", label: "L", resultKey: "k" })).toBe(false);
    expect(isPanelNode({ kind: "html", label: "L", resultKey: "k" })).toBe(false);
  });

  it("missing label", () => {
    expect(isPanelNode({ kind: "text-input", resultKey: "k" })).toBe(false);
  });

  it("non-string label (event-handler smuggle attempt)", () => {
    expect(
      isPanelNode({
        kind: "text-input",
        label: { onclick: "alert(1)" },
        resultKey: "k",
      }),
    ).toBe(false);
  });

  it("missing / empty resultKey", () => {
    expect(isPanelNode({ kind: "text-input", label: "L" })).toBe(false);
    expect(isPanelNode({ kind: "text-input", label: "L", resultKey: "" })).toBe(false);
  });

  it("dropdown with empty options", () => {
    expect(isPanelNode({ kind: "dropdown", label: "L", options: [], resultKey: "k" })).toBe(false);
  });

  it("dropdown with non-string options", () => {
    expect(isPanelNode({ kind: "dropdown", label: "L", options: ["a", 42], resultKey: "k" })).toBe(
      false,
    );
  });

  it("file-picker with invalid mode", () => {
    expect(isPanelNode({ kind: "file-picker", label: "L", mode: "network", resultKey: "k" })).toBe(
      false,
    );
  });

  it("list-picker with malformed items", () => {
    expect(
      isPanelNode({
        kind: "list-picker",
        label: "L",
        items: [{ label: "x" }], // missing value
        resultKey: "k",
      }),
    ).toBe(false);
  });

  it("group with non-array items", () => {
    expect(isPanelNode({ kind: "group", items: "not-array" })).toBe(false);
  });

  it("group containing an invalid child", () => {
    expect(
      isPanelNode({
        kind: "group",
        items: [{ kind: "bogus" }],
      }),
    ).toBe(false);
  });

  it("text-input with non-boolean required", () => {
    expect(
      isPanelNode({
        kind: "text-input",
        label: "L",
        resultKey: "k",
        required: "yes",
      }),
    ).toBe(false);
  });
});

describe("estimateNodeBytes", () => {
  it("returns a small number for tiny nodes", () => {
    expect(estimateNodeBytes({ kind: "toggle", label: "x", resultKey: "k" })).toBeLessThan(500);
  });

  it("returns MAX_SAFE_INTEGER on unserialisable input (circular)", () => {
    const a: { self?: unknown } = {};
    a.self = a;
    expect(estimateNodeBytes(a)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
