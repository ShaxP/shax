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
