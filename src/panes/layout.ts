/**
 * Layout tree for per-tab pane splits (M2 slice 2.2a).
 *
 * Model from `specs/04-multiplexing.md`:
 *
 *   Node = Split { direction, ratio, a, b }
 *        | Leaf  { paneId }
 *
 * `direction` is the flex direction of the wrapper that holds the two
 * children: `'row'` puts them side-by-side (vertical divider line —
 * iTerm's "vertical split"), `'column'` stacks them (horizontal divider —
 * iTerm's "horizontal split"). `ratio` is the share of the wrapper the
 * first child takes, between 0 and 1; the second takes `1 - ratio`.
 *
 * The functions in this module are pure operations on the tree. Anything
 * stateful (PTY spawn/kill, focus side effects) lives in the reducer that
 * drives App state — these helpers just compute the new tree shape.
 */

export type PaneId = string;
export type SplitDirection = "row" | "column";

export interface Leaf {
  kind: "leaf";
  paneId: PaneId;
}

export interface Split {
  kind: "split";
  direction: SplitDirection;
  /** First child's share of the wrapper (0..1). Second child takes 1 - ratio. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = Leaf | Split;

export function leaf(paneId: PaneId): Leaf {
  return { kind: "leaf", paneId };
}

/**
 * All pane ids in the tree, in DFS left-to-right order. Used for focus
 * cycling and for tracking the per-pane state map in lockstep with the
 * tree shape.
 */
export function leafIds(node: LayoutNode): PaneId[] {
  if (node.kind === "leaf") return [node.paneId];
  return [...leafIds(node.a), ...leafIds(node.b)];
}

/**
 * Returns the leaf with the given paneId, or null if not in the tree.
 */
export function findLeaf(node: LayoutNode, paneId: PaneId): Leaf | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findLeaf(node.a, paneId) ?? findLeaf(node.b, paneId);
}

/**
 * Returns a tree with the leaf identified by `targetPaneId` replaced by a
 * Split whose first child is the original leaf and second child is a new
 * leaf wrapping `newPaneId`. `direction` and `ratio` (default 0.5) shape
 * the split. Returns the original tree unchanged if the target is not
 * found.
 */
export function splitLeaf(
  node: LayoutNode,
  targetPaneId: PaneId,
  newPaneId: PaneId,
  direction: SplitDirection,
  ratio = 0.5,
): LayoutNode {
  if (node.kind === "leaf") {
    if (node.paneId !== targetPaneId) return node;
    return { kind: "split", direction, ratio, a: node, b: leaf(newPaneId) };
  }
  const a = splitLeaf(node.a, targetPaneId, newPaneId, direction, ratio);
  if (a !== node.a) return { ...node, a };
  const b = splitLeaf(node.b, targetPaneId, newPaneId, direction, ratio);
  if (b !== node.b) return { ...node, b };
  return node;
}

/**
 * Remove a leaf from the tree. If its parent Split would be left with a
 * single child, the Split collapses to just the surviving sibling
 * (the standard tmux-style rebalance). If removing the leaf would leave
 * the tree empty (the leaf is the only one in the tab), returns `null`
 * and the caller decides what to do — usually "close the tab".
 */
