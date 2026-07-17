import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantDockDivider } from "./AssistantDockDivider";

afterEach(() => cleanup());

/**
 * jsdom doesn't implement `setPointerCapture` / `releasePointerCapture`
 * on Element by default. The drag handler calls both. Stub them per
 * test so a Node.js-based test env doesn't throw when the divider tries
 * to capture the pointer.
 */
function stubPointerCapture(): void {
  const proto = window.HTMLElement.prototype as HTMLElement & {
    setPointerCapture?: (id: number) => void;
    releasePointerCapture?: (id: number) => void;
  };
  if (proto.setPointerCapture === undefined) {
    proto.setPointerCapture = (): void => {};
  }
  if (proto.releasePointerCapture === undefined) {
    proto.releasePointerCapture = (): void => {};
  }
}

function makeHostRef(width: number): React.RefObject<HTMLElement | null> {
  const el = document.createElement("main");
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      top: 0,
      left: 0,
      bottom: 400,
      right: width,
      width,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  const ref = createRef<HTMLElement>();
  (ref as { current: HTMLElement | null }).current = el;
  return ref;
}

describe("AssistantDockDivider", () => {
  it("renders with the correct ARIA role", () => {
    stubPointerCapture();
    const hostRef = makeHostRef(1200);
    render(
      <AssistantDockDivider
        width={420}
        hostRef={hostRef}
        onResize={() => undefined}
        onCommit={() => undefined}
      />,
    );
    const divider = screen.getByTestId("assistant-dock-divider");
    expect(divider).toHaveAttribute("role", "separator");
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
  });

  it("grows the dock when the pointer drags LEFT", () => {
    stubPointerCapture();
    const onResize = vi.fn();
    const onCommit = vi.fn();
    const hostRef = makeHostRef(1200);
    render(
      <AssistantDockDivider
        width={420}
        hostRef={hostRef}
        onResize={onResize}
        onCommit={onCommit}
      />,
    );
    const divider = screen.getByTestId("assistant-dock-divider");
    // Simulate: pointer starts at x=780 (dock left edge for width=420
    // on a 1200-wide host), drags 100px LEFT to x=680. Dock should
    // grow to width=520.
    fireEvent.pointerDown(divider, { button: 0, clientX: 780, pointerId: 1 });
    const pointerMove = new PointerEvent("pointermove", {
      clientX: 680,
      pointerId: 1,
    });
    divider.dispatchEvent(pointerMove);
    expect(onResize).toHaveBeenCalledWith(520);
  });

  it("shrinks the dock when the pointer drags RIGHT", () => {
    stubPointerCapture();
    const onResize = vi.fn();
    const hostRef = makeHostRef(1200);
    render(
      <AssistantDockDivider
        width={420}
        hostRef={hostRef}
        onResize={onResize}
        onCommit={() => undefined}
      />,
    );
    const divider = screen.getByTestId("assistant-dock-divider");
    fireEvent.pointerDown(divider, { button: 0, clientX: 780, pointerId: 1 });
    divider.dispatchEvent(new PointerEvent("pointermove", { clientX: 880, pointerId: 1 }));
    expect(onResize).toHaveBeenCalledWith(320);
  });

  it("clamps to a sensible minimum so the dock never disappears", () => {
    stubPointerCapture();
    const onResize = vi.fn();
    const hostRef = makeHostRef(1200);
    render(
      <AssistantDockDivider
        width={420}
        hostRef={hostRef}
        onResize={onResize}
        onCommit={() => undefined}
      />,
    );
    const divider = screen.getByTestId("assistant-dock-divider");
    fireEvent.pointerDown(divider, { button: 0, clientX: 780, pointerId: 1 });
    // Drag hard to the right — attempts to make the dock ~20px wide.
    divider.dispatchEvent(new PointerEvent("pointermove", { clientX: 1180, pointerId: 1 }));
    // Should clamp to the 260px minimum.
    const lastCall = onResize.mock.calls[onResize.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe(260);
  });

  it("clamps to a maximum so the tab area keeps at least ~200px", () => {
    stubPointerCapture();
    const onResize = vi.fn();
    const hostRef = makeHostRef(1200);
    render(
      <AssistantDockDivider
        width={420}
        hostRef={hostRef}
        onResize={onResize}
        onCommit={() => undefined}
      />,
    );
    const divider = screen.getByTestId("assistant-dock-divider");
    fireEvent.pointerDown(divider, { button: 0, clientX: 780, pointerId: 1 });
    // Drag hard to the left, attempting to eat the whole window.
    divider.dispatchEvent(new PointerEvent("pointermove", { clientX: 20, pointerId: 1 }));
    // Should clamp to hostWidth (1200) - margin (200) = 1000.
    const lastCall = onResize.mock.calls[onResize.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe(1000);
  });

  it("fires onCommit exactly once at pointer-up with the final width", () => {
    stubPointerCapture();
    const onCommit = vi.fn();
    const hostRef = makeHostRef(1200);
    render(
      <AssistantDockDivider
        width={420}
        hostRef={hostRef}
        onResize={() => undefined}
        onCommit={onCommit}
      />,
    );
    const divider = screen.getByTestId("assistant-dock-divider");
    fireEvent.pointerDown(divider, { button: 0, clientX: 780, pointerId: 1 });
    divider.dispatchEvent(new PointerEvent("pointermove", { clientX: 730, pointerId: 1 }));
    divider.dispatchEvent(new PointerEvent("pointermove", { clientX: 680, pointerId: 1 }));
    divider.dispatchEvent(new PointerEvent("pointerup", { clientX: 680, pointerId: 1 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(520);
  });

  it("ignores non-primary buttons (right / middle click on the handle)", () => {
    stubPointerCapture();
    const onResize = vi.fn();
    const hostRef = makeHostRef(1200);
    render(
      <AssistantDockDivider
        width={420}
        hostRef={hostRef}
        onResize={onResize}
        onCommit={() => undefined}
      />,
    );
    const divider = screen.getByTestId("assistant-dock-divider");
    fireEvent.pointerDown(divider, { button: 2, clientX: 780, pointerId: 1 });
    divider.dispatchEvent(new PointerEvent("pointermove", { clientX: 680, pointerId: 1 }));
    expect(onResize).not.toHaveBeenCalled();
  });
});
