/**
 * Tests for the formatter registry (slice 4.3). Validates the
 * three core contracts: matcher correctness, silent fallback on
 * throw, and the priority / registration-order resolver.
 *
 * Each test resets the registry to a clean state so built-ins
 * don't bleed in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findFormatter, invokeFormatter, register, resetRegistryForTests } from "./registry";
import { PASS, type FormatterContext } from "./types";

const BASE_CTX: FormatterContext = {
  argv: ["cat", "README.md"],
  cwd: "/tmp",
  env: {},
  exitCode: 0,
  durationMs: 5,
  stdout: "# hi",
  stderr: "",
  rawAnsi: "# hi",
  paneId: "pty-1",
};

beforeEach(() => {
  resetRegistryForTests();
});

afterEach(() => {
  resetRegistryForTests();
});

describe("matcher: argv0", () => {
  it("matches when argv[0] is the same", () => {
    register({
      name: "cat",
      matcher: { kind: "argv0", argv0: "cat" },
      render: () => "match",
    });
    expect(findFormatter(BASE_CTX)?.name).toBe("cat");
  });

  it("doesn't match a different argv[0]", () => {
    register({
      name: "ls",
      matcher: { kind: "argv0", argv0: "ls" },
      render: () => "match",
    });
    expect(findFormatter(BASE_CTX)).toBeNull();
  });
});

describe("matcher: argv0 + subcommand", () => {
  const ctx = (...argv: string[]): FormatterContext => ({ ...BASE_CTX, argv });

  it("matches when both argv[0] and subcommand line up", () => {
    register({
      name: "git-status",
      matcher: { kind: "argv0-subcommand", argv0: "git", subcommand: "status" },
      render: () => "match",
    });
    expect(findFormatter(ctx("git", "status"))?.name).toBe("git-status");
  });

  it("skips flag tokens to find the subcommand", () => {
    register({
      name: "git-status",
      matcher: { kind: "argv0-subcommand", argv0: "git", subcommand: "status" },
      render: () => "match",
    });
    expect(findFormatter(ctx("git", "--no-pager", "status"))?.name).toBe("git-status");
  });

  it("doesn't match when the subcommand differs", () => {
    register({
      name: "git-status",
      matcher: { kind: "argv0-subcommand", argv0: "git", subcommand: "status" },
      render: () => "match",
    });
    expect(findFormatter(ctx("git", "diff"))).toBeNull();
  });
});

describe("matcher: predicate", () => {
  it("matches when the predicate returns true", () => {
    register({
      name: "yes-everything",
      matcher: { kind: "predicate", test: () => true },
      render: () => "match",
    });
    expect(findFormatter(BASE_CTX)?.name).toBe("yes-everything");
  });

  it("treats a throwing predicate as 'no match'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    register({
      name: "boom",
      matcher: {
        kind: "predicate",
        test: () => {
          throw new Error("predicate broken");
        },
      },
      render: () => "match",
    });
    expect(findFormatter(BASE_CTX)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("priority + registration order", () => {
  it("higher priority wins over registration order", () => {
    register({
      name: "first",
      matcher: { kind: "argv0", argv0: "cat" },
      render: () => "first",
    });
    register({
      name: "second-high",
      matcher: { kind: "argv0", argv0: "cat" },
      priority: 10,
      render: () => "second-high",
    });
    expect(findFormatter(BASE_CTX)?.name).toBe("second-high");
  });

  it("registration order wins on a priority tie", () => {
    register({
      name: "first",
      matcher: { kind: "argv0", argv0: "cat" },
      render: () => "first",
    });
    register({
      name: "second",
      matcher: { kind: "argv0", argv0: "cat" },
      render: () => "second",
    });
    expect(findFormatter(BASE_CTX)?.name).toBe("first");
  });
});

describe("invokeFormatter silent fallback", () => {
  it("returns PASS when the render throws, and logs the failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const formatter = {
      name: "boom",
      matcher: { kind: "argv0" as const, argv0: "cat" },
      render: () => {
        throw new Error("render broken");
      },
    };
    expect(invokeFormatter(formatter, BASE_CTX)).toBe(PASS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns the value verbatim when the render succeeds", () => {
    const formatter = {
      name: "fine",
      matcher: { kind: "argv0" as const, argv0: "cat" },
      render: () => "rendered",
    };
    expect(invokoke(formatter)).toBe("rendered");
  });
});

// Tiny helper to avoid typing the BASE_CTX on every call in the
// "returns the value verbatim" case above.
function invokoke(formatter: Parameters<typeof invokeFormatter>[0]): unknown {
  return invokeFormatter(formatter, BASE_CTX);
}

describe("register idempotence", () => {
  it("ignores subsequent registrations with the same name", () => {
    register({
      name: "cat",
      matcher: { kind: "argv0", argv0: "cat" },
      render: () => "first",
    });
    register({
      name: "cat",
      matcher: { kind: "argv0", argv0: "cat" },
      render: () => "duplicate-ignored",
    });
    const result = findFormatter(BASE_CTX);
    expect(result?.render(BASE_CTX)).toBe("first");
  });
});
