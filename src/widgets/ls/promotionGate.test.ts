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

  it("promotes ALL positional-path forms — resolution is the formatter's job now", () => {
    // Backend `resolve_ls_arg` (mirroring what the shell does at
    // execution time) turns `~`, `$HOME`, and globs into a real
    // parent directory + optional filter. The widget doesn't need
    // to gate on which forms are resolvable; if resolution fails
    // the formatter itself shows a "check RAW" line and the widget
    // never mounts.
    expect(isWidgetPromotable(["ls", "*"])).toBe(true);
    expect(isWidgetPromotable(["ls", "*.ts"])).toBe(true);
    expect(isWidgetPromotable(["ls", "src/*"])).toBe(true);
    expect(isWidgetPromotable(["ls", "dir/{a,b}"])).toBe(true);
    expect(isWidgetPromotable(["ls", "~"])).toBe(true);
    expect(isWidgetPromotable(["ls", "~/Downloads"])).toBe(true);
    expect(isWidgetPromotable(["ls", "~user"])).toBe(true);
    expect(isWidgetPromotable(["ls", "$HOME"])).toBe(true);
    expect(isWidgetPromotable(["ls", "${HOME}/x"])).toBe(true);
    // Flag combos still promote.
    expect(isWidgetPromotable(["ls", "-la", "*"])).toBe(true);
    expect(isWidgetPromotable(["ls", "-la", "~/Downloads"])).toBe(true);
    // Past the `--` separator too.
    expect(isWidgetPromotable(["ls", "--", "*"])).toBe(true);
    expect(isWidgetPromotable(["ls", "--", "~"])).toBe(true);
  });
});
