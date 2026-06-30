/**
 * Tests for the community-formatter manifest validator. This
 * is the trust contract — anything that passes here registers a
 * sandboxed formatter, so the reject paths are as important as
 * the accept paths.
 */

import { describe, expect, it, vi } from "vitest";
import { parseManifest, SHAX_API_VERSION } from "./manifest";

const valid = {
  name: "wc",
  version: "1.0.0",
  description: "wc formatter",
  shaxApiVersion: SHAX_API_VERSION,
  matcher: { kind: "argv0", argv0: "wc" },
};

function silentWarn(): () => void {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return () => spy.mockRestore();
}

describe("parseManifest — accepts well-formed manifests", () => {
  it("with required fields only", () => {
    const m = parseManifest("wc", JSON.stringify(valid));
    expect(m).not.toBeNull();
    expect(m?.name).toBe("wc");
    expect(m?.version).toBe("1.0.0");
  });

  it("with argv0-subcommand matcher", () => {
    const m = parseManifest(
      "g",
      JSON.stringify({
        ...valid,
        matcher: { kind: "argv0-subcommand", argv0: "git", subcommand: "blame" },
      }),
    );
    expect(m?.matcher).toEqual({
      kind: "argv0-subcommand",
      argv0: "git",
      subcommand: "blame",
    });
  });

  it("preserves optional priority and description", () => {
    const m = parseManifest("x", JSON.stringify({ ...valid, priority: 5 }));
    expect(m?.priority).toBe(5);
    expect(m?.description).toBe("wc formatter");
  });
});

describe("parseManifest — rejects malformed inputs", () => {
  it("invalid JSON", () => {
    const restore = silentWarn();
    expect(parseManifest("x", "{not json")).toBeNull();
    restore();
  });

  it("non-object root", () => {
    const restore = silentWarn();
    expect(parseManifest("x", "42")).toBeNull();
    expect(parseManifest("x", "null")).toBeNull();
    expect(parseManifest("x", '"string"')).toBeNull();
    restore();
  });

  it("missing required fields", () => {
    const restore = silentWarn();
    const noName: Partial<typeof valid> = { ...valid };
    delete noName.name;
    expect(parseManifest("x", JSON.stringify(noName))).toBeNull();
    const noVersion: Partial<typeof valid> = { ...valid };
    delete noVersion.version;
    expect(parseManifest("x", JSON.stringify(noVersion))).toBeNull();
    const noApi: Partial<typeof valid> = { ...valid };
    delete noApi.shaxApiVersion;
    expect(parseManifest("x", JSON.stringify(noApi))).toBeNull();
    const noMatcher: Partial<typeof valid> = { ...valid };
    delete noMatcher.matcher;
    expect(parseManifest("x", JSON.stringify(noMatcher))).toBeNull();
    restore();
  });

  it("unsupported shaxApiVersion", () => {
    const restore = silentWarn();
    expect(parseManifest("x", JSON.stringify({ ...valid, shaxApiVersion: 0 }))).toBeNull();
    expect(parseManifest("x", JSON.stringify({ ...valid, shaxApiVersion: 999 }))).toBeNull();
    restore();
  });

  it("predicate matcher rejected (add-ons can't supply executable matchers)", () => {
    const restore = silentWarn();
    // Even if a manifest tried, predicate matchers aren't
    // expressible in JSON anyway — but the validator should
    // explicitly reject `kind: "predicate"`.
    expect(
      parseManifest("x", JSON.stringify({ ...valid, matcher: { kind: "predicate" } })),
    ).toBeNull();
    restore();
  });

  it("malformed argv0 matcher", () => {
    const restore = silentWarn();
    expect(
      parseManifest("x", JSON.stringify({ ...valid, matcher: { kind: "argv0", argv0: 42 } })),
    ).toBeNull();
    expect(
      parseManifest("x", JSON.stringify({ ...valid, matcher: { kind: "argv0", argv0: "" } })),
    ).toBeNull();
    restore();
  });

  it("malformed argv0-subcommand matcher", () => {
    const restore = silentWarn();
    expect(
      parseManifest(
        "x",
        JSON.stringify({
          ...valid,
          matcher: { kind: "argv0-subcommand", argv0: "git" /* no subcommand */ },
        }),
      ),
    ).toBeNull();
    restore();
  });

  it("non-numeric priority", () => {
    const restore = silentWarn();
    expect(parseManifest("x", JSON.stringify({ ...valid, priority: "high" }))).toBeNull();
    restore();
  });
});
