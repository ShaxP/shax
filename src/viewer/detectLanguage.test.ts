import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  extensionFromArgv,
  languageFromShebang,
  looksLikeJson,
} from "./detectLanguage";

describe("extensionFromArgv", () => {
  it("returns the extension of the first non-flag positional", () => {
    expect(extensionFromArgv(["cat", "README.md"])).toBe("md");
    expect(extensionFromArgv(["bat", "src/lib.rs"])).toBe("rs");
  });

  it("skips flags before finding the filename", () => {
    expect(extensionFromArgv(["bat", "--paging=never", "src/lib.rs"])).toBe("rs");
  });

  it("returns null when no extension is present", () => {
    expect(extensionFromArgv(["cat", "Makefile"])).toBeNull();
  });

  it("returns null on an empty trailing dot", () => {
    expect(extensionFromArgv(["cat", "foo."])).toBeNull();
  });

  it("returns null when only the program name is given", () => {
    expect(extensionFromArgv(["ls"])).toBeNull();
  });

  it("lower-cases the result", () => {
    expect(extensionFromArgv(["cat", "README.MD"])).toBe("md");
  });
});

describe("languageFromShebang", () => {
  it("matches /usr/bin/env <name>", () => {
    expect(languageFromShebang("#!/usr/bin/env python3\nprint('hi')")).toBe("python");
    expect(languageFromShebang("#!/usr/bin/env node\nconsole.log(1)")).toBe("javascript");
  });

  it("matches a direct interpreter path", () => {
    expect(languageFromShebang("#!/usr/bin/python3\n")).toBe("python");
  });

  it("returns null when there's no shebang", () => {
    expect(languageFromShebang("just plain text")).toBeNull();
  });

  it("returns null for unknown interpreters", () => {
    expect(languageFromShebang("#!/usr/bin/perl\n")).toBeNull();
  });
});

describe("looksLikeJson", () => {
  it("recognises an object", () => {
    expect(looksLikeJson('{"a": 1}')).toBe(true);
  });

  it("recognises an array", () => {
    expect(looksLikeJson("[1, 2, 3]")).toBe(true);
  });

  it("ignores leading whitespace before the brace", () => {
    expect(looksLikeJson('  \n  {"x": true}')).toBe(true);
  });

  it("rejects content that doesn't parse", () => {
    expect(looksLikeJson('{"unterminated":')).toBe(false);
  });

  it("rejects non-JSON text", () => {
    expect(looksLikeJson("hello world")).toBe(false);
  });
});

describe("detectLanguage pipeline", () => {
  it("prefers the filename extension over content sniffing", () => {
    // The content looks like JSON, but the user explicitly cat'd a
    // .py file — trust the filename.
    expect(detectLanguage('{"a":1}', ["cat", "config.py"])).toBe("python");
  });

  it("falls back to shebang when no filename extension is available", () => {
    expect(detectLanguage("#!/usr/bin/env node\nconsole.log(1)", ["cat", "script"])).toBe(
      "javascript",
    );
  });

  it("falls back to JSON sniff when filename and shebang fail", () => {
    expect(detectLanguage('[{"a":1}]')).toBe("json");
  });

  it("defaults to plaintext", () => {
    expect(detectLanguage("just some output")).toBe("plaintext");
  });
});
