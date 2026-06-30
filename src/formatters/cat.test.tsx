/**
 * Smoke tests for the `cat` / `bat` built-in formatter (slice 4.3).
 *
 * The Viewer it renders is exercised in its own file; here we
 * just check that the matcher is right, the render returns
 * something non-PASS for sane input, and PASS for unrenderable
 * input (no captured stdout).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batFormatter, catFormatter } from "./cat";
import { findFormatter, register, resetRegistryForTests } from "./registry";
import { isPass, type FormatterContext } from "./types";

const BASE_CTX: FormatterContext = {
  argv: ["cat", "README.md"],
  cwd: "/tmp",
  env: {},
  exitCode: 0,
  durationMs: 5,
  stdout: "# hello",
  stderr: "",
  rawAnsi: "# hello",
  paneId: "pty-1",
};

beforeEach(() => {
  resetRegistryForTests();
  register(catFormatter);
  register(batFormatter);
});

afterEach(() => {
  resetRegistryForTests();
});

describe("cat formatter", () => {
  it("matches `cat`", () => {
    expect(findFormatter(BASE_CTX)?.name).toBe("cat");
  });

  it("matches `bat`", () => {
    expect(findFormatter({ ...BASE_CTX, argv: ["bat", "src/lib.rs"] })?.name).toBe("bat");
  });

  it("doesn't match unrelated commands", () => {
    expect(findFormatter({ ...BASE_CTX, argv: ["ls", "-la"] })).toBeNull();
  });

  it("returns a renderable node for non-empty stdout", () => {
    const result = catFormatter.render(BASE_CTX);
    expect(isPass(result)).toBe(false);
    expect(result).not.toBeNull();
  });

  it("returns PASS for empty stdout AND no filename in argv", () => {
    // M4.5 slice 1: cat can disk-read by filename even when
    // stdout is empty (the user might have piped to a file
    // that wrote a `%`-only block, say). So PASS now requires
    // *both* halves missing: no captured text *and* no
    // filename to fall back on.
    const result = catFormatter.render({ ...BASE_CTX, argv: ["cat"], stdout: "" });
    expect(isPass(result)).toBe(true);
  });

  it("renders even with empty stdout when a filename is available", () => {
    // The disk-read effect inside the rendered component can
    // still pull content. The render returns a node; the
    // surface decides whether to mount it.
    const result = catFormatter.render({ ...BASE_CTX, stdout: "" });
    expect(isPass(result)).toBe(false);
  });
});
