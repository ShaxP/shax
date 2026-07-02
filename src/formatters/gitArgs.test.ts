import { describe, expect, it } from "vitest";
import { argsAfterSubcommand, findGitDashC, findGitSubcommand } from "./gitArgs";

describe("findGitSubcommand", () => {
  it("returns null when argv doesn't start with git", () => {
    expect(findGitSubcommand(["hg", "status"])).toBeNull();
    expect(findGitSubcommand([])).toBeNull();
  });

  it("returns the subcommand for the bare form", () => {
    expect(findGitSubcommand(["git", "status"])).toBe("status");
    expect(findGitSubcommand(["git", "diff", "HEAD"])).toBe("diff");
  });

  it("skips `-C <path>` prefixes", () => {
    expect(findGitSubcommand(["git", "-C", "/repo", "status"])).toBe("status");
    expect(findGitSubcommand(["git", "-C", "/repo", "diff", "HEAD"])).toBe("diff");
  });

  it("skips `-c name=value` prefixes", () => {
    expect(findGitSubcommand(["git", "-c", "color.ui=never", "status"])).toBe("status");
  });

  it("skips inline `--flag=value` forms", () => {
    expect(findGitSubcommand(["git", "--git-dir=/repo/.git", "status"])).toBe("status");
  });

  it("skips `--git-dir <path>` value-slot forms", () => {
    expect(findGitSubcommand(["git", "--git-dir", "/repo/.git", "status"])).toBe("status");
  });

  it("returns null when there's no subcommand after the prefixes", () => {
    expect(findGitSubcommand(["git", "-C", "/repo"])).toBeNull();
    expect(findGitSubcommand(["git", "-C"])).toBeNull();
  });
});

describe("findGitDashC", () => {
  it("finds -C value when present", () => {
    expect(findGitDashC(["git", "-C", "/repo", "status"])).toBe("/repo");
  });

  it("returns null when -C is absent", () => {
    expect(findGitDashC(["git", "status"])).toBeNull();
  });

  it("returns null when argv doesn't start with git", () => {
    expect(findGitDashC(["hg", "-C", "/repo"])).toBeNull();
  });

  it("returns null when -C has no value slot (malformed)", () => {
    expect(findGitDashC(["git", "-C"])).toBeNull();
  });
});

describe("argsAfterSubcommand", () => {
  it("returns everything after `git <subcommand>` in the bare case", () => {
    expect(argsAfterSubcommand(["git", "status"])).toEqual([]);
    expect(argsAfterSubcommand(["git", "status", "--short", "--branch"])).toEqual([
      "--short",
      "--branch",
    ]);
  });

  it("strips `-C <path>` before returning the tail", () => {
    expect(argsAfterSubcommand(["git", "-C", "/repo", "status", "--short"])).toEqual(["--short"]);
    expect(argsAfterSubcommand(["git", "-C", "/repo", "diff", "HEAD~3"])).toEqual(["HEAD~3"]);
  });

  it("strips inline --flag=value forms too", () => {
    expect(argsAfterSubcommand(["git", "--git-dir=/repo/.git", "diff", "--cached"])).toEqual([
      "--cached",
    ]);
  });

  it("returns [] when argv doesn't start with git", () => {
    expect(argsAfterSubcommand(["hg", "status"])).toEqual([]);
  });
});
