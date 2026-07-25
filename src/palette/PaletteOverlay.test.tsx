import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PaletteOverlay } from "./PaletteOverlay";
import { _resetRegistryForTests, registerPaneCommand, type PaneContext } from "./registry";

const CTX: PaneContext = { ptyId: "pty-1", cwd: "/tmp", branch: null };

beforeEach(() => {
  _resetRegistryForTests();
});
afterEach(() => {
  _resetRegistryForTests();
});

describe("PaletteOverlay", () => {
  it("renders every registered command that matches the context", () => {
    registerPaneCommand({
      name: "Alpha",
      description: "first",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "" }),
    });
    registerPaneCommand({
      name: "Beta",
      description: "second",
      group: "Debug",
      matcher: () => false,
      render: () => ({ kind: "preview", command: "" }),
    });
    render(<PaletteOverlay ctx={CTX} onClose={() => {}} />);
    const rows = screen.getAllByTestId("palette-overlay-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Alpha");
  });

  it("filters the list by typing in the input", () => {
    registerPaneCommand({
      name: "cd to directory",
      description: "browse",
      group: "Navigation",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "" }),
    });
    registerPaneCommand({
      name: "git checkout",
      description: "switch branch",
      group: "Git",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "" }),
    });
    render(<PaletteOverlay ctx={CTX} onClose={() => {}} />);
    const input = screen.getByTestId("palette-overlay-input");
    fireEvent.change(input, { target: { value: "check" } });
    const rows = screen.getAllByTestId("palette-overlay-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("git checkout");
  });

  it("Enter on a preview-kind command dispatches shax:emit-command with source palette", () => {
    registerPaneCommand({
      name: "Say hi",
      description: "",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "echo hi" }),
    });
    const emits: Array<{ paneId: string; command: string; source: string }> = [];
    const onEmit = (e: Event): void => {
      const detail = (e as CustomEvent<{ paneId: string; command: string; source: string }>).detail;
      emits.push(detail);
    };
    window.addEventListener("shax:emit-command", onEmit);
    const onClose = vi.fn();
    try {
      render(<PaletteOverlay ctx={CTX} onClose={onClose} />);
      const input = screen.getByTestId("palette-overlay-input");
      // Enter on the input opens the preview view.
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByTestId("palette-overlay-preview")).toHaveTextContent("echo hi");
      // Second Enter (global listener) submits.
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(emits).toEqual([{ paneId: "pty-1", command: "echo hi", source: "palette" }]);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("shax:emit-command", onEmit);
    }
  });

  it("Escape from the list closes the overlay; Escape from a preview backs out", () => {
    registerPaneCommand({
      name: "Say hi",
      description: "",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "echo hi" }),
    });
    const onClose = vi.fn();
    render(<PaletteOverlay ctx={CTX} onClose={onClose} />);
    const input = screen.getByTestId("palette-overlay-input");

    // Enter the preview view.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("palette-overlay-preview")).toBeInTheDocument();

    // Escape backs out to the list, does NOT close.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(screen.queryByTestId("palette-overlay-preview")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Escape from the list closes.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("arrow keys move the selection", () => {
    registerPaneCommand({
      name: "One",
      description: "",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "" }),
    });
    registerPaneCommand({
      name: "Two",
      description: "",
      group: "Debug",
      matcher: () => true,
      render: () => ({ kind: "preview", command: "" }),
    });
    render(<PaletteOverlay ctx={CTX} onClose={() => {}} />);
    const input = screen.getByTestId("palette-overlay-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const rows = screen.getAllByTestId("palette-overlay-row");
    expect(rows[1]).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(rows[0]).toHaveAttribute("data-selected", "true");
  });
});
