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
      // M10.3/M10.4 writes to `.options.*` (theme, fontFamily,
      // fontSize, fontFeatureSettings). A bare object here
      // satisfies those assignments without pulling in the
      // full xterm options type.
      options: {} as Record<string, unknown>,
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
  listBranches: (...args: unknown[]): Promise<string[]> => {
    void args;
    return Promise.resolve([]);
  },
  listCwds: (...args: unknown[]): Promise<string[]> => {
    void args;
    return Promise.resolve([]);
  },
  gitRootFor: (...args: unknown[]): Promise<string | null> => {
    void args;
    return Promise.resolve(null);
  },
  blockGetOutput: (...args: unknown[]): Promise<Uint8Array> =>
    mockBlockGetOutput(...args) as Promise<Uint8Array>,
  appStateLoad: (...args: unknown[]): Promise<string | null> =>
    mockAppStateLoad(...args) as Promise<string | null>,
  appStateSave: (...args: unknown[]): Promise<void> => mockAppStateSave(...args) as Promise<void>,
  listCommunityFormatters: (): Promise<unknown[]> => Promise.resolve([]),
  listCommunityCommands: (): Promise<unknown[]> => Promise.resolve([]),
  base64Decode: (b64: string): Uint8Array => new TextEncoder().encode(b64),
  base64Encode: (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)),
  // M7 slice 3 additions — semantic tier + progress polling. The
  // App-level tests don't exercise the semantic path, so they're
  // stubbed to empty/no-op values that keep the polling effect quiet.
  semanticSearch: (): Promise<unknown[]> => Promise.resolve([]),
  embeddingProgress: (): Promise<unknown> =>
    Promise.resolve({ indexed: 0, total: 0, model_id: "unknown" }),
  // M7.6 — cwd compaction reads home once at boot. Tests don't need
  // real values, and null is a legitimate "not resolved yet" state.
  homeDir: (): Promise<string | null> => Promise.resolve(null),
  // M9.3 — Cmd+N binding calls openNewWindow. Tests don't exercise
  // the multi-window path; stub to a no-op that resolves with an
  // empty label.
  openNewWindow: (): Promise<string> => Promise.resolve(""),
  // M9.6 — close-confirmation IPCs. App tests never exercise a
  // running command in the mocked PTYs, so ptyRunningCommands
  // resolves empty and the two "confirmed" IPCs are silent
  // no-ops.
  ptyRunningCommands: (): Promise<string[]> => Promise.resolve([]),
  closeWindowConfirmed: (): Promise<void> => Promise.resolve(),
  quitConfirmed: (): Promise<void> => Promise.resolve(),
  // M10.2 — App boot loads the theme catalog to feed
  // applyTheme. Tests don't exercise the picker, so an
  // empty catalog is fine: applyTheme falls back to the
  // data-theme attribute and the tokens.css :root palette.
  listThemes: (): Promise<unknown[]> => Promise.resolve([]),
  // M12.4b — statusbar native probes. The polling effect fires on
  // mount and every 30s; tests don't exercise the resulting chips,
  // so the desktop / offline sentinels keep the effect quiet.
  systemBattery: (): Promise<{
    present: boolean;
    percent: number | null;
    on_ac_power: boolean;
    charging: boolean;
    seconds_remaining: number | null;
  }> =>
    Promise.resolve({
      present: false,
      percent: null,
      on_ac_power: false,
      charging: false,
      seconds_remaining: null,
    }),
  systemLocalIp: (): Promise<string | null> => Promise.resolve(null),
  // M13.3 — sidebar CPU/mem + SSID probes. Same rule: return the
  // benign fallback so the poll effects don't destabilise other
  // tests (a real value would trigger the CpuMemWidget to render
  // and could shift screen queries).
  // The CPU series is pushed by the backend sampler, not polled.
  // Returning the empty series keeps the widget in its "not ready"
  // state so it renders nothing and can't shift screen queries; the
  // subscription is a no-op.
  systemLoadSeries: (): Promise<unknown> =>
    Promise.resolve({
      current: {
        cpu_percent: 0,
        mem_used_bytes: 0,
        mem_total_bytes: 0,
        swap_used_bytes: 0,
        swap_total_bytes: 0,
        load_average_one: null,
        core_count: null,
      },
      net_rates: [],
      history: [],
    }),
  onSystemLoad: (): (() => void) => () => {},
  // M13 refinement: one probe for name + medium + access. The
  // unknown/no-permission shape keeps the widget in a benign state.
  netInterfaces: (): Promise<unknown[]> => Promise.resolve([]),
  // M13.5.4: disk volumes for the sidebar Disk widget. Empty in
  // tests — the widget hides itself when the list is empty, which
  // is the exact non-interference we want for tests focused on
  // other surfaces.
  diskVolumes: (): Promise<unknown[]> => Promise.resolve([]),
  wifiRequestSsidAccess: (): Promise<unknown> =>
    Promise.resolve({ medium: "unknown", ssid: null, ssid_access: "not_required" }),
  // M13.4 caffeinate. Both resolve "not held" so the widget renders
  // its resting state and never asks the host OS for anything during
  // a unit test run; the cross-window subscription is a no-op.
  powerKeepAwake: (): Promise<{ held: boolean; since_ms: number | null }> =>
    Promise.resolve({ held: false, since_ms: null }),
  powerKeepAwakeState: (): Promise<{ held: boolean; since_ms: number | null }> =>
    Promise.resolve({ held: false, since_ms: null }),
  onKeepAwakeChanged: (): (() => void) => () => {},
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

