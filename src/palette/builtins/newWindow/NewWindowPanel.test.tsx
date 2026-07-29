import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../../../lib/ipc", () => ({
  openNewWindow: vi.fn(),
}));

import { NewWindowPanel } from "./NewWindowPanel";
import { openNewWindow } from "../../../lib/ipc";

const CTX = {
  ptyId: "pty-1",
  cwd: "/tmp",
  branch: null,
  gitRoot: null,
} as const;

beforeEach(() => {
  vi.mocked(openNewWindow).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("NewWindowPanel", () => {
  it("spawns a window on mount and closes the palette on success", async () => {
    vi.mocked(openNewWindow).mockResolvedValueOnce("w-abc123");
    const onSubmit = vi.fn();
    render(<NewWindowPanel ctx={CTX} onSubmit={onSubmit} />);
    // The panel shows a transient status while the IPC resolves.
    expect(screen.getByText(/Opening a new window/)).toBeInTheDocument();
    await waitFor(() => {
      expect(openNewWindow).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith(null);
    });
  });

  it("shows an error message with a Close button when spawn fails", async () => {
    vi.mocked(openNewWindow).mockRejectedValueOnce(new Error("boom"));
    const onSubmit = vi.fn();
    render(<NewWindowPanel ctx={CTX} onSubmit={onSubmit} />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to open new window: boom/)).toBeInTheDocument();
    });
    // Error path leaves the palette open so the user sees the
    // reason — onSubmit is not called until they click Close.
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("palette-new-window-close"));
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it("does not fire onSubmit after unmount (cancels stale promise)", async () => {
    // Never-resolving promise simulates the user closing the
    // palette (Esc) before the backend replies.
    vi.mocked(openNewWindow).mockImplementation(() => new Promise<string>(() => {}));
    const onSubmit = vi.fn();
    const { unmount } = render(<NewWindowPanel ctx={CTX} onSubmit={onSubmit} />);
    unmount();
    // Give the microtask queue a chance to fire any stale callbacks.
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
