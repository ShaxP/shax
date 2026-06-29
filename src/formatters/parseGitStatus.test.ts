import { describe, expect, it } from "vitest";
import { parseGitStatus } from "./parseGitStatus";

describe("parseGitStatus", () => {
  it("parses branch headers", () => {
    const out =
      [
        "# branch.oid abc123",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
      ].join("\0") + "\0";
    const s = parseGitStatus(out);
    expect(s.branch.oid).toBe("abc123");
    expect(s.branch.head).toBe("main");
    expect(s.branch.upstream).toBe("origin/main");
    expect(s.branch.ahead).toBe(2);
    expect(s.branch.behind).toBe(1);
  });

  it("handles (initial) branch on a fresh repo", () => {
    const out = ["# branch.oid (initial)", "# branch.head main"].join("\0") + "\0";
    const s = parseGitStatus(out);
    expect(s.branch.oid).toBe("(initial)");
    expect(s.branch.head).toBe("main");
    expect(s.branch.upstream).toBeNull();
  });

  it("buckets a tracked modification into unstaged", () => {
    const line = "1 .M N... 100644 100644 100644 abc def README.md";
    const s = parseGitStatus(line + "\0");
    expect(s.unstaged).toHaveLength(1);
    expect(s.staged).toHaveLength(0);
    expect(s.unstaged[0]?.path).toBe("README.md");
    expect(s.unstaged[0]?.worktree).toBe("M");
  });

  it("buckets a staged add into staged", () => {
    const line = "1 A. N... 000000 100644 100644 abc def new.txt";
    const s = parseGitStatus(line + "\0");
    expect(s.staged).toHaveLength(1);
    expect(s.unstaged).toHaveLength(0);
    expect(s.staged[0]?.index).toBe("A");
  });

  it("buckets a combined modification into both staged and unstaged", () => {
    // Both index and worktree changed → user staged some, then
    // edited more.
    const line = "1 MM N... 100644 100644 100644 abc def src/main.rs";
    const s = parseGitStatus(line + "\0");
    expect(s.staged).toHaveLength(1);
    expect(s.unstaged).toHaveLength(1);
  });

  it("parses a rename (record 2) with its original path", () => {
    // Two NUL-separated records: the line, then the original path.
    const line = "2 R. N... 100644 100644 100644 abc def R100 newname.txt";
    const orig = "oldname.txt";
    const s = parseGitStatus(`${line}\0${orig}\0`);
    expect(s.staged).toHaveLength(1);
    expect(s.staged[0]?.path).toBe("newname.txt");
    expect(s.staged[0]?.origPath).toBe("oldname.txt");
  });

  it("collects untracked into untracked", () => {
    const s = parseGitStatus("? sketch.py\0");
    expect(s.untracked).toHaveLength(1);
    expect(s.untracked[0]?.path).toBe("sketch.py");
  });

  it("collects unmerged into unmerged", () => {
    // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    const line = "u UU N... 100644 100644 100644 100644 abc def ghi conflict.txt";
    const s = parseGitStatus(line + "\0");
    expect(s.unmerged).toHaveLength(1);
    expect(s.unmerged[0]?.path).toBe("conflict.txt");
  });

  it("handles paths containing spaces", () => {
    const line = "1 .M N... 100644 100644 100644 abc def Some File With Spaces.md";
    const s = parseGitStatus(line + "\0");
    expect(s.unstaged[0]?.path).toBe("Some File With Spaces.md");
  });

  it("returns empty buckets on empty input", () => {
    const s = parseGitStatus("");
    expect(s.staged).toEqual([]);
    expect(s.unstaged).toEqual([]);
    expect(s.untracked).toEqual([]);
    expect(s.unmerged).toEqual([]);
    expect(s.ignored).toEqual([]);
  });
});
