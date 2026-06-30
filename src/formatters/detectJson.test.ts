import { describe, expect, it } from "vitest";
import { entryCount, isLikelyJsonCommand, kindOf, looksLikeJson, probeJson } from "./detectJson";

describe("looksLikeJson", () => {
  it("accepts structural openers", () => {
    expect(looksLikeJson("{}")).toBe(true);
    expect(looksLikeJson("[]")).toBe(true);
    expect(looksLikeJson('{"a":1}')).toBe(true);
    expect(looksLikeJson("[1,2,3]")).toBe(true);
  });

  it("accepts bare-primitive openers (jq emits these)", () => {
    expect(looksLikeJson("42")).toBe(true);
    expect(looksLikeJson("-3.14")).toBe(true);
    expect(looksLikeJson('"a string"')).toBe(true);
    expect(looksLikeJson("true")).toBe(true);
    expect(looksLikeJson("false")).toBe(true);
    expect(looksLikeJson("null")).toBe(true);
  });

  it("accepts leading whitespace before the opener", () => {
    expect(looksLikeJson("   \n {}")).toBe(true);
    expect(looksLikeJson("\t[\n]")).toBe(true);
    expect(looksLikeJson("  42")).toBe(true);
  });

  it("rejects clearly non-JSON input", () => {
    expect(looksLikeJson("hello")).toBe(false);
    expect(looksLikeJson("")).toBe(false);
    expect(looksLikeJson("   ")).toBe(false);
    expect(looksLikeJson("total 24\ndrwxr-xr-x ...")).toBe(false);
    expect(looksLikeJson("error: not found")).toBe(false);
  });
});

