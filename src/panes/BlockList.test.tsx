/**
 * Component tests for BlockList.
 *
 * Verifies empty state, count header, and list rendering with mixed states.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BlockSummary } from "../lib/ipc";
import { BlockList } from "./BlockList";

afterEach(() => cleanup());

function makeBlock(overrides: Partial<BlockSummary> = {}): BlockSummary {
  return {
    id: "block-1",
    command: "ls",
    started_at_ms: 1,
    ended_at_ms: 2,
    exit_code: 0,
    duration_ms: 1,
    aborted: false,
    ...overrides,
  };
}

describe("BlockList", () => {
  it("renders the empty-state hint when there are no blocks", () => {
    render(<BlockList pty={null} blocks={[]} />);
    expect(screen.getByTestId("block-list")).toBeInTheDocument();
    expect(screen.getByTestId("block-list-empty")).toBeInTheDocument();
    expect(screen.getByTestId("block-list-empty")).toHaveTextContent(/Run a command/i);
  });

  it("renders a row per block and shows the count in the header", () => {
    const blocks = [
      makeBlock({ id: "a", command: "ls" }),
      makeBlock({ id: "b", command: "echo no", exit_code: 1, duration_ms: 5 }),
      makeBlock({ id: "c", command: null, aborted: true, exit_code: null }),
    ];
    render(<BlockList pty="pty-1" blocks={blocks} />);
    const rows = screen.getAllByTestId("block-row");
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId("block-list").textContent).toMatch(/blocks · 3/);
  });
});
