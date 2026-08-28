import { describe, expect, it } from "vitest";
import { isWidgetPromotable } from "./promotionGate";

describe("ls promotionGate", () => {
  it("promotes bare ls", () => {
    expect(isWidgetPromotable(["ls"])).toBe(true);
  });

  it("promotes known short flags", () => {
    expect(isWidgetPromotable(["ls", "-a"])).toBe(true);
    expect(isWidgetPromotable(["ls", "-A"])).toBe(true);
    expect(isWidgetPromotable(["ls", "-la"])).toBe(true);
    expect(isWidgetPromotable(["ls", "-lah"])).toBe(true);
    expect(isWidgetPromotable(["ls", "-tr"])).toBe(true);
    expect(isWidgetPromotable(["ls", "-1"])).toBe(true);
    expect(isWidgetPromotable(["ls", "-S"])).toBe(true);
  });

  it("promotes known long flags", () => {
    expect(isWidgetPromotable(["ls", "--all"])).toBe(true);
    expect(isWidgetPromotable(["ls", "--almost-all"])).toBe(true);
    expect(isWidgetPromotable(["ls", "--long"])).toBe(true);
    expect(isWidgetPromotable(["ls", "--human-readable"])).toBe(true);
    expect(isWidgetPromotable(["ls", "--reverse"])).toBe(true);
  });

  it("promotes positional paths", () => {
    expect(isWidgetPromotable(["ls", "src"])).toBe(true);
    expect(isWidgetPromotable(["ls", "-a", "src"])).toBe(true);
    expect(isWidgetPromotable(["ls", "src", "docs"])).toBe(true);
  });

  it("promotes `--` separator with paths that look like flags", () => {
    expect(isWidgetPromotable(["ls", "--", "--weird-name"])).toBe(true);
  });

  it("rejects unknown short flags", () => {
    expect(isWidgetPromotable(["ls", "-F"])).toBe(false);
    expect(isWidgetPromotable(["ls", "-p"])).toBe(false);
    expect(isWidgetPromotable(["ls", "-i"])).toBe(false);
    // Cluster with an unknown char rejects the whole thing.
    expect(isWidgetPromotable(["ls", "-laF"])).toBe(false);
  });

  // Regression: Fedora / Ubuntu ship `alias ls='ls --color=auto'`
  // in their default rc files. Rejecting that alias silently
  // degraded every Linux user's ls to the non-interactive
  // formatter — "renders perfectly but can't navigate."
  it("promotes --color and all of its --color=WHEN variants", () => {
    expect(isWidgetPromotable(["ls", "--color"])).toBe(true);
    expect(isWidgetPromotable(["ls", "--color=auto"])).toBe(true);
    expect(isWidgetPromotable(["ls", "--color=always"])).toBe(true);
    expect(isWidgetPromotable(["ls", "--color=never"])).toBe(true);
    // Novel/unknown values still promote — the widget probes the
    // filesystem, so the value never reaches our render.
    expect(isWidgetPromotable(["ls", "--color=tty"])).toBe(true);
    // Combined with other accepted flags — still promotes.
    expect(isWidgetPromotable(["ls", "-la", "--color=auto"])).toBe(true);
  });

  it("rejects unknown long flags", () => {
    expect(isWidgetPromotable(["ls", "--sort=size"])).toBe(false);
    expect(isWidgetPromotable(["ls", "--group-directories-first"])).toBe(false);
  });

  it("rejects when any single arg trips the killswitch", () => {
    expect(isWidgetPromotable(["ls", "-a", "--sort=size"])).toBe(false);
  });

  it("refuses to promote when a positional carries an unexpanded shell metachar", () => {
    // Shax's block capture holds the pre-expansion command text. If
    // the user typed `ls *`, argv arrives as ["ls", "*"] and the
    // shell already did the real listing. Falling through to the
    // static formatter (which then PASSes to raw for the same
    // reason) beats a widget that would try to probe a directory
    // literally named `*`.
    expect(isWidgetPromotable(["ls", "*"])).toBe(false);
    expect(isWidgetPromotable(["ls", "*.ts"])).toBe(false);
    expect(isWidgetPromotable(["ls", "src/*"])).toBe(false);
    expect(isWidgetPromotable(["ls", "~"])).toBe(false);
    expect(isWidgetPromotable(["ls", "~/Downloads"])).toBe(false);
    expect(isWidgetPromotable(["ls", "$HOME"])).toBe(false);
    // Same treatment past the `--` separator.
    expect(isWidgetPromotable(["ls", "--", "*"])).toBe(false);
    // And even when the flags themselves are fine.
    expect(isWidgetPromotable(["ls", "-la", "*"])).toBe(false);
  });
});
