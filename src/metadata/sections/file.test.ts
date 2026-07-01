import { describe, expect, it } from "vitest";
import { buildFileSection, formatTimestamp, humanBytes } from "./file";
import type { FileStat } from "../../lib/ipc";

const BASE_STAT: FileStat = {
  name: "README.md",
  path: "/home/ada/README.md",
  size_bytes: 4096,
  is_directory: false,
  is_symlink: false,
  is_executable: false,
  created_unix_ms: 1_700_000_000_000,
  modified_unix_ms: 1_710_000_000_000,
  symlink_target: null,
};

describe("humanBytes", () => {
  it("renders sub-KiB counts as raw bytes", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(1023)).toBe("1023 B");
  });

  it("renders KiB with one decimal below 10", () => {
    expect(humanBytes(1024)).toBe("1.0 KiB");
    expect(humanBytes(2560)).toBe("2.5 KiB");
  });

  it("renders MiB and beyond", () => {
    expect(humanBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(humanBytes(1024 * 1024 * 1024)).toBe("1.0 GiB");
  });

  it("drops the decimal at 10+ units", () => {
    expect(humanBytes(1024 * 15)).toBe("15 KiB");
  });
});

describe("formatTimestamp", () => {
  it("produces a stable YYYY-MM-DD HH:MM shape", () => {
    const out = formatTimestamp(1_700_000_000_000);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("buildFileSection", () => {
  it("includes name / path / size / modified as the baseline", () => {
    const section = buildFileSection(BASE_STAT);
    expect(section.title).toBe("File");
    const keys = section.rows.map((r) => r.key);
    expect(keys).toContain("Name");
    expect(keys).toContain("Path");
    expect(keys).toContain("Size");
    expect(keys).toContain("Modified");
  });

  it("labels created as unknown when the filesystem doesn't track it", () => {
    const section = buildFileSection({ ...BASE_STAT, created_unix_ms: null });
    const created = section.rows.find((r) => r.key === "Created");
    expect(created?.value).toBe("unknown");
    expect(created?.hint).toContain("not tracked");
  });

  it("appends the executable flag on unix", () => {
    const section = buildFileSection({ ...BASE_STAT, is_executable: true });
    const exec = section.rows.find((r) => r.key === "Executable");
    expect(exec?.value).toBe("yes");
  });

  it("skips the executable row on windows (is_executable = null)", () => {
    const section = buildFileSection({ ...BASE_STAT, is_executable: null });
    expect(section.rows.find((r) => r.key === "Executable")).toBeUndefined();
  });

  it("shows the symlink target when applicable", () => {
    const section = buildFileSection({
      ...BASE_STAT,
      is_symlink: true,
      symlink_target: "/etc/passwd",
    });
    const sym = section.rows.find((r) => r.key === "Symlink");
    expect(sym?.value).toBe("/etc/passwd");
  });

  it("has size hint with exact byte count", () => {
    const section = buildFileSection({ ...BASE_STAT, size_bytes: 290_824 });
    const size = section.rows.find((r) => r.key === "Size");
    expect(size?.value).toBe("284 KiB");
    expect(size?.hint).toContain("290,824");
  });
});
