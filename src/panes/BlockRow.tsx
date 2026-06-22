/**
 * BlockRow — one block in the BlockList.
 *
 * Renders:
 *   - the typed command (or "(no command)" when integration didn't report it),
 *   - a status pill (running / ✓ exit 0 / ✗ exit N / aborted),
 *   - duration (live for running blocks, frozen on completion),
 *   - a static "RAW" pill that scaffolds the M4 formatter toggle (no behavior).
 *
 * Completed blocks are expandable. On first expand the captured output bytes
 * are fetched via `getBlockOutput` and rendered as monospace text; the bytes
 * are cached in component state, so re-collapsing and re-expanding does not
 * refetch. Running blocks are not expandable (their bytes live in xterm via
 * path-one passthrough; path-two rendering only begins after OSC 133 D).
 *
 * The `getOutput` and `now` props let tests inject deterministic seams.
 *
 * Wrapped in `React.memo` so unchanged rows skip re-render when the BlockList
 * re-renders for an unrelated event. With a couple of hundred historical
 * blocks seeded on boot, naive re-rendering was starving the main thread
 * enough to back up the Tauri IPC channel — output events queued behind the
 * reconciler and xterm appeared to freeze after the initial prompt. The
 * reducer creates a new BlockSummary object only for the slot that changed,
 * so default shallow-compare memoization is enough.
 */

import { memo, useEffect, useState } from "react";
import type { BlockSummary, PtyId } from "../lib/ipc";
import { formatDuration } from "./blockFormat";

const TEXT_DECODER = new TextDecoder();

export interface BlockRowProps {
  pty: PtyId;
  block: BlockSummary;
  /** Injected for tests; defaults to the real IPC client. */
  getOutput?: (pty: PtyId, blockId: string) => Promise<Uint8Array>;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
}

type Status = "running" | "ok" | "fail" | "aborted";

function statusFor(block: BlockSummary): Status {
  if (block.aborted) return "aborted";
  if (block.exit_code === null) return "running";
  return block.exit_code === 0 ? "ok" : "fail";
}

function statusColor(status: Status): string {
  switch (status) {
    case "ok":
      return "var(--green)";
    case "fail":
      return "var(--red)";
    case "running":
    case "aborted":
      return "var(--fg-dim)";
  }
}

function statusLabel(block: BlockSummary): string {
  switch (statusFor(block)) {
    case "running":
      return "running";
    case "ok":
      return "✓ 0";
    case "fail":
      return `✗ ${block.exit_code}`;
    case "aborted":
      return "aborted";
  }
}

/**
 * Hook returning a millisecond timestamp that updates roughly every second
 * while `running` is true. Used to drive the live duration counter on a
 * currently-executing block without forcing a full re-render of siblings.
 */
function useElapsedNow(running: boolean, now: () => number): number {
  const [tick, setTick] = useState<number>(now());
  useEffect(() => {
    if (!running) return;
    const handle = window.setInterval(() => setTick(now()), 1000);
    return () => window.clearInterval(handle);
  }, [running, now]);
  return tick;
}

function BlockRowInner({
  pty,
  block,
  getOutput,
  now = Date.now,
}: BlockRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [output, setOutput] = useState<string | null>(null);
  const [fetched, setFetched] = useState<boolean>(false);

  const status = statusFor(block);
  const isRunning = status === "running";
  const isExpandable = !isRunning;

  const nowMs = useElapsedNow(isRunning, now);

  // Live duration for running blocks; frozen duration_ms for completed.
  const elapsedMs: number | null = isRunning
    ? Math.max(0, nowMs - block.started_at_ms)
    : block.duration_ms;

  const toggleExpand = (): void => {
    if (!isExpandable) return;
    const next = !expanded;
    setExpanded(next);
    if (next && !fetched && getOutput !== undefined) {
      setFetched(true);
      void getOutput(pty, block.id).then((bytes) => {
        setOutput(TEXT_DECODER.decode(bytes));
      });
    }
  };

  return (
    <div
      data-testid="block-row"
      data-block-id={block.id}
      data-status={status}
      style={{
        borderBottom: "1px solid var(--border)",
        padding: "8px 10px",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        color: "var(--fg)",
      }}
    >
      <div
        onClick={toggleExpand}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: isExpandable ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        <span style={{ color: "var(--fg-faint)" }}>&gt;</span>
        <span
          data-testid="block-command"
          style={{
            flex: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {block.command ?? <em style={{ color: "var(--fg-faint)" }}>(no command)</em>}
        </span>
        <span data-testid="block-duration" style={{ color: "var(--fg-faint)" }}>
          {formatDuration(elapsedMs)}
        </span>
        <span
          data-testid="block-status"
          style={{
            color: statusColor(status),
            minWidth: 56,
            textAlign: "right",
          }}
        >
          {statusLabel(block)}
        </span>
        {/*
          The RAW pill is a scaffold for M4's formatter toggle (specs/02 fidelity
          contract). It has no behavior at this slice — there are no formatters
          yet — but the surface is wired so M4 can light it up.
        */}
        <span
          data-testid="block-raw-pill"
          style={{
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm)",
            padding: "1px 6px",
            fontSize: 10,
            color: "var(--fg-faint)",
          }}
        >
          RAW
        </span>
      </div>
      {(block.cwd !== null || block.git_branch !== null) && (
        <div
          data-testid="block-meta"
          style={{
            marginLeft: 14,
            marginTop: 2,
            fontSize: 11,
            color: "var(--fg-faint)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {block.cwd}
          {block.cwd !== null && block.git_branch !== null && (
            <span style={{ padding: "0 6px", color: "var(--fg-faint)" }}>·</span>
          )}
          {block.git_branch}
        </div>
      )}
      {expanded && (
        <pre
          data-testid="block-output"
          style={{
            margin: "6px 0 0 14px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
            color: "var(--fg-dim)",
          }}
        >
          {output ?? "…"}
        </pre>
      )}
    </div>
  );
}

export const BlockRow = memo(BlockRowInner);
