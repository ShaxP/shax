/**
 * Real-Worker integration tests for the sandbox host
 * (slice 4.6b2). Runs in vitest browser-mode (real Chromium
 * via Playwright) because jsdom doesn't ship `Worker`.
 *
 * Coverage:
 *  - Spawn + invoke round-trip with a tiny sample source.
 *  - Throw inside the user render → host returns `null`.
 *  - Missing render function → host returns `null`.
 *  - Schema-invalid return (smuggled tag, wrong shape) → host
 *    returns `null`.
 *  - Oversize return → host returns `null` (the 1 MiB cap).
 *  - Timeout when the user source hangs → host returns `null`
 *    and tears the worker down so the next call gets a fresh
 *    one.
 *
 * Each test resets the workers map so they're isolated.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  invokeSandboxFormatter,
  tearDownAllWorkers,
  type SandboxInvokeContext,
} from "./workerHost";

const baseCtx: SandboxInvokeContext = {
  argv: ["sample"],
  cwd: "/tmp",
  stdout: "hello",
  stderr: "",
  exitCode: 0,
  durationMs: 1,
};

afterEach(() => {
  tearDownAllWorkers();
});

describe("workerHost — real Worker round-trip", () => {
  it("invokes the user render and validates the schema", async () => {
    const source = `
      self.__shax_formatter_render = function (ctx) {
        return { kind: "text", text: "got: " + ctx.stdout };
      };
    `;
    const result = await invokeSandboxFormatter("ok-text", source, baseCtx);
    expect(result).toEqual({ kind: "text", text: "got: hello" });
  });

  it("returns null when the user render throws", async () => {
    const source = `
      self.__shax_formatter_render = function () { throw new Error("user-broken"); };
    `;
    const result = await invokeSandboxFormatter("throws", source, baseCtx);
    expect(result).toBeNull();
  });

  it("returns null when no render function is registered", async () => {
    // Source intentionally doesn't set __shax_formatter_render.
    const source = `var unused = 1;`;
    const result = await invokeSandboxFormatter("no-fn", source, baseCtx);
    expect(result).toBeNull();
  });

  it("returns null when the schema doesn't validate", async () => {
    // Tag is rejected by the validator — no `kind` known.
    const source = `
      self.__shax_formatter_render = function () { return { kind: "evil-tag" }; };
    `;
    const result = await invokeSandboxFormatter("bad-schema", source, baseCtx);
    expect(result).toBeNull();
  });

  it("returns null when the schema exceeds the size cap", async () => {
    // Build a text node bigger than the 1 MiB cap (the host uses
    // a UTF-16 approximation, so a ~1 MiB string clears it).
    const source = `
      var big = new Array(1024 * 1024).join("x");
      self.__shax_formatter_render = function () {
        return { kind: "text", text: big };
      };
    `;
    const result = await invokeSandboxFormatter("oversize", source, baseCtx);
    expect(result).toBeNull();
  });

  it("reaps a hung worker via the timeout and recovers", async () => {
    const source = `
      self.__shax_formatter_render = function () {
        // Infinite loop — the host's 1 s timeout must cut it off.
        while (true) {}
      };
    `;
    const start = performance.now();
    const result = await invokeSandboxFormatter("hung", source, baseCtx);
    const elapsed = performance.now() - start;
    expect(result).toBeNull();
    // Generous bound — the 1 s timeout fires plus some teardown
    // wiggle room.
    expect(elapsed).toBeLessThan(3000);

    // Next invocation must work — the host should have spun a
    // fresh worker after the timeout teardown.
    const goodSource = `
      self.__shax_formatter_render = function () { return { kind: "divider" }; };
    `;
    const recovery = await invokeSandboxFormatter("hung", goodSource, baseCtx);
    expect(recovery).toEqual({ kind: "divider" });
  });
});
