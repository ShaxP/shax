/**
 * Sidebar component tests (M13, spec §19).
 *
 * Covers the sidebar chrome contract:
 *   - both states render at the expected widths
 *   - the toggle button fires onToggle
 *   - the built-in widgets (clock, git branch) render in the slot
 *   - mousedown on ANY sidebar target preventDefault's — including
 *     the toggle button — so clicks never blur whatever owns focus
 *     (spec §D4). preventDefault on mousedown does not cancel the
 *     click event, so the chevron still fires normally on mouseup.
 *   - right-click / middle-click mousedown is left to the browser
 *     default (only the primary button engages focus preservation).
 *
 * Widget rendering + data contracts have their own test files —
 * this file just asserts the slot integration.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { Sidebar } from "./Sidebar";

afterEach(cleanup);

describe("Sidebar / render", () => {
  it("renders the rail (44px) with rail-state widgets when visible=false", () => {
    render(<Sidebar visible={false} onToggle={vi.fn()} />);
    const root = screen.getByTestId("sidebar");
    expect(root.getAttribute("data-visible")).toBe("false");
    expect(root.style.width).toBe("44px");
    // Clock renders in its rail form; git branch is null (no repo in
    // this bare Sidebar render — no FocusedPaneProvider ancestor).
    expect(screen.getByTestId("sidebar-clock-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-git-branch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-git-branch-rail")).not.toBeInTheDocument();
  });

  it("renders expanded (280px) with expanded widgets when visible=true", () => {
    render(<Sidebar visible={true} onToggle={vi.fn()} />);
    const root = screen.getByTestId("sidebar");
    expect(root.getAttribute("data-visible")).toBe("true");
    expect(root.style.width).toBe("280px");
    expect(screen.getByTestId("sidebar-clock")).toBeInTheDocument();
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

  it("mousedown on the toggle BUTTON also preventDefault's; click still fires", () => {
    const onToggle = vi.fn();
    render(<Sidebar visible={true} onToggle={onToggle} />);
    const toggle = screen.getByTestId("sidebar-toggle");
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    toggle.dispatchEvent(ev);
    // Sidebar diverges from BlockList's pattern here: buttons DO get
    // preventDefault so the click doesn't move focus to the button.
    // Native <button> steals focus on click by default — without this,
    // clicking the chevron would blur the prompt strip / assistant
    // textarea. Spec §D4 requires sidebar clicks to preserve focus,
    // and that includes clicks on sidebar buttons.
    expect(ev.defaultPrevented).toBe(true);
    // preventDefault on mousedown does NOT cancel the click event —
    // fireEvent.click still triggers onClick normally.
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
