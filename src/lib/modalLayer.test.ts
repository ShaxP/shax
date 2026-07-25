import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  _modalLayerStackForTests,
  _resetModalLayersForTests,
  anyModalLayerOpen,
  isTopmostModalLayer,
  useModalLayer,
} from "./modalLayer";

afterEach(() => {
  _resetModalLayersForTests();
});

describe("modalLayer", () => {
  it("push / pop lifecycle mirrors mount / unmount", () => {
    const first = renderHook(() => useModalLayer("search-overlay"));
    expect(_modalLayerStackForTests()).toEqual(["search-overlay"]);
    expect(isTopmostModalLayer("search-overlay")).toBe(true);
    expect(anyModalLayerOpen()).toBe(true);

    const second = renderHook(() => useModalLayer("palette-overlay"));
    expect(_modalLayerStackForTests()).toEqual(["search-overlay", "palette-overlay"]);
    expect(isTopmostModalLayer("palette-overlay")).toBe(true);
    expect(isTopmostModalLayer("search-overlay")).toBe(false);

    act(() => second.unmount());
    expect(_modalLayerStackForTests()).toEqual(["search-overlay"]);
    expect(isTopmostModalLayer("search-overlay")).toBe(true);

    act(() => first.unmount());
    expect(_modalLayerStackForTests()).toEqual([]);
    expect(anyModalLayerOpen()).toBe(false);
  });

  it("only the most-recent instance of a duplicate id is popped", () => {
    const a = renderHook(() => useModalLayer("palette-overlay"));
    const b = renderHook(() => useModalLayer("palette-overlay"));
    expect(_modalLayerStackForTests()).toEqual(["palette-overlay", "palette-overlay"]);
    act(() => b.unmount());
    expect(_modalLayerStackForTests()).toEqual(["palette-overlay"]);
    act(() => a.unmount());
    expect(_modalLayerStackForTests()).toEqual([]);
  });

  it("isTopmostModalLayer returns false when nothing is open", () => {
    expect(isTopmostModalLayer("palette-overlay")).toBe(false);
    expect(anyModalLayerOpen()).toBe(false);
  });

  it("mirrors the stack onto window.__shaxModalStack for devtools", () => {
    renderHook(() => useModalLayer("palette-overlay"));
    const mirror = (window as unknown as { __shaxModalStack: string[] }).__shaxModalStack;
    expect(mirror).toEqual(["palette-overlay"]);
  });
});
