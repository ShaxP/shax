import { describe, expect, it } from "vitest";
import { parseGitDiff } from "./parseGitDiff";

describe("parseGitDiff", () => {
  it("parses a single-file modification", () => {
    const text = [
      "diff --git a/src/lib.rs b/src/lib.rs",
      "index abc..def 100644",
      "--- a/src/lib.rs",
      "+++ b/src/lib.rs",
      "@@ -1,3 +1,4 @@",
      " fn main() {",
      '-    println!("hi");',
      '+    println!("hello");',
      '+    println!("world");',
      " }",
      "",
    ].join("\n");
    const d = parseGitDiff(text);
    expect(d.files).toHaveLength(1);
    const f = d.files[0];
    if (f === undefined) throw new Error("expected one file");
    expect(f.path).toBe("src/lib.rs");
    expect(f.oldPath).toBe("src/lib.rs");
    expect(f.op).toBeNull();
    expect(f.hunks).toHaveLength(1);
    const h = f.hunks[0];
    if (h === undefined) throw new Error("expected one hunk");
    expect(h.oldStart).toBe(1);
    expect(h.newStart).toBe(1);
    const kinds = h.lines.map((l) => l.kind);
    expect(kinds).toEqual(["context", "del", "add", "add", "context"]);
  });

  it("tracks line numbers across +/-/context", () => {
    const text = [
      "diff --git a/file b/file",
      "--- a/file",
      "+++ b/file",
      "@@ -10,3 +10,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "",
    ].join("\n");
    const d = parseGitDiff(text);
    const hunk = d.files[0]?.hunks[0];
    if (hunk === undefined) throw new Error("expected one hunk");
    const lines = hunk.lines;
    expect(lines[0]).toMatchObject({ kind: "context", oldLine: 10, newLine: 10 });
    expect(lines[1]).toMatchObject({ kind: "del", oldLine: 11, newLine: null });
    expect(lines[2]).toMatchObject({ kind: "add", oldLine: null, newLine: 11 });
    expect(lines[3]).toMatchObject({ kind: "context", oldLine: 12, newLine: 12 });
  });

  it("recognises a new file", () => {
    const text = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..abc123",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,1 @@",
      "+hello",
      "",
    ].join("\n");
    const d = parseGitDiff(text);
    expect(d.files[0]?.op).toBe("new");
    expect(d.files[0]?.path).toBe("new.txt");
  });

  it("recognises a deletion", () => {
    const text = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index abc..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");
    const d = parseGitDiff(text);
    expect(d.files[0]?.op).toBe("deleted");
  });

  it("recognises a rename", () => {
    const text = [
      "diff --git a/from.txt b/to.txt",
      "rename from from.txt",
      "rename to to.txt",
      "",
    ].join("\n");
    const d = parseGitDiff(text);
    expect(d.files[0]?.op).toBe("renamed");
    expect(d.files[0]?.oldPath).toBe("from.txt");
    expect(d.files[0]?.path).toBe("to.txt");
  });

  it("flags binary diffs", () => {
    const text = [
      "diff --git a/image.png b/image.png",
      "index abc..def 100644",
      "Binary files a/image.png and b/image.png differ",
      "",
    ].join("\n");
    const d = parseGitDiff(text);
    expect(d.files[0]?.binary).toBe(true);
    expect(d.files[0]?.hunks).toEqual([]);
  });

  it("parses multiple files in one diff", () => {
    const text = [
      "diff --git a/a b/a",
      "--- a/a",
      "+++ b/a",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b b/b",
      "--- a/b",
      "+++ b/b",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    const d = parseGitDiff(text);
    expect(d.files.map((f) => f.path)).toEqual(["a", "b"]);
    expect(d.files[0]?.hunks).toHaveLength(1);
    expect(d.files[1]?.hunks).toHaveLength(1);
  });

  it("preserves `\\ No newline at end of file` as a meta line", () => {
    const text = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "",
    ].join("\n");
    const hunk = parseGitDiff(text).files[0]?.hunks[0];
    if (hunk === undefined) throw new Error("expected one hunk");
    expect(hunk.lines.some((l) => l.kind === "meta")).toBe(true);
  });

  it("returns an empty file list on empty input", () => {
    expect(parseGitDiff("").files).toEqual([]);
  });
});
