/**
 * Component tests for BlockRow.
 *
 * Renders running / ok / fail / aborted states and verifies the expand-on-click
 * behaviour: a completed block fetches its output exactly once, and a running
 * block is not expandable. Also covers the M1.5 anatomy: status-coded left
 * edge, hover action row presence, FMT/RAW pill scaffold, and copy-on-click.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BlockRow } from "./BlockRow";
import type { UiBlock } from "./blockReducer";

afterEach(() => cleanup());

function makeBlock(overrides: Partial<UiBlock> = {}): UiBlock {
  return {
    id: "block-1",
    command: "echo hi",
    cwd: null,
    git_branch: null,
    started_at_ms: 1000,
    ended_at_ms: 1500,
    exit_code: 0,
    duration_ms: 500,
    aborted: false,
    interactive: false,
    ...overrides,
  };
}

describe("BlockRow / status rendering", () => {
  it("renders a ✓ for exit 0", () => {
    render(<BlockRow pty="pty-1" block={makeBlock()} />);
    expect(screen.getByTestId("block-status")).toHaveTextContent("✓ 0");
    expect(screen.getByTestId("block-row")).toHaveAttribute("data-status", "ok");
  });

  it("renders ✗ exit N for a non-zero exit", () => {
    render(<BlockRow pty="pty-1" block={makeBlock({ exit_code: 127 })} />);
    expect(screen.getByTestId("block-status")).toHaveTextContent("✗ exit 127");
    expect(screen.getByTestId("block-row")).toHaveAttribute("data-status", "fail");
  });

  it("renders spinner + running text when exit_code is null and not aborted", () => {
    render(
      <BlockRow
        pty="pty-1"
        block={makeBlock({ exit_code: null, ended_at_ms: null, duration_ms: null })}
      />,
    );
    expect(screen.getByTestId("block-status")).toHaveTextContent("running");
    expect(screen.getByTestId("block-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("block-row")).toHaveAttribute("data-status", "running");
  });

  it("renders the aborted state even when exit_code is set", () => {
    // double-C closes a block with exit_code=-1 AND aborted=true; aborted wins
    // in the UI because that's the truer signal.
    render(<BlockRow pty="pty-1" block={makeBlock({ aborted: true, exit_code: -1 })} />);
    expect(screen.getByTestId("block-status")).toHaveTextContent("aborted");
    expect(screen.getByTestId("block-row")).toHaveAttribute("data-status", "aborted");
  });

  it("falls back to (no command) when integration didn't report one", () => {
    render(<BlockRow pty="pty-1" block={makeBlock({ command: null })} />);
    expect(screen.getByTestId("block-command")).toHaveTextContent("(no command)");
  });
});

describe("BlockRow / anatomy", () => {
  it("renders the status-coded left edge for completed blocks", () => {
    render(<BlockRow pty="pty-1" block={makeBlock()} />);
    expect(screen.getByTestId("block-edge")).toBeInTheDocument();
  });

  it("renders the FMT/RAW pill group for completed blocks", () => {
    render(<BlockRow pty="pty-1" block={makeBlock()} />);
    expect(screen.getByTestId("block-fmt-raw")).toBeInTheDocument();
    expect(screen.getByTestId("block-raw-pill")).toHaveTextContent("RAW");
    expect(screen.getByTestId("block-fmt-pill")).toHaveTextContent("FMT");
  });

  it("hides the FMT/RAW pill while the block is still running", () => {
    render(
      <BlockRow
        pty="pty-1"
        block={makeBlock({ exit_code: null, ended_at_ms: null, duration_ms: null })}
      />,
    );
    expect(screen.queryByTestId("block-fmt-raw")).toBeNull();
  });

  it("renders the hover action row", () => {
    render(<BlockRow pty="pty-1" block={makeBlock()} />);
    expect(screen.getByTestId("block-actions")).toBeInTheDocument();
  });
});

describe("BlockRow / copy action", () => {
  it("writes the block's command to the clipboard when copy is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<BlockRow pty="pty-1" block={makeBlock({ command: "echo hi" })} />);
    const actions = screen.getByTestId("block-actions");
    const copy = actions.querySelector('[title="copy"]') as HTMLElement;
    fireEvent.click(copy);

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("echo hi");
    });
  });

  it("does nothing if the command is unknown", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });

    render(<BlockRow pty="pty-1" block={makeBlock({ command: null })} />);
    const actions = screen.getByTestId("block-actions");
    const copy = actions.querySelector('[title="copy"]') as HTMLElement;
    fireEvent.click(copy);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("BlockRow / view action (M4 slice 4.1)", () => {
  it("dispatches a `shax:open-viewer` event when the view icon is clicked", () => {
    const handler = vi.fn();
    window.addEventListener("shax:open-viewer", handler);
    try {
      render(<BlockRow pty="pty-9" block={makeBlock({ command: "cat README.md" })} />);
      fireEvent.click(screen.getByTestId("block-view"));
      expect(handler).toHaveBeenCalled();
      const detail = (handler.mock.calls[0]?.[0] as CustomEvent).detail as {
        pty: string;
        block: { command: string | null };
      };
      expect(detail.pty).toBe("pty-9");
      expect(detail.block.command).toBe("cat README.md");
    } finally {
      window.removeEventListener("shax:open-viewer", handler);
    }
  });
});

describe("BlockRow / expand", () => {
  it("fetches output on first expand, decodes bytes, and does not refetch", async () => {
    const getOutput = vi.fn().mockResolvedValue(new TextEncoder().encode("captured bytes"));
    render(<BlockRow pty="pty-1" block={makeBlock()} getOutput={getOutput} />);

    // First click expands and fetches.
    fireEvent.click(screen.getByTestId("block-header"));
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("block-output")).toHaveTextContent("captured bytes");
    });

    // Collapse, then re-expand — must not refetch.
    fireEvent.click(screen.getByTestId("block-header"));
    expect(screen.queryByTestId("block-output")).toBeNull();

    fireEvent.click(screen.getByTestId("block-header"));
    expect(getOutput).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("block-output")).toHaveTextContent("captured bytes");
  });

  it("does not fetch from IPC for a running block — its bytes stream in via liveOutput", () => {
    const getOutput = vi.fn();
    render(
      <BlockRow
        pty="pty-1"
        block={makeBlock({ exit_code: null, ended_at_ms: null, duration_ms: null })}
        getOutput={getOutput}
      />,
    );
    fireEvent.click(screen.getByTestId("block-header"));
    expect(getOutput).not.toHaveBeenCalled();
  });
});

describe("BlockRow / live output", () => {
  it("renders the liveOutput buffer inline for running blocks", () => {
    const live = new TextEncoder().encode("streaming…");
    render(
      <BlockRow
        pty="pty-1"
        block={makeBlock({ exit_code: null, ended_at_ms: null, duration_ms: null })}
        liveOutput={live}
      />,
    );
    expect(screen.getByTestId("block-output")).toHaveTextContent("streaming…");
  });

  it("renders liveOutput inline by default for completed blocks (no IPC fetch)", () => {
    const live = new TextEncoder().encode("cached bytes");
    const getOutput = vi.fn();
    render(<BlockRow pty="pty-1" block={makeBlock()} liveOutput={live} getOutput={getOutput} />);
    // Completed block with live bytes is open by default — output shown
    // immediately, no IPC round-trip.
    expect(screen.getByTestId("block-output")).toHaveTextContent("cached bytes");
    expect(getOutput).not.toHaveBeenCalled();
  });

  it("lets the user collapse a completed block with live bytes by clicking the header", () => {
    const live = new TextEncoder().encode("cached bytes");
    render(<BlockRow pty="pty-1" block={makeBlock()} liveOutput={live} />);
    expect(screen.getByTestId("block-output")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("block-header"));
    expect(screen.queryByTestId("block-output")).toBeNull();

    fireEvent.click(screen.getByTestId("block-header"));
    expect(screen.getByTestId("block-output")).toHaveTextContent("cached bytes");
  });
});

describe("BlockRow / metadata line", () => {
  it("renders cwd · branch when both are present", () => {
    render(
      <BlockRow pty="pty-1" block={makeBlock({ cwd: "/Users/me/repo", git_branch: "feat/x" })} />,
    );
    const meta = screen.getByTestId("block-meta");
    expect(meta).toHaveTextContent("/Users/me/repo");
    expect(meta).toHaveTextContent("feat/x");
  });

  it("renders only the cwd when no branch is available", () => {
    render(<BlockRow pty="pty-1" block={makeBlock({ cwd: "/tmp", git_branch: null })} />);
    const meta = screen.getByTestId("block-meta");
    expect(meta).toHaveTextContent("/tmp");
    // The · separator only shows when both are present.
    expect(meta.textContent).not.toContain("·");
  });

  it("omits the metadata line entirely when both are null", () => {
    render(<BlockRow pty="pty-1" block={makeBlock({ cwd: null, git_branch: null })} />);
    expect(screen.queryByTestId("block-meta")).toBeNull();
  });
});

describe("BlockRow / duration", () => {
  it("renders frozen duration_ms for completed blocks", () => {
    render(<BlockRow pty="pty-1" block={makeBlock({ duration_ms: 1840 })} />);
    expect(screen.getByTestId("block-duration")).toHaveTextContent("1.84s");
  });

  it("renders live elapsed time for running blocks", () => {
    // started 12 ms before "now"; running state because exit_code is null.
    const block = makeBlock({
      started_at_ms: 988,
      ended_at_ms: null,
      exit_code: null,
      duration_ms: null,
    });
    render(<BlockRow pty="pty-1" block={block} now={() => 1000} />);
    expect(screen.getByTestId("block-duration")).toHaveTextContent("12ms");
  });
});

describe("BlockRow / interactive sessions", () => {
  it("hides the output `<pre>` and shows an 'interactive session' label", () => {
    // vim / htop / btop / less — alt-screen bytes are unusable as flow
    // text. The row stays compact: command + status, plus a small label.
    const block = makeBlock({
      command: "vim foo.txt",
      interactive: true,
    });
    render(<BlockRow pty="pty-1" block={block} liveOutput={new Uint8Array([1, 2, 3])} />);
    expect(screen.queryByTestId("block-output")).toBeNull();
    expect(screen.getByTestId("block-interactive-label")).toHaveTextContent("interactive session");
  });

  it("non-interactive blocks still show output", () => {
    const block = makeBlock({
      command: "ls",
      interactive: false,
    });
    render(
      <BlockRow
        pty="pty-1"
        block={block}
        liveOutput={new TextEncoder().encode("file1\nfile2\n")}
      />,
    );
    expect(screen.getByTestId("block-output")).toHaveTextContent("file1");
    expect(screen.queryByTestId("block-interactive-label")).toBeNull();
  });
});
