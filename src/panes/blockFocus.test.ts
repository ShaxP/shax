import { describe, expect, it } from "vitest";
import {
  dispatchBlockKey,
  firstBlockId,
  INITIAL_KEY_STATE,
  lastBlockId,
  nextBlockId,
  prevBlockId,
  smartScrollDown,
  smartScrollUp,
  type KeyEvent,
} from "./blockFocus";

const view = (ids: string[]): { ids: string[] } => ({ ids });

describe("block list navigation", () => {
  it("nextBlockId returns the next id, or null at the tail", () => {
    const v = view(["a", "b", "c"]);
    expect(nextBlockId(v, "a")).toBe("b");
    expect(nextBlockId(v, "b")).toBe("c");
    expect(nextBlockId(v, "c")).toBeNull();
  });

  it("nextBlockId from null lands on the first block", () => {
    expect(nextBlockId(view(["a", "b"]), null)).toBe("a");
  });

  it("prevBlockId returns the previous id, or null at the head", () => {
    const v = view(["a", "b", "c"]);
    expect(prevBlockId(v, "c")).toBe("b");
    expect(prevBlockId(v, "b")).toBe("a");
    expect(prevBlockId(v, "a")).toBeNull();
  });

  it("prevBlockId from null lands on the last block", () => {
    expect(prevBlockId(view(["a", "b"]), null)).toBe("b");
  });

  it("firstBlockId / lastBlockId are bounds-safe on an empty list", () => {
    expect(firstBlockId(view([]))).toBeNull();
    expect(lastBlockId(view([]))).toBeNull();
  });
});

describe("smartScroll", () => {
  it("scrolls within when there's room above/below", () => {
    const mid = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 };
    expect(smartScrollDown(mid, 20)).toEqual({ kind: "scroll-within", deltaPx: 20 });
    expect(smartScrollUp(mid, 20)).toEqual({ kind: "scroll-within", deltaPx: -20 });
  });

  it("advances when already at the bottom edge", () => {
    const atBottom = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
    expect(smartScrollDown(atBottom, 20)).toEqual({ kind: "advance", direction: "next" });
  });

  it("advances when already at the top edge", () => {
    const atTop = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    expect(smartScrollUp(atTop, 20)).toEqual({ kind: "advance", direction: "prev" });
  });

  it("treats a null scroll frame as 'no internal scroll, advance immediately'", () => {
    expect(smartScrollDown(null, 20)).toEqual({ kind: "advance", direction: "next" });
    expect(smartScrollUp(null, 20)).toEqual({ kind: "advance", direction: "prev" });
  });

  it("tolerates pixel-fractional 'at-edge' positions", () => {
    // Browser scroll positions can land on non-integer pixels.
    // Anything within EDGE_PX of the bottom counts as at-bottom.
    const nearBottom = { scrollTop: 597, scrollHeight: 1000, clientHeight: 400 };
    expect(smartScrollDown(nearBottom, 20)).toEqual({ kind: "advance", direction: "next" });
  });
});

const ev = (overrides: Partial<KeyEvent>): KeyEvent => ({
  key: overrides.key ?? "",
  shiftKey: overrides.shiftKey ?? false,
  ctrlKey: overrides.ctrlKey ?? false,
  metaKey: overrides.metaKey ?? false,
  altKey: overrides.altKey ?? false,
});

describe("dispatchBlockKey", () => {
  it("Esc exits regardless of pending chord", () => {
    const { action } = dispatchBlockKey(ev({ key: "Escape" }), { pendingG: true });
    expect(action).toEqual({ kind: "exit" });
  });

  it("j / Down → advance-down", () => {
    expect(dispatchBlockKey(ev({ key: "j" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "advance-down",
    });
    expect(dispatchBlockKey(ev({ key: "ArrowDown" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "advance-down",
    });
  });

  it("k / Up → advance-up", () => {
    expect(dispatchBlockKey(ev({ key: "k" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "advance-up",
    });
    expect(dispatchBlockKey(ev({ key: "ArrowUp" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "advance-up",
    });
  });

  it("Space / f → page-down, b → page-up", () => {
    expect(dispatchBlockKey(ev({ key: " " }), INITIAL_KEY_STATE).action).toEqual({
      kind: "page-down",
    });
    expect(dispatchBlockKey(ev({ key: "f" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "page-down",
    });
    expect(dispatchBlockKey(ev({ key: "b" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "page-up",
    });
  });

  it("first key g is a no-op that arms the chord", () => {
    const r = dispatchBlockKey(ev({ key: "g" }), INITIAL_KEY_STATE);
    expect(r.action).toEqual({ kind: "noop" });
    expect(r.state.pendingG).toBe(true);
  });

  it("g g → first-block", () => {
    const r1 = dispatchBlockKey(ev({ key: "g" }), INITIAL_KEY_STATE);
    const r2 = dispatchBlockKey(ev({ key: "g" }), r1.state);
    expect(r2.action).toEqual({ kind: "first-block" });
    expect(r2.state.pendingG).toBe(false);
  });

  it("g j → cancels chord, then dispatches j", () => {
    const r1 = dispatchBlockKey(ev({ key: "g" }), INITIAL_KEY_STATE);
    const r2 = dispatchBlockKey(ev({ key: "j" }), r1.state);
    expect(r2.action).toEqual({ kind: "advance-down" });
    expect(r2.state.pendingG).toBe(false);
  });

  it("G / End → last-block", () => {
    expect(dispatchBlockKey(ev({ key: "G", shiftKey: true }), INITIAL_KEY_STATE).action).toEqual({
      kind: "last-block",
    });
    expect(dispatchBlockKey(ev({ key: "End" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "last-block",
    });
  });

  it("Home → first-block", () => {
    expect(dispatchBlockKey(ev({ key: "Home" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "first-block",
    });
  });

  it("Enter / o → open-modal", () => {
    expect(dispatchBlockKey(ev({ key: "Enter" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "open-modal",
    });
    expect(dispatchBlockKey(ev({ key: "o" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "open-modal",
    });
  });

  it("Tab → toggle-fmt-raw", () => {
    expect(dispatchBlockKey(ev({ key: "Tab" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "toggle-fmt-raw",
    });
  });

  it("y → yank", () => {
    expect(dispatchBlockKey(ev({ key: "y" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "yank",
    });
  });

  it("h / ArrowLeft → collapse", () => {
    expect(dispatchBlockKey(ev({ key: "h" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "collapse",
    });
    expect(dispatchBlockKey(ev({ key: "ArrowLeft" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "collapse",
    });
  });

  it("l / ArrowRight → expand", () => {
    expect(dispatchBlockKey(ev({ key: "l" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "expand",
    });
    expect(dispatchBlockKey(ev({ key: "ArrowRight" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "expand",
    });
  });

  it("unknown keys are no-ops", () => {
    expect(dispatchBlockKey(ev({ key: "p" }), INITIAL_KEY_STATE).action).toEqual({
      kind: "noop",
    });
  });
});
