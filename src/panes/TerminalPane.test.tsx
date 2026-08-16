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
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
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
      // M10.3/M10.4 writes to `.options.theme`, `.fontFamily`,
      // `.fontSize`, `.fontFeatureSettings`. A bare object here
      // satisfies those assignments in tests without pulling in
      // the full xterm options type.
      options: {} as Record<string, unknown>,
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

// Captures the last `onEvent` handler so tests can fire IPC events into
// the pane (e.g. simulating the shell exiting).
let lastOnEvent: ((e: unknown) => void) | null = null;
const mockSpawnPty = vi.fn().mockImplementation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (_opts: unknown, onEvent: (e: any) => void): Promise<string> => {
    lastOnEvent = onEvent;
    return Promise.resolve("non-tauri");
  },
);
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
    const opts = callArgs?.[0] as { rows: number; cols: number; cwd?: string } | undefined;
    expect(opts?.rows).toBe(24);
    expect(opts?.cols).toBe(80);
    // Without an explicit `initialCwd`, spawn omits the cwd so
    // the shell falls through to its own default (usually $HOME).
    expect(opts?.cwd).toBeUndefined();
  });

  it("forwards initialCwd into the spawn opts (M9.5 follow-up)", async () => {
    render(<TerminalPane initialCwd="/Users/ada/proj" />);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
    const opts = mockSpawnPty.mock.calls[0]?.[0] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBe("/Users/ada/proj");
  });

  it("treats a null initialCwd the same as no initialCwd (no cwd on spawn)", async () => {
    render(<TerminalPane initialCwd={null} />);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
    const opts = mockSpawnPty.mock.calls[0]?.[0] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBeUndefined();
  });

  it("seeds prompt-strip cwd + branch from initialCwd / initialBranch", async () => {
    // Fixes the "restored pane briefly shows blank cwd" flicker.
    // The onMetaChange callback fires with the initial values on
    // mount, before any prompt_ready event arrives.
    const onMetaChange = vi.fn();
    render(
      <TerminalPane
        initialCwd="/Users/ada/proj"
        initialBranch="feature/x"
        onMetaChange={onMetaChange}
      />,
    );
    await vi.waitFor(() => {
      // ahead/behind are null on mount — the OSC 133 A hasn't arrived yet.
      expect(onMetaChange).toHaveBeenCalledWith("/Users/ada/proj", "feature/x", null, null);
    });
  });

  it("updates cwd + branch when a prompt_ready event arrives (OSC 133 A)", async () => {
    // Regression: OSC 133 A used to be invisible to the frontend
    // (backend only emitted BlockStarted on OSC 133 C), so the
    // prompt strip stayed blank until the first command ran.
    // prompt_ready now fires on every prompt and drives the
    // display.
    const onMetaChange = vi.fn();
    render(<TerminalPane onMetaChange={onMetaChange} />);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
    expect(lastOnEvent).not.toBeNull();
    act(() => {
      lastOnEvent?.({
        kind: "prompt_ready",
        cwd: "/tmp/scratch",
        git_branch: "main",
        git_ahead: 2,
        git_behind: 1,
      });
    });
    await vi.waitFor(() => {
      // M13.2: ahead/behind now forward alongside cwd/branch so the
      // sidebar's GitBranchWidget can render `↑n ↓n`.
      expect(onMetaChange).toHaveBeenCalledWith("/tmp/scratch", "main", 2, 1);
    });
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

  it("renders the pane area and prompt strip (chrome lives at App level now)", () => {
    render(<TerminalPane />);
    expect(screen.getByTestId("pane-area")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-strip")).toBeInTheDocument();
    // M2 slice 2.1 moved the title bar and statusline up to App so
    // multiple TerminalPanes can coexist in tabs without each
    // rendering their own copy.
    expect(screen.queryByTestId("title-bar")).toBeNull();
    expect(screen.queryByTestId("statusline")).toBeNull();
  });

  // M12.1 — clicking the empty pane background focuses the prompt so
  // typing goes somewhere honest instead of falling into <body>.
  it("focuses the prompt strip when the user mousedowns on the empty-state hero", () => {
    render(<TerminalPane />);
    const prompt = screen.getByTestId("prompt-strip");
    // Spy on the prompt's focus() so we can assert the handler
    // called it, regardless of whether the mount-effect had already
    // focused the strip.
    const focusSpy = vi.spyOn(prompt, "focus");
    focusSpy.mockClear();
    const empty = screen.getByTestId("block-list-empty");
    fireEvent.mouseDown(empty, { button: 0 });
    expect(focusSpy).toHaveBeenCalled();
  });

  it("does not steal focus from a real button inside the pane (M12.1)", () => {
    // Regression guard: the retarget bails on any natively
    // focusable descendant so a chip click keeps its own focus /
    // click semantics — the button's onClick still runs, and the
    // prompt strip's focus() is NOT called by the handler.
    render(<TerminalPane />);
    const searchChip = screen.getByTestId("block-list-empty-hint-search");
    // Sanity: the M12.1 chips are real <button>s.
    expect(searchChip.tagName).toBe("BUTTON");
    const prompt = screen.getByTestId("prompt-strip");
    const focusSpy = vi.spyOn(prompt, "focus");
    focusSpy.mockClear();
    fireEvent.mouseDown(searchChip, { button: 0 });
    // Our handler did not call prompt.focus() on this click.
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("preventDefaults the qualifying mousedown so browser blur doesn't undo focus (M12 close-out)", () => {
    // Regression guard for the "mode chip flips but typing still
    // doesn't work" bug. mousedown's default behaviour on a non-
    // focusable element is to blur the currently-focused element.
    // That blur races our prompt.focus() call and focus ends up
    // on <body>. preventDefault stops the browser's own focus/
    // blur logic so our focus() call sticks.
    render(<TerminalPane />);
    const empty = screen.getByTestId("block-list-empty");
    const evt = new MouseEvent("mousedown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    empty.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("does NOT preventDefault when clicking a chip button (M12 close-out)", () => {
    // The chip's native click semantics — including any focus ring
    // the browser applies — must not be blocked by our handler.
    render(<TerminalPane />);
    const chip = screen.getByTestId("block-list-empty-hint-search");
    const evt = new MouseEvent("mousedown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    chip.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
  });
});

describe("TerminalPane / dead-shell handling (M2 slice 2.3b)", () => {
  it("shows a 'shell exited' banner when the PTY emits exit, and hides the prompt strip", async () => {
    render(<TerminalPane />);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
    expect(lastOnEvent).not.toBeNull();
    act(() => {
      lastOnEvent?.({ kind: "exit", code: 0 });
    });
    expect(screen.getByTestId("shell-exited-banner")).toHaveTextContent(
      "Shell exited with code 0.",
    );
    // The strip goes away while the shell is dead — there's nothing to
    // type into until the user restarts.
    expect(screen.queryByTestId("prompt-strip")).toBeNull();
  });

  it("clicking 'Restart shell' spawns a new PTY and clears the banner", async () => {
    render(<TerminalPane />);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
    act(() => {
      lastOnEvent?.({ kind: "exit", code: 1 });
    });
    expect(screen.getByTestId("shell-exited-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("shell-restart"));
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId("shell-exited-banner")).toBeNull();
    expect(screen.getByTestId("prompt-strip")).toBeInTheDocument();
  });

  it("⌘⇧R restarts the shell when the banner is showing", async () => {
    render(<TerminalPane />);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
    act(() => {
      lastOnEvent?.({ kind: "exit", code: 0 });
    });
    expect(screen.getByTestId("shell-exited-banner")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: "R", metaKey: true, shiftKey: true });
    });
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId("shell-exited-banner")).toBeNull();
  });

  it("⌘⇧R is a no-op while the shell is alive (no accidental kill)", async () => {
    render(<TerminalPane />);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
    // No exit event — shell is alive. ⌘⇧R should NOT spawn another.
    act(() => {
      fireEvent.keyDown(window, { key: "R", metaKey: true, shiftKey: true });
    });
    // Give the (non-)handler a microtask to settle.
    await Promise.resolve();
    expect(mockSpawnPty).toHaveBeenCalledTimes(1);
  });

  it("renders 'Shell exited.' without a code when the exit carries none", async () => {
    render(<TerminalPane />);
    await vi.waitFor(() => {
      expect(mockSpawnPty).toHaveBeenCalledTimes(1);
    });
    act(() => {
      lastOnEvent?.({ kind: "exit", code: null });
    });
    expect(screen.getByTestId("shell-exited-banner")).toHaveTextContent("Shell exited.");
  });
});
