import { afterEach, describe, expect, it } from "vitest";
import {
  _resetRegistryForTests,
  availableCommands,
  listPaneCommands,
  registerPaneCommand,
  type PaneContext,
} from "./registry";

const CTX: PaneContext = { ptyId: "pty-1", cwd: "/tmp", branch: null };

afterEach(() => {
  _resetRegistryForTests();
});

describe("pane-command registry", () => {
  it("returns registered commands in registration order", () => {
    registerPaneCommand({
      name: "First",
      description: "one",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "echo one" }),
    });
    registerPaneCommand({
      name: "Second",
      description: "two",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "echo two" }),
    });
    expect(listPaneCommands().map((c) => c.name)).toEqual(["First", "Second"]);
  });

  it("re-registering the same name replaces silently (idempotent under HMR)", () => {
    registerPaneCommand({
      name: "Same",
      description: "v1",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "v1" }),
    });
    registerPaneCommand({
      name: "Same",
      description: "v2",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "v2" }),
    });
    expect(listPaneCommands()).toHaveLength(1);
    expect(listPaneCommands()[0]?.description).toBe("v2");
  });

  it("availableCommands filters by matcher", () => {
    registerPaneCommand({
      name: "Always",
      description: "",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "" }),
    });
    registerPaneCommand({
      name: "Only in /home",
      description: "",
      group: "Debug",
      matcher: (ctx) => ctx.cwd?.startsWith("/home") === true,
      render: () => ({ kind: "preview", command: "" }),
    });
    expect(availableCommands(CTX).map((c) => c.name)).toEqual(["Always"]);
    expect(availableCommands({ ...CTX, cwd: "/home/ada" }).map((c) => c.name)).toEqual([
      "Always",
      "Only in /home",
    ]);
  });
});
