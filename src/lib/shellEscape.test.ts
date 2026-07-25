import { describe, expect, it } from "vitest";
import { shellEscape } from "./shellEscape";

describe("shellEscape", () => {
  it("returns bare-word paths unchanged", () => {
    expect(shellEscape("/tmp/foo")).toBe("/tmp/foo");
    expect(shellEscape("src/App.tsx")).toBe("src/App.tsx");
    expect(shellEscape("some-file.txt")).toBe("some-file.txt");
    expect(shellEscape("with_underscores")).toBe("with_underscores");
  });

  it("wraps paths with shell-meaningful characters in single quotes", () => {
    expect(shellEscape("with space")).toBe("'with space'");
    expect(shellEscape("$HOME/x")).toBe("'$HOME/x'");
    expect(shellEscape("cat && rm")).toBe("'cat && rm'");
    expect(shellEscape("*.txt")).toBe("'*.txt'");
  });

  it("escapes embedded single quotes correctly", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
    expect(shellEscape("'both'")).toBe("''\\''both'\\'''");
  });
});
