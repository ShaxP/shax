import { describe, expect, it } from "vitest";
import { isWidgetPromotable } from "./promotionGate";

describe("git-status promotionGate", () => {
  it("promotes bare git status", () => {
    expect(isWidgetPromotable([])).toBe(true);
  });

  it("promotes short / branch / porcelain forms", () => {
    expect(isWidgetPromotable(["-s"])).toBe(true);
    expect(isWidgetPromotable(["--short"])).toBe(true);
    expect(isWidgetPromotable(["-b"])).toBe(true);
    expect(isWidgetPromotable(["--branch"])).toBe(true);
    expect(isWidgetPromotable(["--porcelain"])).toBe(true);
    expect(isWidgetPromotable(["--porcelain=v2"])).toBe(true);
    expect(isWidgetPromotable(["-s", "-b"])).toBe(true);
  });

  it("promotes untracked / ignored flags", () => {
    expect(isWidgetPromotable(["-u"])).toBe(true);
    expect(isWidgetPromotable(["--untracked-files=all"])).toBe(true);
    expect(isWidgetPromotable(["--ignored"])).toBe(true);
    expect(isWidgetPromotable(["--ignore-submodules=untracked"])).toBe(true);
  });

  it("promotes path filters", () => {
    expect(isWidgetPromotable(["--", "src/foo.ts"])).toBe(true);
    expect(isWidgetPromotable(["-s", "--", "src/", "docs/"])).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(isWidgetPromotable(["--long"])).toBe(false);
    expect(isWidgetPromotable(["--no-renames"])).toBe(false);
    expect(isWidgetPromotable(["--column"])).toBe(false);
  });

  it("rejects when any single arg trips the killswitch", () => {
    expect(isWidgetPromotable(["-s", "--long"])).toBe(false);
  });

  it("treats args after `--` as paths (accepted)", () => {
    expect(isWidgetPromotable(["--", "--not-a-flag"])).toBe(true);
  });
});
