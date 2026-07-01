import { describe, expect, it } from "vitest";
import { isWidgetPromotable } from "./promotionGate";

describe("isWidgetPromotable", () => {
  it("promotes bare git diff (no args)", () => {
    expect(isWidgetPromotable([])).toBe(true);
  });

  it("promotes git diff with revspecs / path filters", () => {
    expect(isWidgetPromotable(["HEAD~3"])).toBe(true);
    expect(isWidgetPromotable(["main..feature"])).toBe(true);
    expect(isWidgetPromotable(["--", "src/foo.ts", "src/bar.ts"])).toBe(true);
    expect(isWidgetPromotable(["HEAD", "--", "package.json"])).toBe(true);
  });

  it("promotes with `what` flags that leave the output shape intact", () => {
    expect(isWidgetPromotable(["--cached"])).toBe(true);
    expect(isWidgetPromotable(["--staged"])).toBe(true);
    expect(isWidgetPromotable(["-w"])).toBe(true);
    expect(isWidgetPromotable(["--unified=8"])).toBe(true);
  });

  it("rejects --stat variants", () => {
    expect(isWidgetPromotable(["--stat"])).toBe(false);
    expect(isWidgetPromotable(["--stat=80"])).toBe(false);
    expect(isWidgetPromotable(["--shortstat"])).toBe(false);
    expect(isWidgetPromotable(["--numstat"])).toBe(false);
    expect(isWidgetPromotable(["--dirstat"])).toBe(false);
    expect(isWidgetPromotable(["--compact-summary"])).toBe(false);
  });

  it("rejects name-only / name-status", () => {
    expect(isWidgetPromotable(["--name-only"])).toBe(false);
    expect(isWidgetPromotable(["--name-status"])).toBe(false);
  });

  it("rejects --summary and other output re-shapers", () => {
    expect(isWidgetPromotable(["--summary"])).toBe(false);
    expect(isWidgetPromotable(["--check"])).toBe(false);
    expect(isWidgetPromotable(["--raw"])).toBe(false);
  });

  it("rejects when any single arg trips the killswitch, even mixed with acceptable ones", () => {
    expect(isWidgetPromotable(["HEAD~1", "--stat", "src/"])).toBe(false);
  });
});
