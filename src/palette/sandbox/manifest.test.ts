import { describe, expect, it, vi } from "vitest";
import {
  evaluateMatcher,
  parseCommandManifest,
  SHAX_COMMANDS_API_VERSION,
  type CommunityCommandMatcher,
} from "./manifest";

const VALID = {
  name: "mkdir",
  version: "1.0.0",
  shaxApiVersion: SHAX_COMMANDS_API_VERSION,
  matcher: { kind: "always" },
};

function stringify(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("parseCommandManifest — accepts", () => {
  it("a minimal valid manifest", () => {
    const parsed = parseCommandManifest("mkdir", stringify(VALID));
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("mkdir");
    expect(parsed?.matcher).toEqual({ kind: "always" });
  });

  it("in-git-repo matcher", () => {
    const parsed = parseCommandManifest(
      "x",
      stringify({ ...VALID, matcher: { kind: "in-git-repo" } }),
    );
    expect(parsed?.matcher).toEqual({ kind: "in-git-repo" });
  });

  it("cwd-prefix matcher with prefix", () => {
    const parsed = parseCommandManifest(
      "x",
      stringify({ ...VALID, matcher: { kind: "cwd-prefix", prefix: "/tmp" } }),
    );
    expect(parsed?.matcher).toEqual({ kind: "cwd-prefix", prefix: "/tmp" });
  });

  it("optional description + empty permissions", () => {
    const parsed = parseCommandManifest(
      "x",
      stringify({ ...VALID, description: "A helper", permissions: [] }),
    );
    expect(parsed?.description).toBe("A helper");
    expect(parsed?.permissions).toEqual([]);
  });
});

describe("parseCommandManifest — rejects", () => {
  it("invalid JSON", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCommandManifest("x", "not { json")).toBeNull();
    spy.mockRestore();
  });

  it("non-object payload", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCommandManifest("x", stringify("string"))).toBeNull();
    expect(parseCommandManifest("x", stringify(null))).toBeNull();
    spy.mockRestore();
  });

  it("missing name", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { name: _n, ...rest } = VALID;
    void _n;
    expect(parseCommandManifest("x", stringify(rest))).toBeNull();
    spy.mockRestore();
  });

  it("empty name", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCommandManifest("x", stringify({ ...VALID, name: "" }))).toBeNull();
    spy.mockRestore();
  });

  it("wrong shaxApiVersion", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCommandManifest("x", stringify({ ...VALID, shaxApiVersion: 99 }))).toBeNull();
    spy.mockRestore();
  });

  it("unknown matcher.kind", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      parseCommandManifest("x", stringify({ ...VALID, matcher: { kind: "predicate" } })),
    ).toBeNull();
    spy.mockRestore();
  });

  it("cwd-prefix without prefix", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      parseCommandManifest("x", stringify({ ...VALID, matcher: { kind: "cwd-prefix" } })),
    ).toBeNull();
    spy.mockRestore();
  });

  it("non-empty permissions (reserved)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCommandManifest("x", stringify({ ...VALID, permissions: ["fs.read"] }))).toBeNull();
    spy.mockRestore();
  });

  it("non-string description", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCommandManifest("x", stringify({ ...VALID, description: 42 }))).toBeNull();
    spy.mockRestore();
  });
});

describe("evaluateMatcher", () => {
  const ctx = (cwd: string | null, gitRoot: string | null) => ({ cwd, gitRoot });

  it("always → true everywhere", () => {
    expect(evaluateMatcher({ kind: "always" }, ctx(null, null))).toBe(true);
    expect(evaluateMatcher({ kind: "always" }, ctx("/x", "/x"))).toBe(true);
  });

  it("in-git-repo → true when gitRoot is set", () => {
    expect(evaluateMatcher({ kind: "in-git-repo" }, ctx("/x", null))).toBe(false);
    expect(evaluateMatcher({ kind: "in-git-repo" }, ctx("/x", "/x"))).toBe(true);
  });

  it("cwd-prefix → true when cwd starts with prefix", () => {
    const m: CommunityCommandMatcher = { kind: "cwd-prefix", prefix: "/tmp" };
    expect(evaluateMatcher(m, ctx(null, null))).toBe(false);
    expect(evaluateMatcher(m, ctx("/home", null))).toBe(false);
    expect(evaluateMatcher(m, ctx("/tmp/x", null))).toBe(true);
  });
});
