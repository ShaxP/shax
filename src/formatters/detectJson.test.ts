import { describe, expect, it } from "vitest";
import { entryCount, isLikelyJsonCommand, kindOf, looksLikeJson, probeJson } from "./detectJson";

describe("looksLikeJson", () => {
  it("accepts strings that begin with { or [", () => {
    expect(looksLikeJson("{}")).toBe(true);
    expect(looksLikeJson("[]")).toBe(true);
    expect(looksLikeJson('{"a":1}')).toBe(true);
    expect(looksLikeJson("[1,2,3]")).toBe(true);
  });

  it("accepts leading whitespace before the structural opener", () => {
    expect(looksLikeJson("   \n {}")).toBe(true);
    expect(looksLikeJson("\t[\n]")).toBe(true);
  });

  it("rejects non-JSON-looking input", () => {
    expect(looksLikeJson("hello")).toBe(false);
    expect(looksLikeJson("42")).toBe(false); // bare primitive — we don't promote
    expect(looksLikeJson('"a string"')).toBe(false);
    expect(looksLikeJson("")).toBe(false);
    expect(looksLikeJson("   ")).toBe(false);
    expect(looksLikeJson("total 24\ndrwxr-xr-x ...")).toBe(false);
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

  it("returns null on malformed JSON", () => {
    expect(probeJson('{"name":}')).toBeNull();
    expect(probeJson("{trailing,}")).toBeNull();
    expect(probeJson('{"a"')).toBeNull();
  });

  it("returns null on input that doesn't look like JSON, without trying to parse", () => {
    expect(probeJson("hello world")).toBeNull();
    expect(probeJson("42")).toBeNull();
    expect(probeJson("")).toBeNull();
  });

  it("handles deeply nested input", () => {
    const deep = JSON.stringify({ a: { b: { c: { d: [1, 2, 3] } } } });
    expect(probeJson(deep)?.value).toEqual({ a: { b: { c: { d: [1, 2, 3] } } } });
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
