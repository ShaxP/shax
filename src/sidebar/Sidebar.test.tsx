/**
 * Sidebar component tests (M13.1, spec §19).
 *
 * Covers the chrome-only Phase-1 contract:
 *   - both states render at the expected widths
 *   - the toggle button fires onToggle
 *   - expanded state carries the "no widgets yet" placeholder
 *   - rail state does not carry the placeholder
 *   - mousedown on non-focusable sidebar chrome preventDefault's,
 *     matching the BlockList / TitleBar focus-preservation pattern
 *   - mousedown on the toggle button does NOT preventDefault (so
 *     the browser still fires the click event on mouseup)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { Sidebar } from "./Sidebar";

afterEach(cleanup);

describe("Sidebar / render", () => {
  it("renders the rail (44px) when visible=false and no placeholder", () => {
    render(<Sidebar visible={false} onToggle={vi.fn()} />);
    const root = screen.getByTestId("sidebar");
    expect(root.getAttribute("data-visible")).toBe("false");
    expect(root.style.width).toBe("44px");
    // Widget slot is empty in the rail state — no "No widgets yet".
    expect(screen.queryByText("No widgets yet")).not.toBeInTheDocument();
  });

  it("renders expanded (280px) with the placeholder when visible=true", () => {
    render(<Sidebar visible={true} onToggle={vi.fn()} />);
    const root = screen.getByTestId("sidebar");
    expect(root.getAttribute("data-visible")).toBe("true");
    expect(root.style.width).toBe("280px");
    expect(screen.getByText("No widgets yet")).toBeInTheDocument();
  });

  it("labels the toggle button by current state (aria-label + title)", () => {
    const { rerender } = render(<Sidebar visible={false} onToggle={vi.fn()} />);
    let toggle = screen.getByTestId("sidebar-toggle");
    expect(toggle).toHaveAttribute("aria-label", "Expand sidebar");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.getAttribute("title")).toContain("⌘B");

    rerender(<Sidebar visible={true} onToggle={vi.fn()} />);
    toggle = screen.getByTestId("sidebar-toggle");
    expect(toggle).toHaveAttribute("aria-label", "Collapse sidebar");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

describe("Sidebar / toggle", () => {
  it("clicking the chevron fires onToggle", () => {
    const onToggle = vi.fn();
    render(<Sidebar visible={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("Sidebar / focus preservation (spec §D4)", () => {
  it("mousedown on the sidebar background preventDefault's (non-focusable target)", () => {
    render(<Sidebar visible={true} onToggle={vi.fn()} />);
    // The widget slot div itself is a non-focusable — click there.
    const slot = screen.getByTestId("sidebar-widgets");
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    slot.dispatchEvent(ev);
    // Load-bearing: preventDefault stops the browser's default blur
    // behaviour so whatever owns focus keeps it after the click.
    expect(ev.defaultPrevented).toBe(true);
  });

  it("mousedown on the toggle BUTTON does NOT preventDefault (click still fires)", () => {
    const onToggle = vi.fn();
    render(<Sidebar visible={true} onToggle={onToggle} />);
    const toggle = screen.getByTestId("sidebar-toggle");
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    toggle.dispatchEvent(ev);
    // Buttons opt out of the focus-preservation preventDefault — the
    // BlockList pattern excludes `button, a[href], input, textarea, select`
    // so their clicks still complete. Sidebar reuses the same rule.
    expect(ev.defaultPrevented).toBe(false);
    // And the click still resolves normally.
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("ignores right-click / middle-click mousedown (button !== 0)", () => {
    render(<Sidebar visible={true} onToggle={vi.fn()} />);
    const slot = screen.getByTestId("sidebar-widgets");
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
    slot.dispatchEvent(ev);
    // Only the primary button engages the focus-preservation preventDefault.
    // Right-click / middle-click behaviour is left to the browser default.
    expect(ev.defaultPrevented).toBe(false);
  });
});
