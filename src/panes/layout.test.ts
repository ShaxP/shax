/**
 * Unit tests for the pane layout tree (M2 slice 2.2a).
 *
 * Pure functions over the tree shape — no React, no PTY, no DOM. Each
 * test covers a single helper.
 */

import { describe, it, expect } from "vitest";
import {
  leaf,
  leafIds,
  findLeaf,
  splitLeaf,
  removeLeaf,
  cycleFocus,
  neighborAfterClose,
  computeGeometry,
} from "./layout";
import type { LayoutNode } from "./layout";

describe("layout / leafIds", () => {
  it("returns the single pane id for a leaf", () => {
    expect(leafIds(leaf("a"))).toEqual(["a"]);
  });

  it("returns DFS left-to-right order for nested splits", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        a: leaf("b"),
        b: leaf("c"),
      },
    };
    expect(leafIds(tree)).toEqual(["a", "b", "c"]);
  });
});

describe("layout / findLeaf", () => {
  it("finds a leaf by paneId", () => {
    expect(findLeaf(leaf("a"), "a")).toEqual({ kind: "leaf", paneId: "a" });
  });

  it("returns null for an absent id", () => {
    expect(findLeaf(leaf("a"), "z")).toBeNull();
  });

  it("walks into both children", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    };
    expect(findLeaf(tree, "a")?.paneId).toBe("a");
    expect(findLeaf(tree, "b")?.paneId).toBe("b");
  });
});

describe("layout / splitLeaf", () => {
  it("replaces a leaf with a Split (row) holding original + new leaf", () => {
    const next = splitLeaf(leaf("a"), "a", "b", "row");
    expect(next).toEqual({
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    });
  });

  it("uses 'column' direction when asked", () => {
    const next = splitLeaf(leaf("a"), "a", "b", "column");
    expect(next.kind).toBe("split");
    if (next.kind !== "split") throw new Error("expected split");
    expect(next.direction).toBe("column");
  });

  it("respects a custom ratio", () => {
    const next = splitLeaf(leaf("a"), "a", "b", "row", 0.3);
    if (next.kind !== "split") throw new Error("expected split");
    expect(next.ratio).toBeCloseTo(0.3);
  });

  it("walks into Splits to find the target leaf", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    };
    const next = splitLeaf(tree, "b", "c", "column");
    expect(leafIds(next)).toEqual(["a", "b", "c"]);
  });

  it("returns the tree unchanged when target is not found", () => {
    const tree = leaf("a");
    expect(splitLeaf(tree, "missing", "new", "row")).toBe(tree);
  });
});

describe("layout / removeLeaf", () => {
  it("returns null when removing the only leaf", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  it("collapses a Split to its surviving sibling", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    };
    expect(removeLeaf(tree, "b")).toEqual(leaf("a"));
    expect(removeLeaf(tree, "a")).toEqual(leaf("b"));
  });

  it("collapses recursively through nested splits", () => {
    // a | (b / c)  — removing 'c' collapses inner split to just 'b', the
    // outer remains as a | b.
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        a: leaf("b"),
        b: leaf("c"),
      },
    };
    expect(removeLeaf(tree, "c")).toEqual({
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    });
  });

  it("is a no-op when the leaf is absent", () => {
    const tree = leaf("a");
    expect(removeLeaf(tree, "missing")).toBe(tree);
  });
});

describe("layout / cycleFocus", () => {
  it("wraps forward at the end", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    };
    expect(cycleFocus(tree, "b", 1)).toBe("a");
  });

  it("wraps backward at the start", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    };
    expect(cycleFocus(tree, "a", -1)).toBe("b");
  });

  it("returns the same id when there is only one leaf", () => {
    expect(cycleFocus(leaf("a"), "a", 1)).toBe("a");
    expect(cycleFocus(leaf("a"), "a", -1)).toBe("a");
  });
});

describe("layout / computeGeometry", () => {
  it("places a single leaf over the full container", () => {
    const g = computeGeometry(leaf("a"));
    expect(g.panes).toEqual([{ paneId: "a", rect: { left: 0, top: 0, width: 100, height: 100 } }]);
    expect(g.dividers).toEqual([]);
  });

  it("splits side-by-side (row) at the given ratio", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.3,
      a: leaf("a"),
      b: leaf("b"),
    };
    const g = computeGeometry(tree);
    expect(g.panes[0]?.rect).toMatchObject({ left: 0, top: 0, width: 30, height: 100 });
    expect(g.panes[1]?.rect).toMatchObject({ left: 30, top: 0, width: 70, height: 100 });
    expect(g.dividers).toEqual([
      { direction: "row", rect: { left: 30, top: 0, width: 0, height: 100 } },
    ]);
  });

  it("splits stacked (column) at the given ratio", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "column",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    };
    const g = computeGeometry(tree);
    expect(g.panes[0]?.rect).toMatchObject({ left: 0, top: 0, width: 100, height: 50 });
    expect(g.panes[1]?.rect).toMatchObject({ left: 0, top: 50, width: 100, height: 50 });
    expect(g.dividers).toEqual([
      { direction: "column", rect: { left: 0, top: 50, width: 100, height: 0 } },
    ]);
  });

  it("nests splits and divides space proportionally", () => {
    // Left half is `a`. Right half is split vertically into b (top) and c (bottom).
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        a: leaf("b"),
        b: leaf("c"),
      },
    };
    const g = computeGeometry(tree);
    const byId = new Map(g.panes.map((p) => [p.paneId, p.rect]));
    expect(byId.get("a")).toMatchObject({ left: 0, top: 0, width: 50, height: 100 });
    expect(byId.get("b")).toMatchObject({ left: 50, top: 0, width: 50, height: 50 });
    expect(byId.get("c")).toMatchObject({ left: 50, top: 50, width: 50, height: 50 });
    expect(g.dividers).toHaveLength(2);
  });
});

describe("layout / neighborAfterClose", () => {
  it("picks the right/bottom neighbour by default", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    };
    expect(neighborAfterClose(tree, "a")).toBe("b");
  });

  it("falls back to the previous leaf when the closed pane is the last", () => {
    const tree: LayoutNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    };
    expect(neighborAfterClose(tree, "b")).toBe("a");
  });

  it("returns null when removing the only leaf", () => {
    expect(neighborAfterClose(leaf("a"), "a")).toBeNull();
  });
});