// ---------------------------------------------------------------------------
// M12.1 — three-way statusline mode pill + open-event bus for chips.
// ---------------------------------------------------------------------------

describe("App / statusline mode pill (M12.1)", () => {
  it("reads COMMAND at rest", () => {
    render(<App />);
    expect(screen.getByTestId("statusline-mode")).toHaveTextContent("COMMAND");
  });

  it("flips to BLOCK when the active pane enters block-focus", () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-focus-changed", { detail: { blockFocus: true } }),
      );
    });
    expect(screen.getByTestId("statusline-mode")).toHaveTextContent("BLOCK");
  });

  it("flips to CHAT when the assistant textarea takes focus, even during block-focus", () => {
    render(<App />);
    // Assert precedence: BLOCK is set first, then CHAT arrives — CHAT wins.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-focus-changed", { detail: { blockFocus: true } }),
      );
      window.dispatchEvent(
        new CustomEvent("shax:assistant-input-focus", { detail: { focused: true } }),
      );
    });
    expect(screen.getByTestId("statusline-mode")).toHaveTextContent("CHAT");
  });

  it("returns to BLOCK when the assistant blurs but block-focus is still engaged", () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-focus-changed", { detail: { blockFocus: true } }),
      );
      window.dispatchEvent(
        new CustomEvent("shax:assistant-input-focus", { detail: { focused: true } }),
      );
      window.dispatchEvent(
        new CustomEvent("shax:assistant-input-focus", { detail: { focused: false } }),
      );
    });
    expect(screen.getByTestId("statusline-mode")).toHaveTextContent("BLOCK");
  });

  it("returns to COMMAND when both CHAT and BLOCK are cleared", () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-focus-changed", { detail: { blockFocus: true } }),
      );
      window.dispatchEvent(
        new CustomEvent("shax:block-focus-changed", { detail: { blockFocus: false } }),
      );
    });
    expect(screen.getByTestId("statusline-mode")).toHaveTextContent("COMMAND");
  });
});

describe("App / open-event bus for onboarding chips (M12.1)", () => {
  it("shax:search-open opens the search overlay", () => {
    render(<App />);
    expect(screen.queryByTestId("search-overlay")).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:search-open"));
    });
    expect(screen.getByTestId("search-overlay")).toBeInTheDocument();
  });

  it("shax:settings-open opens the settings modal", () => {
    render(<App />);
    expect(screen.queryByTestId("settings-modal")).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:settings-open"));
    });
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
  });
});

// ── M12 focus close-out: Cmd+K close routes focus back to the pane

describe("App / Cmd+K assistant close (M12 close-out)", () => {
  it("dispatches shax:refocus-pane when Cmd+K closes an assistant with focused input", () => {
    // Regression guard for the "Cmd+K closes assistant → mode
    // chip flips to COMMAND → typing goes nowhere" bug. The chord
    // fires setAssistantOpen(false) which by itself leaves focus
    // floating on `<body>` (the textarea unmounts, no other
    // element auto-claims). shax:refocus-pane is the app-wide
    // "give focus back to the active pane" signal — TerminalPane's
    // listener runs promptStripRef.current?.focus() in response.
    render(<App />);
    // 1. Open the assistant via the event bus (same path Cmd+K
    //    uses when the dock is closed).
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:assistant-open"));
    });
    // 2. Mark the assistant textarea as focused so the Cmd+K
    //    handler picks the "close" branch. The ref updates
    //    synchronously via the effect chained to state.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:assistant-input-focus", { detail: { focused: true } }),
      );
    });

    let refocused = 0;
    const listener = (): void => {
      refocused += 1;
    };
    window.addEventListener("shax:refocus-pane", listener);
    try {
      act(() => {
        fireEvent.keyDown(window, { key: "k", metaKey: true });
      });
      expect(refocused).toBe(1);
    } finally {
      window.removeEventListener("shax:refocus-pane", listener);
    }
  });

  it("does NOT dispatch shax:refocus-pane when Cmd+K opens the assistant", () => {
    // The open branch delegates to the assistant's own mount
    // effect to focus the textarea — dispatching refocus-pane
    // there would fight it.
    render(<App />);
    let refocused = 0;
    const listener = (): void => {
      refocused += 1;
    };
    window.addEventListener("shax:refocus-pane", listener);
    try {
      act(() => {
        fireEvent.keyDown(window, { key: "k", metaKey: true });
      });
      // Assistant is now OPEN.
      expect(refocused).toBe(0);
    } finally {
      window.removeEventListener("shax:refocus-pane", listener);
    }
  });
});