describe("probeJson", () => {
  it("parses a simple object", () => {
    const p = probeJson('{"name":"Ada","age":36}');
    expect(p).not.toBeNull();
    expect(p?.value).toEqual({ name: "Ada", age: 36 });
  });

  it("parses a nested array of objects", () => {
    const p = probeJson('[{"id":1},{"id":2}]');
    expect(p?.value).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("parses bare primitives (jq '.foo' emits these)", () => {
    expect(probeJson("42")?.value).toBe(42);
    expect(probeJson("-3.14")?.value).toBe(-3.14);
    expect(probeJson('"hello"')?.value).toBe("hello");
    expect(probeJson("true")?.value).toBe(true);
    expect(probeJson("false")?.value).toBe(false);
    expect(probeJson("null")?.value).toBeNull();
  });

  it("parses JSON Lines streams as a synthetic array (jq '.[]' emits these)", () => {
    const p = probeJson("1\n2\n3");
    expect(p?.value).toEqual([1, 2, 3]);
  });

  it("parses heterogeneous JSON Lines", () => {
    const p = probeJson('{"a":1}\n{"b":2}\n{"c":3}');
    expect(p?.value).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("a single-line bare primitive stays single, not lines-wrapped", () => {
    // `42` should parse as the number 42, not the array [42].
    expect(probeJson("42")?.value).toBe(42);
  });

  it("returns null on malformed JSON", () => {
    expect(probeJson('{"name":}')).toBeNull();
    expect(probeJson("{trailing,}")).toBeNull();
    expect(probeJson('{"a"')).toBeNull();
  });

  it("returns null on clearly non-JSON input", () => {
    expect(probeJson("hello world")).toBeNull();
    expect(probeJson("")).toBeNull();
    expect(probeJson("   ")).toBeNull();
  });

  it("returns null when JSON Lines fails partway on non-shell-noise content", () => {
    // `1\n2\nnot json\n4` isn't a clean JSON Lines stream and
    // its trailing content (after the leading `1`) isn't
    // recognisable shell noise (no `%` indicator) — so the
    // leading-extract route also declines, preventing
    // mis-classification of mixed text.
    expect(probeJson("1\n2\nnot json\n4")).toBeNull();
  });

  it("handles trailing whitespace + newlines", () => {
    expect(probeJson('{"a":1}\n\n  ')?.value).toEqual({ a: 1 });
  });

  it("handles deeply nested input", () => {
    const deep = JSON.stringify({ a: { b: { c: { d: [1, 2, 3] } } } });
    expect(probeJson(deep)?.value).toEqual({ a: { b: { c: { d: [1, 2, 3] } } } });
  });

  it("tolerates zsh's missing-newline indicator after a structural value", () => {
    // What jq's output looks like in a PTY after ANSI strip when
    // zsh's PROMPT_SP fires: the literal `%` plus padding and
    // carriage returns, all *after* the JSON.
    const captured =
      '{"a":"b"}\r\n%                                                                                     \r \r';
    expect(probeJson(captured)?.value).toEqual({ a: "b" });
  });

  it("tolerates trailing noise after a primitive", () => {
    expect(probeJson("42\n%   \r")?.value).toBe(42);
    expect(probeJson('"hi"\n%   \r')?.value).toBe("hi");
    expect(probeJson("null\n%   \r")?.value).toBeNull();
  });

  it("doesn't get confused by `}` inside a string", () => {
    // A naive bracket-counter would close at the `}` inside the
    // string. extractLeadingJson tracks string state, so this
    // parses as the whole object.
    expect(probeJson('{"x":"}"}')?.value).toEqual({ x: "}" });
  });

  it("doesn't get confused by escaped quotes inside a string", () => {
    expect(probeJson('{"x":"\\"hi\\""}')?.value).toEqual({ x: '"hi"' });
  });

  it("rejects bare-primitive followed by non-noise content", () => {
    // `wc README.md` output — leading number followed by more
    // numbers + filename. The leading-extract path must not
    // claim this as the bare number `6` (which would steal the
    // match away from the sandboxed `wc` formatter).
    expect(probeJson("       6      18     105 README.md\n")).toBeNull();
    // `wc -l` form too.
    expect(probeJson("       6 README.md\n")).toBeNull();
    // Two numbers separated by space — also not JSON.
    expect(probeJson("42 17\n")).toBeNull();
  });

  it("still tolerates trailing zsh noise after a bare primitive", () => {
    // The original motivation for extractLeadingJson — these
    // must still match.
    expect(probeJson("42\n%   \r")?.value).toBe(42);
    expect(probeJson("null\n%\r")?.value).toBeNull();
  });
});

describe("isLikelyJsonCommand", () => {
  it("flags jq", () => {
    expect(isLikelyJsonCommand(["jq", "."])).toBe(true);
    expect(isLikelyJsonCommand(["jq"])).toBe(true);
  });

  it("doesn't flag unrelated commands", () => {
    expect(isLikelyJsonCommand(["cat", "x.json"])).toBe(false);
    expect(isLikelyJsonCommand(["curl", "https://api/x"])).toBe(false);
    expect(isLikelyJsonCommand([])).toBe(false);
  });
});

describe("kindOf", () => {
  it("tags primitives and containers", () => {
    expect(kindOf(null)).toBe("null");
    expect(kindOf("x")).toBe("string");
    expect(kindOf(0)).toBe("number");
    expect(kindOf(false)).toBe("boolean");
    expect(kindOf({})).toBe("object");
    expect(kindOf([])).toBe("array");
  });
});

describe("entryCount", () => {
  it("counts object keys and array items", () => {
    expect(entryCount({ a: 1, b: 2, c: 3 })).toBe(3);
    expect(entryCount([1, 2, 3, 4])).toBe(4);
    expect(entryCount({})).toBe(0);
    expect(entryCount([])).toBe(0);
  });

  it("returns 0 for primitives", () => {
    expect(entryCount("string")).toBe(0);
    expect(entryCount(42)).toBe(0);
    expect(entryCount(null)).toBe(0);
    expect(entryCount(true)).toBe(0);
  });
});
