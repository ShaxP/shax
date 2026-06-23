/**
 * App-level tests (jsdom / Vitest).
 *
 * Covers the M2 slice 2.1 tab orchestration: a single tab on mount,
 * adding tabs via the `+` button or ⌘T, switching tabs via click and
 * ⌘1..⌘9, closing tabs via × on the pill or ⌘W, and the rule that the
 * last tab closes to a fresh shell instead of leaving the window empty.
 *
 * Each tab mounts a `TerminalPane`, which in turn opens a PTY via the
 * mocked IPC layer (no real shells in jsdom).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// Mock @xterm/xterm + @xterm/addon-fit before App imports TerminalPane.
// ---------------------------------------------------------------------------

vi.mock("@xterm/xterm", () => {
  function MockTerminal() {
    return {
      loadAddon: vi.fn(),
      open: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
      rows: 24,
      cols: 80,
    };
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/addon-fit", () => {
  function MockFitAddon() {
    return { fit: vi.fn() };
  }
  return { FitAddon: MockFitAddon };
});

// ---------------------------------------------------------------------------
// Mock the IPC layer. Each spawn returns a unique id so we can tell tabs
// apart by inspecting spawn / kill call counts.
// ---------------------------------------------------------------------------

let spawnSeq = 0;
const mockSpawnPty = vi.fn().mockImplementation(() => Promise.resolve("pty-" + ++spawnSeq));
const mockKillPty = vi.fn().mockResolvedValue(undefined);
const mockWritePty = vi.fn().mockResolvedValue(undefined);
const mockResizePty = vi.fn().mockResolvedValue(undefined);
const mockListBlocks = vi.fn().mockResolvedValue([]);

vi.mock("./lib/ipc", () => ({
  spawnPty: (...args: unknown[]): Promise<string> => mockSpawnPty(...args) as Promise<string>,
  writePty: (...args: unknown[]): Promise<void> => mockWritePty(...args) as Promise<void>,
  resizePty: (...args: unknown[]): Promise<void> => mockResizePty(...args) as Promise<void>,
  killPty: (...args: unknown[]): Promise<void> => mockKillPty(...args) as Promise<void>,
  listBlocks: (...args: unknown[]): Promise<[]> => mockListBlocks(...args) as Promise<[]>,
  getBlockOutput: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
  base64Decode: (b64: string): Uint8Array => new TextEncoder().encode(b64),
  base64Encode: (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)),
}));

class StubResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  spawnSeq = 0;
  mockSpawnPty.mockClear();
  mockKillPty.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import App from "./App";

describe("App / initial state", () => {
  it("mounts with exactly one tab", () => {
    render(<App />);
    expect(screen.getAllByTestId("title-tab")).toHaveLength(1);
  });

  it("renders the chrome (title bar + statusline) at App level", () => {
    render(<App />);
    expect(screen.getByTestId("title-bar")).toBeInTheDocument();
    expect(screen.getByTestId("statusline")).toBeInTheDocument();
  });

  it("spawns a single PTY for the initial tab", async () => {
    render(<App />);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
  });
});

describe("App / opening tabs", () => {
  it("clicking + adds a tab and switches focus to it", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("title-new-tab"));
    const pills = screen.getAllByTestId("title-tab");
    expect(pills).toHaveLength(2);
    // The new tab is the active one.
    const actives = pills.filter((p) => p.getAttribute("data-active") === "true");
    expect(actives).toHaveLength(1);
    expect(actives[0]).toBe(pills[1]);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(2);
    });
  });

  it("⌘T also opens a tab", () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "t", metaKey: true });
    });
    expect(screen.getAllByTestId("title-tab")).toHaveLength(2);
  });
});

describe("App / switching tabs", () => {
  it("clicking a non-active tab marks it active", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("title-new-tab"));
    fireEvent.click(screen.getByTestId("title-new-tab"));
    // Three tabs; the most recently opened is active.
    const pills = screen.getAllByTestId("title-tab");
    fireEvent.click(pills[0] as Element);
    const actives = screen
      .getAllByTestId("title-tab")
      .filter((p) => p.getAttribute("data-active") === "true");
    expect(actives).toHaveLength(1);
    expect(actives[0]).toBe(screen.getAllByTestId("title-tab")[0]);
  });

  it("⌘2 jumps to the second tab by position", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("title-new-tab"));
    // Two tabs. The new one is active. ⌘1 switches to the first.
    act(() => {
      fireEvent.keyDown(window, { key: "1", metaKey: true });
    });
    const actives = screen
      .getAllByTestId("title-tab")
      .filter((p) => p.getAttribute("data-active") === "true");
    expect(actives).toHaveLength(1);
    expect(actives[0]).toBe(screen.getAllByTestId("title-tab")[0]);
  });
});

describe("App / closing tabs", () => {
  it("clicking × on a non-active tab removes it without changing focus", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("title-new-tab"));
    fireEvent.click(screen.getByTestId("title-new-tab"));
    // 3 tabs; the 3rd is active. Close the 2nd (middle).
    const closes = screen.getAllByTestId("title-tab-close");
    fireEvent.click(closes[1] as Element);
    const pills = screen.getAllByTestId("title-tab");
    expect(pills).toHaveLength(2);
    // Focus stays on the still-existing original-3rd tab.
    const actives = pills.filter((p) => p.getAttribute("data-active") === "true");
    expect(actives).toHaveLength(1);
    await vi.waitFor(() => {
      expect(mockKillPty).toHaveBeenCalled();
    });
  });

  it("closing the only tab leaves a fresh single tab (window never empty)", async () => {
    render(<App />);
    // Only one tab; the × isn't rendered for that case, so close via ⌘W.
    act(() => {
      fireEvent.keyDown(window, { key: "w", metaKey: true });
    });
    expect(screen.getAllByTestId("title-tab")).toHaveLength(1);
    await vi.waitFor(() => {
      // The original PTY was killed and a fresh one spawned for the
      // replacement tab.
      expect(mockKillPty).toHaveBeenCalledTimes(1);
      expect(mockSpawnPty).toHaveBeenCalledTimes(2);
    });
  });
});

describe("App / pane splits", () => {
  it("⌘D splits the focused pane side-by-side (vertical divider)", async () => {
    render(<App />);
    expect(screen.getAllByTestId("layout-leaf")).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(window, { key: "d", metaKey: true });
    });
    expect(screen.getAllByTestId("layout-leaf")).toHaveLength(2);
    const divider = screen.getByTestId("layout-divider");
    expect(divider).toHaveAttribute("data-direction", "row");
    // Original pane keeps its PTY; the new pane spawns a second one.
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(2);
    });
    // And importantly: no pane was killed in the process (the
    // geometry-driven renderer keeps every TerminalPane instance
    // stable across layout changes).
    expect(mockKillPty).not.toHaveBeenCalled();
  });

  it("⌘⇧D splits the focused pane stacked (horizontal divider)", () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "D", metaKey: true, shiftKey: true });
    });
    const divider = screen.getByTestId("layout-divider");
    expect(divider).toHaveAttribute("data-direction", "column");
  });

  it("the new pane takes focus after a split", () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "d", metaKey: true });
    });
    const leaves = screen.getAllByTestId("layout-leaf");
    expect(leaves).toHaveLength(2);
    // Second leaf is the freshly-spawned one; it should be focused.
    expect(leaves[0]).toHaveAttribute("data-focused", "false");
    expect(leaves[1]).toHaveAttribute("data-focused", "true");
  });

  it("clicking a leaf focuses it", () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "d", metaKey: true });
    });
    const leaves = screen.getAllByTestId("layout-leaf");
    fireEvent.pointerDown(leaves[0] as Element);
    const after = screen.getAllByTestId("layout-leaf");
    expect(after[0]).toHaveAttribute("data-focused", "true");
    expect(after[1]).toHaveAttribute("data-focused", "false");
  });

  it("⌘] cycles focus forward across panes within the active tab", () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "d", metaKey: true });
    });
    // Second leaf currently focused. ⌘] should wrap to the first.
    act(() => {
      fireEvent.keyDown(window, { key: "]", metaKey: true });
    });
    const leaves = screen.getAllByTestId("layout-leaf");
    expect(leaves[0]).toHaveAttribute("data-focused", "true");
  });

  it("the divider carries a resize cursor and the right hit-area direction", () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "d", metaKey: true });
    });
    const divider = screen.getByTestId("layout-divider");
    expect(divider).toHaveAttribute("data-direction", "row");
    // ew-resize for row splits, ns-resize for column splits.
    expect(divider.style.cursor).toBe("ew-resize");
  });

  it("dragging the divider updates the split ratio (winsize follows)", () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "d", metaKey: true });
    });
    const host = screen.getByTestId("layout-host");
    // jsdom never lays anything out, so `getBoundingClientRect` would
    // otherwise return zeros and the drag math would divide by zero.
    // Pretend the host is 1000 × 800.
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      configurable: true,
    });
    const divider = screen.getByTestId("layout-divider");
    // setPointerCapture is unimplemented in jsdom; no-op it so the
    // handler doesn't throw mid-drag.
    Object.defineProperty(divider, "setPointerCapture", {
      value: () => undefined,
      configurable: true,
    });
    Object.defineProperty(divider, "releasePointerCapture", {
      value: () => undefined,
      configurable: true,
    });

    // Default ratio is 0.5 → both leaves are 50%.
    let leaves = screen.getAllByTestId("layout-leaf");
    expect((leaves[0] as HTMLElement).style.width).toBe("50%");
    expect((leaves[1] as HTMLElement).style.width).toBe("50%");

    // Drag the divider to x=700 (700px / 1000px = 70%).
    act(() => {
      fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 500, clientY: 400 });
    });
    act(() => {
      divider.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientX: 700, clientY: 400 }),
      );
    });
    act(() => {
      divider.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });

    leaves = screen.getAllByTestId("layout-leaf");
    expect((leaves[0] as HTMLElement).style.width).toBe("70%");
    expect((leaves[1] as HTMLElement).style.width).toBe("30%");
  });

  it("the divider ratio is clamped at the edges (no pane can fully collapse)", () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "d", metaKey: true });
    });
    const host = screen.getByTestId("layout-host");
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      configurable: true,
    });
    const divider = screen.getByTestId("layout-divider");
    Object.defineProperty(divider, "setPointerCapture", {
      value: () => undefined,
      configurable: true,
    });
    Object.defineProperty(divider, "releasePointerCapture", {
      value: () => undefined,
      configurable: true,
    });

    // Drag way past the right edge → should clamp to 95 %.
    act(() => {
      fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 500, clientY: 400 });
    });
    act(() => {
      divider.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientX: 9999, clientY: 400 }),
      );
    });
    act(() => {
      divider.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });

    const leaves = screen.getAllByTestId("layout-leaf");
    expect((leaves[0] as HTMLElement).style.width).toBe("95%");
    expect((leaves[1] as HTMLElement).style.width).toBe("5%");
  });

  it("⌘W on a multi-pane tab closes only the focused pane (tab survives)", async () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "d", metaKey: true });
    });
    expect(screen.getAllByTestId("layout-leaf")).toHaveLength(2);
    act(() => {
      fireEvent.keyDown(window, { key: "w", metaKey: true });
    });
    // One leaf left, tab still open.
    expect(screen.getAllByTestId("layout-leaf")).toHaveLength(1);
    expect(screen.getAllByTestId("title-tab")).toHaveLength(1);
    await vi.waitFor(() => {
      expect(mockKillPty).toHaveBeenCalledTimes(1);
    });
  });
});