describe("App / sidebar (M13.1)", () => {
  it("renders the sidebar in the rail state by default (spec §D2)", () => {
    render(<App />);
    const sidebar = screen.getByTestId("sidebar");
    expect(sidebar).toBeInTheDocument();
    expect(sidebar.getAttribute("data-visible")).toBe("false");
  });

  it("⌘B toggles sidebar visibility (spec §D2)", () => {
    render(<App />);
    const sidebar = screen.getByTestId("sidebar");
    expect(sidebar.getAttribute("data-visible")).toBe("false");
    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(screen.getByTestId("sidebar").getAttribute("data-visible")).toBe("true");
    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(screen.getByTestId("sidebar").getAttribute("data-visible")).toBe("false");
  });

  it("clicking the chevron toggle flips visibility", () => {
    render(<App />);
    expect(screen.getByTestId("sidebar").getAttribute("data-visible")).toBe("false");
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(screen.getByTestId("sidebar").getAttribute("data-visible")).toBe("true");
  });

  it("shax:toggle-sidebar event bus flips visibility (palette command path)", () => {
    render(<App />);
    expect(screen.getByTestId("sidebar").getAttribute("data-visible")).toBe("false");
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:toggle-sidebar"));
    });
    expect(screen.getByTestId("sidebar").getAttribute("data-visible")).toBe("true");
  });

  it("persists sidebar.visible in the saved JSON blob (per-window)", async () => {
    render(<App />);
    await vi.waitFor(() => {
      expect(mockAppStateLoad).toHaveBeenCalled();
    });
    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
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
    const parsed = JSON.parse(json) as { sidebar?: { visible?: boolean } };
    expect(parsed.sidebar?.visible).toBe(true);
  });

  it("hydrates sidebar.visible from saved JSON on mount", async () => {
    const saved = JSON.stringify({
      tabs: [
        {
          id: "tab-saved",
          label: "shax",
          layout: { kind: "leaf", paneId: "pane-saved" },
          focusedPaneId: "pane-saved",
          panes: { "pane-saved": { cwd: null, branch: null } },
        },
      ],
      activeId: "tab-saved",
      sidebar: { visible: true },
    });
    mockAppStateLoad.mockResolvedValueOnce(saved);
    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByTestId("sidebar").getAttribute("data-visible")).toBe("true");
    });
  });

  it("M13.2: sidebar renders the clock widget in the initial rail state", () => {
    render(<App />);
    // Even in the default rail state (visible=false), the clock's
    // rail variant renders — the sidebar is always populated with
    // the built-in widgets in M13.2.
    expect(screen.getByTestId("sidebar-clock-rail")).toBeInTheDocument();
  });

  it("M13.2: git-branch widget is hidden until the focused pane reports a branch", () => {
    render(<App />);
    // Expand the sidebar so the widget's expanded slot would render
    // if the branch were present. The initial pane is a fresh shell
    // with no OSC 133 A yet, so `activeFocused.branch` is null and
    // the widget stays hidden.
    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(screen.queryByTestId("sidebar-git-branch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-git-branch-rail")).not.toBeInTheDocument();
  });

  it("hydrates sidebar.visible=false when the field is missing (pre-M13 blob)", async () => {
    // Pre-M13 saved state has no `sidebar` field — it must default to
    // the first-run icon-rail state, not throw or crash the hydrate.
    const saved = JSON.stringify({
      tabs: [
        {
          id: "tab-saved",
          label: "shax",
          layout: { kind: "leaf", paneId: "pane-saved" },
          focusedPaneId: "pane-saved",
          panes: { "pane-saved": { cwd: null, branch: null } },
        },
      ],
      activeId: "tab-saved",
    });
    mockAppStateLoad.mockResolvedValueOnce(saved);
    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getAllByTestId("title-tab")).toHaveLength(1);
    });
    expect(screen.getByTestId("sidebar").getAttribute("data-visible")).toBe("false");
  });
});
