/**
 * TerminalPane unit tests (jsdom / Vitest).
 *
 * We are in a non-Tauri context (jsdom, no __TAURI_INTERNALS__), so:
 *   - The IPC module's isTauriContext() returns false.
 *   - spawnPty is mocked to track calls; it resolves to "non-tauri".
 *   - The component renders the data-testid="terminal-pane" wrapper.
 *   - The non-Tauri notice is visible.
 *
 * xterm.js requires canvas which jsdom does not provide, so we mock Terminal
 * and FitAddon to keep tests hermetic and fast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// Mock @xterm/xterm and @xterm/addon-fit before anything imports them.
// vi.mock factories must use regular function syntax to be used as constructors.
// ---------------------------------------------------------------------------

const mockTerminalDispose = vi.fn();
const mockTerminalOnData = vi.fn(() => ({ dispose: vi.fn() }));
const mockTerminalWrite = vi.fn();
const mockTerminalOpen = vi.fn();
const mockTerminalFocus = vi.fn();
const mockFitAddonFit = vi.fn();
const mockLoadAddon = vi.fn();

vi.mock("@xterm/xterm", () => {
  // Must be a real function (not arrow) for `new Terminal(...)` to work.
  function MockTerminal() {
    return {
      loadAddon: mockLoadAddon,
      open: mockTerminalOpen,
      onData: mockTerminalOnData,
      write: mockTerminalWrite,
      dispose: mockTerminalDispose,
      focus: mockTerminalFocus,
      rows: 24,
      cols: 80,
    };
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/addon-fit", () => {
  function MockFitAddon() {
    return { fit: mockFitAddonFit };
  }
  return { FitAddon: MockFitAddon };
});

// ---------------------------------------------------------------------------
// Mock the IPC layer.
// ---------------------------------------------------------------------------

const mockSpawnPty = vi.fn().mockResolvedValue("non-tauri");
const mockKillPty = vi.fn().mockResolvedValue(undefined);
const mockWritePty = vi.fn().mockResolvedValue(undefined);
const mockResizePty = vi.fn().mockResolvedValue(undefined);

const mockListBlocks = vi.fn().mockResolvedValue([]);

vi.mock("../lib/ipc", () => ({
  spawnPty: (...args: unknown[]): Promise<string> => mockSpawnPty(...args) as Promise<string>,
  writePty: (...args: unknown[]): Promise<void> => mockWritePty(...args) as Promise<void>,
  resizePty: (...args: unknown[]): Promise<void> => mockResizePty(...args) as Promise<void>,
  killPty: (...args: unknown[]): Promise<void> => mockKillPty(...args) as Promise<void>,
  listBlocks: (...args: unknown[]): Promise<[]> => mockListBlocks(...args) as Promise<[]>,
  getBlockOutput: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
  base64Decode: (b64: string): Uint8Array => new TextEncoder().encode(b64),
  base64Encode: (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)),
}));

// ---------------------------------------------------------------------------
// Stub ResizeObserver (not available in jsdom).
// ---------------------------------------------------------------------------

class StubResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Import the component under test AFTER the mocks are registered.
// ---------------------------------------------------------------------------

import { TerminalPane } from "./TerminalPane";

describe("TerminalPane", () => {
  it("renders the terminal-pane wrapper element", () => {
    render(<TerminalPane />);
    expect(screen.getByTestId("terminal-pane")).toBeInTheDocument();
  });

  it("shows the non-Tauri notice when __TAURI_INTERNALS__ is absent", () => {
    render(<TerminalPane />);
    expect(screen.getByTestId("non-tauri-notice")).toBeInTheDocument();
    expect(screen.getByText("Not running inside Shax")).toBeInTheDocument();
  });

  it("attempts to spawn a PTY on mount", async () => {
    render(<TerminalPane />);
    // spawnPty is async; let pending microtasks settle.
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
    const callArgs = mockSpawnPty.mock.calls[0];
    // callArgs[0] is SpawnOpts
    const opts = callArgs?.[0] as { rows: number; cols: number } | undefined;
    expect(opts?.rows).toBe(24);
    expect(opts?.cols).toBe(80);
  });

  it("mounts a Terminal into the container div and calls fit()", () => {
    render(<TerminalPane />);
    expect(mockTerminalOpen).toHaveBeenCalledTimes(1);
    expect(mockFitAddonFit).toHaveBeenCalled();
  });

  it("renders the block list alongside the terminal", () => {
    render(<TerminalPane />);
    expect(screen.getByTestId("block-list")).toBeInTheDocument();
    // Empty by default: no blocks have streamed in yet.
    expect(screen.getByTestId("block-list-empty")).toBeInTheDocument();
  });
});
