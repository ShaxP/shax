/**
 * Component tests for BlockRow.
 *
 * Renders running / ok / fail / aborted states and verifies the expand-on-click
 * behaviour: a completed block fetches its output exactly once, and a running
 * block is not expandable.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BlockSummary } from "../lib/ipc";
import { BlockRow } from "./BlockRow";

afterEach(() => cleanup());

function makeBlock(overrides: Partial<BlockSummary> = {}): BlockSummary {
  return {
    id: "block-1",
    command: "echo hi",
    started_at_ms: 1000,
    ended_at_ms: 1500,
    exit_code: 0,
    duration_ms: 500,
    aborted: false,
    ...overrides,
  };
}

describe("BlockRow / status rendering", () => {
  it("renders a ✓ for exit 0", () => {
    render(<BlockRow pty="pty-1" block={makeBlock()} />);
    expect(screen.getByTestId("block-status")).toHaveTextContent("✓ 0");
    expect(screen.getByTestId("block-row")).toHaveAttribute("data-status", "ok");
  });

  it("renders ✗ with the exit code for non-zero", () => {
    render(<BlockRow pty="pty-1" block={makeBlock({ exit_code: 127 })} />);
    expect(screen.getByTestId("block-status")).toHaveTextContent("✗ 127");
    expect(screen.getByTestId("block-row")).toHaveAttribute("data-status", "fail");
  });

  it("renders running state when exit_code is null and not aborted", () => {
    render(
      <BlockRow
        pty="pty-1"
        block={makeBlock({ exit_code: null, ended_at_ms: null, duration_ms: null })}
      />,
    );
    expect(screen.getByTestId("block-status")).toHaveTextContent("running");
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

  it("renders the RAW pill scaffold", () => {
    render(<BlockRow pty="pty-1" block={makeBlock()} />);
    expect(screen.getByTestId("block-raw-pill")).toHaveTextContent("RAW");
  });
});

describe("BlockRow / expand", () => {
  it("fetches output on first expand, decodes bytes, and does not refetch", async () => {
    const getOutput = vi.fn().mockResolvedValue(new TextEncoder().encode("captured bytes"));
    render(<BlockRow pty="pty-1" block={makeBlock()} getOutput={getOutput} />);

    // First click expands and fetches.
    fireEvent.click(screen.getByTestId("block-row").firstChild as Element);
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("block-output")).toHaveTextContent("captured bytes");
    });

    // Collapse, then re-expand — must not refetch.
    fireEvent.click(screen.getByTestId("block-row").firstChild as Element);
    expect(screen.queryByTestId("block-output")).toBeNull();

    fireEvent.click(screen.getByTestId("block-row").firstChild as Element);
    expect(getOutput).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("block-output")).toHaveTextContent("captured bytes");
  });

  it("does not fetch or expand while the block is running", () => {
    const getOutput = vi.fn();
    render(
      <BlockRow
        pty="pty-1"
        block={makeBlock({ exit_code: null, ended_at_ms: null, duration_ms: null })}
        getOutput={getOutput}
      />,
    );
    fireEvent.click(screen.getByTestId("block-row").firstChild as Element);
    expect(getOutput).not.toHaveBeenCalled();
    expect(screen.queryByTestId("block-output")).toBeNull();
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
