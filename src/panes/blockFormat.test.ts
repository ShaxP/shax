import { describe, it, expect } from "vitest";
import { compactCwd, formatDuration } from "./blockFormat";

describe("formatDuration", () => {
  it("renders sub-second durations as ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("renders sub-minute durations as fixed-2 seconds", () => {
    expect(formatDuration(1000)).toBe("1.00s");
    expect(formatDuration(1840)).toBe("1.84s");
    expect(formatDuration(59_990)).toBe("59.99s");
  });

  it("renders minutes as m:ss", () => {
    expect(formatDuration(60_000)).toBe("1:00");
    expect(formatDuration(83_500)).toBe("1:23");
    expect(formatDuration(3_599_000)).toBe("59:59");
  });

  it("renders hours as h:mm:ss", () => {
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("renders null and invalid inputs as --", () => {
    expect(formatDuration(null)).toBe("--");
    expect(formatDuration(undefined)).toBe("--");
    expect(formatDuration(Number.NaN)).toBe("--");
    expect(formatDuration(-1)).toBe("--");
  });
});

describe("compactCwd (M7.6)", () => {
  it("substitutes home with ~ when cwd is under it", () => {
    expect(compactCwd("/Users/ada/dev/shax", "/Users/ada")).toBe("~/dev/shax");
  });

  it("renders bare home as ~", () => {
    expect(compactCwd("/Users/ada", "/Users/ada")).toBe("~");
  });

  it("tolerates a trailing slash on home", () => {
    expect(compactCwd("/Users/ada/dev/shax", "/Users/ada/")).toBe("~/dev/shax");
  });

  it("leaves paths outside home untouched", () => {
    expect(compactCwd("/tmp/scratch", "/Users/ada")).toBe("/tmp/scratch");
  });

  it("does NOT match a home prefix that isn't a full segment", () => {
    // `/Users/adaptive` starts with `/Users/ada` byte-wise but is a
    // different user — must not collapse.
    expect(compactCwd("/Users/adaptive/repo", "/Users/ada")).toBe("/Users/adaptive/repo");
  });

  it("shortens long paths under home to ~/…/<lastseg>", () => {
    const cwd = "/Users/ada/dev/very/long/nested/path/to/project";
    expect(compactCwd(cwd, "/Users/ada", 20)).toBe("~/…/project");
  });

  it("shortens long absolute paths that don't share a home to …/<lastseg>", () => {
    expect(compactCwd("/opt/vendor/tools/some/deeply/nested/binary", null, 20)).toBe("…/binary");
  });

  it("preserves paths within the cap even when a home is provided", () => {
    expect(compactCwd("/tmp/x", "/Users/ada", 20)).toBe("/tmp/x");
  });

  it("renders null or empty cwd as an em-dash", () => {
    expect(compactCwd(null, "/Users/ada")).toBe("—");
    expect(compactCwd("", "/Users/ada")).toBe("—");
  });

  it("falls back to the atomic segment when the tail alone exceeds the cap", () => {
    // No parent to collapse — return the input as-is; the caller's
    // CSS ellipsis handles the visual overflow.
    const single = "/thisisareallylongsegmentwithnoslashes";
    expect(compactCwd(single, null, 10)).toBe(single);
  });
});
