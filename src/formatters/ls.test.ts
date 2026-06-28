/**
 * Unit tests for the `ls` formatter's pure helpers (M4 slice 4.4).
 * The probe + render are exercised manually in the smoke checklist;
 * here we cover the argv parser, the visibility/sort pipeline, the
 * mtime / human-size formatters, and the resolveLsTarget joining.
 */

import { describe, expect, it } from "vitest";
import {
  applyLsView,
  formatLsMtime,
  humanSize,
  parseLsArgv,
  resolveLsTarget,
  type LsFlags,
} from "./ls";
import type { DirEntry } from "../lib/ipc";

function entry(name: string, overrides: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    kind: "file",
    size: 0,
    modified_ms: 0,
    is_executable: false,
    symlink_target: null,
    ...overrides,
  };
}

describe("parseLsArgv", () => {
  it("returns a clean flag set when no flags are present", () => {
    const flags = parseLsArgv(["ls"]);
    expect(flags.long).toBe(false);
    expect(flags.all).toBe(false);
    expect(flags.paths).toEqual([]);
  });

  it("parses single short flags", () => {
    expect(parseLsArgv(["ls", "-l"]).long).toBe(true);
    expect(parseLsArgv(["ls", "-a"]).all).toBe(true);
    expect(parseLsArgv(["ls", "-h"]).humanReadable).toBe(true);
    expect(parseLsArgv(["ls", "-1"]).onePerLine).toBe(true);
  });

  it("explodes combined short flags", () => {
    const flags = parseLsArgv(["ls", "-lah"]);
    expect(flags.long).toBe(true);
    expect(flags.all).toBe(true);
    expect(flags.humanReadable).toBe(true);
  });

  it("parses long-form names", () => {
    const flags = parseLsArgv(["ls", "--all", "--long", "--reverse"]);
    expect(flags.all).toBe(true);
    expect(flags.long).toBe(true);
    expect(flags.reverse).toBe(true);
  });

  it("treats unknown flags as no-ops", () => {
    const flags = parseLsArgv(["ls", "-x", "--colour=auto", "src"]);
    expect(flags.paths).toEqual(["src"]);
  });

  it("respects the `--` end-of-flags sentinel", () => {
    const flags = parseLsArgv(["ls", "--", "-l", "src"]);
    expect(flags.long).toBe(false);
    expect(flags.paths).toEqual(["-l", "src"]);
  });

  it("collects multiple positionals", () => {
    const flags = parseLsArgv(["ls", "-l", "src", "tests"]);
    expect(flags.long).toBe(true);
    expect(flags.paths).toEqual(["src", "tests"]);
  });
});

const BLANK_FLAGS: LsFlags = {
  long: false,
  all: false,
  almostAll: false,
  humanReadable: false,
  onePerLine: false,
  sortByTime: false,
  sortBySize: false,
  reverse: false,
  paths: [],
};

describe("applyLsView", () => {
  const entries = [
    entry("a"),
    entry("B"),
    entry(".hidden"),
    entry("c", { modified_ms: 1000, size: 50 }),
    entry("d", { modified_ms: 2000, size: 10 }),
  ];

  it("hides dotfiles by default", () => {
    const view = applyLsView(entries, BLANK_FLAGS);
    expect(view.map((e) => e.name)).not.toContain(".hidden");
  });

  it("shows dotfiles when -a is set", () => {
    const view = applyLsView(entries, { ...BLANK_FLAGS, all: true });
    expect(view.map((e) => e.name)).toContain(".hidden");
  });

  it("sorts case-insensitively by name", () => {
    const view = applyLsView(entries, BLANK_FLAGS);
    expect(view.map((e) => e.name)).toEqual(["a", "B", "c", "d"]);
  });

  it("sorts by mtime when -t is set, newest first", () => {
    const view = applyLsView(entries, { ...BLANK_FLAGS, sortByTime: true });
    expect(view.slice(0, 2).map((e) => e.name)).toEqual(["d", "c"]);
  });

  it("sorts by size when -S is set, largest first", () => {
    const view = applyLsView(entries, { ...BLANK_FLAGS, sortBySize: true });
    expect(view[0]?.name).toBe("c"); // size 50
  });

  it("reverses with -r", () => {
    const view = applyLsView(entries, { ...BLANK_FLAGS, reverse: true });
    expect(view.map((e) => e.name)).toEqual(["d", "c", "B", "a"]);
  });
});

describe("humanSize", () => {
  it("reports raw bytes under 1 KiB", () => {
    expect(humanSize(0)).toBe("0B");
    expect(humanSize(512)).toBe("512B");
    expect(humanSize(1023)).toBe("1023B");
  });

  it("steps through K / M / G", () => {
    expect(humanSize(2 * 1024)).toBe("2.0K");
    expect(humanSize(15 * 1024)).toBe("15K");
    expect(humanSize(3 * 1024 * 1024)).toBe("3.0M");
    expect(humanSize(7 * 1024 * 1024 * 1024)).toBe("7.0G");
  });
});

describe("formatLsMtime", () => {
  it("renders 'MMM DD HH:MM' for this year", () => {
    const now = new Date(2026, 5, 28, 14, 30).getTime();
    const ms = new Date(2026, 0, 15, 9, 5).getTime();
    expect(formatLsMtime(ms, now)).toBe("Jan 15 09:05");
  });

  it("renders 'MMM DD  YYYY' for other years", () => {
    const now = new Date(2026, 5, 28).getTime();
    const ms = new Date(2024, 9, 1).getTime();
    expect(formatLsMtime(ms, now)).toBe("Oct  1  2024");
  });

  it("returns a placeholder when mtime is null", () => {
    expect(formatLsMtime(null)).toBe("—");
  });
});

describe("resolveLsTarget", () => {
  it("returns cwd when no positional is given", () => {
    expect(resolveLsTarget([], "/home/me")).toBe("/home/me");
  });

  it("passes an absolute path through unchanged", () => {
    expect(resolveLsTarget(["/etc"], "/home/me")).toBe("/etc");
  });

  it("joins a relative path with cwd", () => {
    expect(resolveLsTarget(["src"], "/home/me/proj")).toBe("/home/me/proj/src");
  });

  it("returns null when there's no cwd and the path is relative", () => {
    expect(resolveLsTarget(["src"], null)).toBeNull();
  });

  it("strips a trailing slash from cwd before joining", () => {
    expect(resolveLsTarget(["src"], "/home/me/proj/")).toBe("/home/me/proj/src");
  });
});
