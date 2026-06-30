/**
 * Tests for the worker-side scaffolding helpers. We don't spin a
 * real Worker here — jsdom doesn't ship one. Instead we eval the
 * generated source in a controlled `self` context and verify the
 * dispatch contract.
 */

import { describe, expect, it } from "vitest";
import { buildWorkerSource, workerScaffoldSource } from "./workerEntry";

interface FakeSelf {
  __shax_formatter_render?: (ctx: unknown) => unknown;
  onmessage?: (event: { data: unknown }) => void;
  postMessage(message: unknown): void;
}

function runInFakeWorker(source: string): {
  self: FakeSelf;
  posted: unknown[];
} {
  const posted: unknown[] = [];
  const fakeSelf: FakeSelf = {
    postMessage(message: unknown) {
      posted.push(message);
    },
  };
  // Function-scoped eval so `self` inside the scaffolding refers
  // to our fake. The scaffolding source is structured to depend
  // only on `self`, never on real Worker globals. `new Function`
  // is deliberate — we need to execute generated JS in an
  // isolated scope without a real Worker.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("self", source);
  (factory as (self: FakeSelf) => void)(fakeSelf);
  return { self: fakeSelf, posted };
}

describe("workerScaffoldSource", () => {
  it("installs an onmessage that posts back the user's render result", () => {
    const userSource = `
      self.__shax_formatter_render = function (ctx) {
        return { kind: "text", text: "hello " + ctx.argv[0] };
      };
    `;
    const { self, posted } = runInFakeWorker(buildWorkerSource(userSource));
    if (self.onmessage === undefined) throw new Error("scaffold did not install onmessage");
    self.onmessage({ data: { id: 7, ctx: { argv: ["wc"] } } });
    expect(posted).toEqual([{ id: 7, ok: true, node: { kind: "text", text: "hello wc" } }]);
  });

  it("returns ok:false with reason when the user render throws", () => {
    const userSource = `
      self.__shax_formatter_render = function () { throw new Error("boom"); };
    `;
    const { self, posted } = runInFakeWorker(buildWorkerSource(userSource));
    if (self.onmessage === undefined) throw new Error("scaffold did not install onmessage");
    self.onmessage({ data: { id: 1, ctx: {} } });
    expect(posted).toEqual([{ id: 1, ok: false, reason: "boom" }]);
  });

  it("returns ok:false when no render function was registered", () => {
    const { self, posted } = runInFakeWorker(workerScaffoldSource());
    if (self.onmessage === undefined) throw new Error("scaffold did not install onmessage");
    self.onmessage({ data: { id: 2, ctx: {} } });
    expect(posted).toHaveLength(1);
    const reply = posted[0] as { id?: number; ok?: boolean; reason?: string };
    expect(reply.id).toBe(2);
    expect(reply.ok).toBe(false);
    expect(reply.reason).toMatch(/no render function/);
  });

  it("echoes the request id back even on error paths", () => {
    const userSource = `self.__shax_formatter_render = function () { throw "stringy"; };`;
    const { self, posted } = runInFakeWorker(buildWorkerSource(userSource));
    if (self.onmessage === undefined) throw new Error("scaffold did not install onmessage");
    self.onmessage({ data: { id: 99, ctx: {} } });
    const reply = posted[0] as { id?: number };
    expect(reply.id).toBe(99);
  });
});
