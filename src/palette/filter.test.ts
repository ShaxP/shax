import { describe, expect, it } from "vitest";
import { rankCommands } from "./filter";
import type { PaneCommand } from "./registry";

function cmd(name: string, description = ""): PaneCommand {
  return {
    name,
    description,
    group: "Debug",
    matcher: () => true,
    render: () => ({ kind: "preview", command: "" }),
  };
}

describe("rankCommands", () => {
  it("returns everything at score 1 when the query is empty", () => {
    const cmds = [cmd("Alpha"), cmd("Beta")];
    const ranked = rankCommands(cmds, "");
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.score === 1)).toBe(true);
  });

  it("ranks a name prefix hit above a word-start hit above a substring hit", () => {
    const cmds = [
      cmd("checkout branch"), // prefix on "checkout"
      cmd("git checkout"), // word-start on "checkout"
      cmd("show ancient checkoutlog"), // substring, not word-start
      cmd("unrelated", "checkout in the description"), // description-only
    ];
    const ranked = rankCommands(cmds, "checkout");
    expect(ranked.map((r) => r.command.name)).toEqual([
      "checkout branch",
      "git checkout",
      "show ancient checkoutlog",
      "unrelated",
    ]);
  });

  it("filters out zero-score entries", () => {
    const ranked = rankCommands([cmd("apple"), cmd("banana")], "zzz");
    expect(ranked).toEqual([]);
  });

  it("treats spaces / dashes / underscores as word boundaries", () => {
    const ranked = rankCommands([cmd("git-status"), cmd("git_stash"), cmd("Zoo")], "s");
    // Both git-status and git_stash have a word starting with "s".
    expect(ranked.map((r) => r.command.name)).toContain("git-status");
    expect(ranked.map((r) => r.command.name)).toContain("git_stash");
    // Zoo does not.
    expect(ranked.map((r) => r.command.name)).not.toContain("Zoo");
  });
});