export function removeLeaf(node: LayoutNode, paneId: PaneId): LayoutNode | null {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const a = removeLeaf(node.a, paneId);
  // If `a` was removed, the parent collapses to whatever is in `b`.
  if (a === null) return node.b;
  const b = removeLeaf(node.b, paneId);
  if (b === null) return node.a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/**
 * Return the next pane id when cycling focus (`direction = 1`) or the
 * previous one (`direction = -1`). Wraps at both ends. Returns the same
 * id back when there is only one leaf.
 */
export function cycleFocus(node: LayoutNode, current: PaneId, direction: 1 | -1): PaneId {
  const ids = leafIds(node);
  if (ids.length === 0) return current;
  const idx = ids.indexOf(current);
  if (idx === -1) return ids[0] ?? current;
  const next = (idx + direction + ids.length) % ids.length;
  return ids[next] ?? current;
}

/**
 * Pick a sensible neighbour to take focus after the given pane is
 * removed. We try the next sibling first (so closing a pane shifts focus
 * to its right / bottom neighbour, like every Vim split user expects);
 * if there isn't one, fall back to the previous leaf.
 */
export function neighborAfterClose(node: LayoutNode, paneId: PaneId): PaneId | null {
  const ids = leafIds(node);
  const idx = ids.indexOf(paneId);
  if (idx === -1) return null;
  const remaining = ids.filter((id) => id !== paneId);
  if (remaining.length === 0) return null;
  // Prefer the original right/bottom neighbour (idx in the remaining
  // list), otherwise the new last leaf.
  return remaining[Math.min(idx, remaining.length - 1)] ?? null;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * A rectangle in the container's coordinate space, expressed as
 * percentages (0–100) of the container's width and height. The layout
 * tree is purely relative — actual pixels are the container's job.
 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placement {
  paneId: PaneId;
  rect: Rect;
}

export type SplitPath = ("a" | "b")[];

export interface DividerLine {
  /** `row` splits emit a vertical divider, `column` splits a horizontal one. */
  direction: SplitDirection;
  /**
   * Path through the tree to the Split this divider belongs to.
   * `[]` is the root Split; subsequent entries pick the `a` or `b` child
   * at each level. Used by drag-to-resize to address the Split when the
   * user moves the divider.
   */
  path: SplitPath;
  /**
   * The rect covering both children of the Split (and the centre-line
   * the divider sits on). Drag math converts cursor coordinates to a
   * new ratio relative to this rect.
   */
  splitRect: Rect;
  /** Current ratio of the Split (0..1, child `a` takes this fraction). */
  ratio: number;
}

export interface LayoutGeometry {
  panes: Placement[];
  dividers: DividerLine[];
}

const FULL_RECT: Rect = { left: 0, top: 0, width: 100, height: 100 };

/**
 * Walk the layout tree and return absolute-positioned rectangles for
 * every pane plus every divider line. The App renders TerminalPanes in
 * a flat list at fixed React positions — what *changes* across splits
 * is the geometry, not the React tree — so a split / close never
 * unmounts (and therefore never re-spawns the PTY of) a surviving pane.
 */
export function computeGeometry(node: LayoutNode, rect: Rect = FULL_RECT): LayoutGeometry {
  const panes: Placement[] = [];
  const dividers: DividerLine[] = [];
  walk(node, rect, panes, dividers, []);
  return { panes, dividers };
}

function walk(
  node: LayoutNode,
  rect: Rect,
  panes: Placement[],
  dividers: DividerLine[],
  path: SplitPath,
): void {
  if (node.kind === "leaf") {
    panes.push({ paneId: node.paneId, rect });
    return;
  }
  if (node.direction === "row") {
    const aWidth = rect.width * node.ratio;
    walk(node.a, { ...rect, width: aWidth }, panes, dividers, [...path, "a"]);
    walk(
      node.b,
      { left: rect.left + aWidth, top: rect.top, width: rect.width - aWidth, height: rect.height },
      panes,
      dividers,
      [...path, "b"],
    );
    dividers.push({
      direction: "row",
      path,
      splitRect: rect,
      ratio: node.ratio,
    });
  } else {
    const aHeight = rect.height * node.ratio;
    walk(node.a, { ...rect, height: aHeight }, panes, dividers, [...path, "a"]);
    walk(
      node.b,
      {
        left: rect.left,
        top: rect.top + aHeight,
        width: rect.width,
        height: rect.height - aHeight,
      },
      panes,
      dividers,
      [...path, "b"],
    );
    dividers.push({
      direction: "column",
      path,
      splitRect: rect,
      ratio: node.ratio,
    });
  }
}

/**
 * Lower / upper bound on the ratio so a drag can't fully collapse a
 * pane out of existence. 5 % keeps the doomed pane at least visible
 * enough for the user to find and grab again.
 */
export const MIN_SPLIT_RATIO = 0.05;
export const MAX_SPLIT_RATIO = 0.95;

function clampRatio(ratio: number): number {
  if (ratio < MIN_SPLIT_RATIO) return MIN_SPLIT_RATIO;
  if (ratio > MAX_SPLIT_RATIO) return MAX_SPLIT_RATIO;
  return ratio;
}

/**
 * Update the ratio of the Split at `path` (root is `[]`). Returns the
 * original tree unchanged if the path doesn't resolve to a Split.
 */
export function setRatio(node: LayoutNode, path: SplitPath, ratio: number): LayoutNode {
  const next = clampRatio(ratio);
  if (path.length === 0) {
    if (node.kind !== "split") return node;
    if (Math.abs(node.ratio - next) < 1e-6) return node;
    return { ...node, ratio: next };
  }
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  if (head === "a") {
    const a = setRatio(node.a, rest, ratio);
    return a === node.a ? node : { ...node, a };
  }
  const b = setRatio(node.b, rest, ratio);
  return b === node.b ? node : { ...node, b };
}
