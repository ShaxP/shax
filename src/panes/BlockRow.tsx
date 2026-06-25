/**
 * BlockRow — one block in the BlockList, redrawn for M1.5 slice 2.
 *
 * Anatomy (per `/design/Shax Main Shell.dc.html`):
 *
 *   ┌─┬─────────────────────────────────────────────────────────────┐
 *   │ │ ❯ git status -sb            12ms  ✓ 0  [FMT|RAW]  ⧉ ↻ ↗ ✦   │
 *   │ │ /Users/ada/dev/shax · main                                  │
 *   │ │ (expanded output …)                                         │
 *   └─┴─────────────────────────────────────────────────────────────┘
 *
 *  - The 3px left edge is status-coded (green / red / neutral / accent)
 *    and pulses while a command is still streaming.
 *  - The ❯ glyph matches the edge colour.
 *  - Running blocks show a spinner + "running" text instead of duration +
 *    status badge + FMT/RAW pill — those only make sense after exit.
 *  - The FMT/RAW pill is scaffolded with RAW pre-selected and FMT inert
 *    (no formatters until M4); the toggle surface stays so the moment a
 *    formatter is wired up we can light it up.
 *  - The action row (copy / rerun / share / ask Shax) is hidden by default
 *    and fades in on hover via pure CSS (see BlockRow.css). `copy` is wired
 *    to the clipboard now; the others are inert placeholders for M2/M5/M6.
 *
 * Completed blocks are expandable; expanding fetches the captured output
 * bytes once and caches them in component state.
 *
 * Wrapped in `React.memo` so unchanged rows skip re-render when the
 * BlockList re-renders for unrelated events (e.g., output streaming into
 * another row). With a couple of hundred historical blocks on boot, naive
 * re-rendering was starving the main thread.
 */

import { memo, useEffect, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import type { PtyId } from "../lib/ipc";
import { formatDuration, formatTimestamp } from "./blockFormat";
import type { UiBlock } from "./blockReducer";
import "./BlockRow.css";

const TEXT_DECODER = new TextDecoder();

/**
 * Strip CSI and OSC escape sequences from a decoded byte stream so the
 * block output renders cleanly until M4 brings the real formatter
 * system. CSI = `ESC [ params final`; OSC = `ESC ] payload (BEL | ST)`.
 * Anything that survives this is plain text (or a stray ESC, which we
 * also drop along with the byte that follows).
 *
 * This is the same "tier 0, raw bytes" promise from `specs/02-rendering-
 * two-path.md` — the bytes are still available via the live buffer,
 * we just don't render the escape codes as literal text.
 */
function stripAnsi(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input.charCodeAt(i);
    if (ch !== 0x1b) {
      out += input[i];
      i++;
      continue;
    }
    const next = input.charCodeAt(i + 1);
    if (next === 0x5b /* [ */) {
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (next === 0x5d /* ] */) {
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c === 0x07) {
          j++;
          break;
        }
        if (c === 0x1b && input.charCodeAt(j + 1) === 0x5c /* \ */) {
          j += 2;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    // Other two-byte ESC sequences (charset selects, save/restore
    // cursor, …): drop ESC + its follow byte.
    i += 2;
  }
  return out;
}

export interface BlockRowProps {
  pty: PtyId;
  block: UiBlock;
  /**
   * Live-streamed output bytes for this block, accumulated from
   * `block_chunk` events. Always rendered inline while the block is
   * running; reused as the expand cache for blocks that completed in this
   * session. Absent for blocks seeded from disk on boot — those still
   * fetch via `getOutput` on expand.
   */
  liveOutput?: Uint8Array;
  /** Injected for tests; defaults to the real IPC client. */
  getOutput?: (pty: PtyId, blockId: string) => Promise<Uint8Array>;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Draws a subtle accent border with rounded corners around the row
   * — used by the search overlay's jump-to-block path to point the
   * user at the row that just matched, and by click-to-select on any
   * row. The BlockList owns the selection state.
   */
  selected?: boolean;
  /** Called when the user clicks anywhere on the row. */
  onSelect?: () => void;
}

type Status = "running" | "ok" | "fail" | "aborted";

function statusFor(block: UiBlock): Status {
  if (block.aborted) return "aborted";
  if (block.exit_code === null) return "running";
  return block.exit_code === 0 ? "ok" : "fail";
}

function statusEdgeColor(status: Status): string {
  switch (status) {
    case "ok":
      return "var(--green)";
    case "fail":
      return "var(--red)";
    case "running":
      return "var(--accent)";
    case "aborted":
      return "var(--fg-faint)";
  }
}

function statusGlyphColor(status: Status): string {
  // Glyph and edge share a colour so the eye picks both up at once.
  return statusEdgeColor(status);
}

function statusBadge(block: UiBlock, status: Status): React.ReactNode {
  switch (status) {
    case "ok":
      return (
        <span
          style={{ color: "var(--green)", display: "inline-flex", alignItems: "center", gap: 3 }}
        >
          ✓ 0
        </span>
      );
    case "fail":
      return (
        <span
          style={{
            color: "var(--red)",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontWeight: 600,
          }}
        >
          ✗ exit {block.exit_code}
        </span>
      );
    case "aborted":
      return <span style={{ color: "var(--amber)" }}>⊘ aborted</span>;
    case "running":
      // Running is rendered as spinner + "running" elsewhere — no badge here.
      return null;
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

const ROW: CSSProperties = {
  position: "relative",
  display: "flex",
  gap: 13,
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg)",
};

const EDGE: CSSProperties = {
  width: 3,
  flex: "0 0 3px",
  borderRadius: 3,
  margin: "3px 0",
};

const CONTENT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  minHeight: 24,
};

const FMT_RAW_GROUP: CSSProperties = {
  display: "flex",
  padding: 2,
  gap: 2,
  background: "var(--surface)",
  borderRadius: 6,
  marginLeft: 2,
};

const FMT_PILL_BASE: CSSProperties = {
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 10,
  fontWeight: 600,
  padding: "2px 7px",
  borderRadius: 4,
  letterSpacing: "0.03em",
};

const FMT_PILL_ON: CSSProperties = {
  ...FMT_PILL_BASE,
  background: "var(--accent-soft)",
  color: "var(--accent)",
};

const FMT_PILL_OFF: CSSProperties = {
  ...FMT_PILL_BASE,
  background: "transparent",
  color: "var(--fg-faint)",
};

const ACTION_ICON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: "var(--radius-sm)",
  fontSize: 12,
  cursor: "pointer",
  userSelect: "none",
};

function BlockRowInner({
  pty,
  block,
  liveOutput,
  getOutput,
  now = Date.now,
  selected = false,
  onSelect,
}: BlockRowProps): React.ReactElement {
  // `userOpen` is the user-toggled override:
  //   - null  → follow the natural default
  //   - true  → user opened a historical block (collapsed by default)
  //   - false → user collapsed a block that was open by default
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [fetchedOutput, setFetchedOutput] = useState<string | null>(null);
  const [fetched, setFetched] = useState<boolean>(false);

  const status = statusFor(block);
  const isRunning = status === "running";

  const nowMs = useElapsedNow(isRunning, now);
  const elapsedMs: number | null = isRunning
    ? Math.max(0, nowMs - block.started_at_ms)
    : block.duration_ms;

  // Prefer the live-streamed bytes from the reducer (always up to date for
  // in-session blocks); fall back to a one-shot IPC fetch on first expand
  // for historical blocks seeded from disk.
  // Decode and strip ANSI before displaying. Raw bytes still live in
  // `liveOutput` / the persistent store; what we show in the block is
  // the human-readable text. Coloured rendering is M4 formatter work.
  const liveText = liveOutput !== undefined ? TEXT_DECODER.decode(liveOutput) : null;
  const rawText = liveText ?? fetchedOutput;
  const outputText = rawText !== null ? stripAnsi(rawText) : null;

  // Interactive blocks (vim, htop, less, …) never expand into an output
  // view — their bytes are cursor / grid manipulation, not flow text,
  // and rendering them produces nonsense. We also skip the historical
  // IPC fetch for the same reason. The user still sees the command,
  // duration, and the small "interactive session" label below.
  const interactive = block.interactive;

  // Natural default: open whenever we already have the bytes in memory, OR
  // the block is still running (always-open is the rule for running). For
  // historical blocks the natural default is closed — we don't want to fire
  // 50 concurrent IPC fetches on boot to populate seeded rows that the user
  // may never look at.
  const naturalOpen = isRunning || liveOutput !== undefined;
  const open = interactive ? false : isRunning ? true : (userOpen ?? naturalOpen);

  const toggleOpen = (): void => {
    if (isRunning || interactive) return;
    const next = !open;
    setUserOpen(next);
    // Opening a historical block for the first time: fire the IPC fetch.
    if (next && !fetched && liveOutput === undefined && getOutput !== undefined) {
      setFetched(true);
      void getOutput(pty, block.id).then((bytes) => {
        setFetchedOutput(TEXT_DECODER.decode(bytes));
      });
    }
  };

  const handleCopy = (e: ReactMouseEvent<HTMLSpanElement>): void => {
    e.stopPropagation();
    if (block.command === null) return;
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(block.command).catch(() => undefined);
  };

  return (
    <div
      className="block-row"
      data-testid="block-row"
      data-block-id={block.id}
      data-status={status}
      data-selected={selected ? "true" : "false"}
      style={ROW}
      onClick={onSelect}
    >
      {/*
       * Selection ring — an inset overlay rather than a `box-shadow`
       * on the row itself so the ring sits a few pixels in from the
       * pane edge and doesn't visually collide with the pane border.
       * `pointer-events: none` keeps clicks reaching the row, and the
       * `transition` softens replacement when the selection moves.
       */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 4,
          borderRadius: "var(--radius)",
          border: `1px solid ${selected ? "var(--accent)" : "transparent"}`,
          pointerEvents: "none",
          transition: "border-color 0.2s ease-out",
        }}
      />
      <div
        data-testid="block-edge"
        className={isRunning ? "block-row-edge-running" : undefined}
        style={{ ...EDGE, background: statusEdgeColor(status) }}
      />

      <div style={CONTENT}>
        <div
          data-testid="block-header"
          onClick={toggleOpen}
          style={{
            ...HEADER,
            cursor: isRunning ? "default" : "pointer",
            userSelect: "none",
          }}
        >
          <span style={{ color: statusGlyphColor(status), fontSize: 12 }}>❯</span>
          <span
            data-testid="block-command"
            style={{
              flex: 1,
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {block.command ?? <em style={{ color: "var(--fg-faint)" }}>(no command)</em>}
          </span>

          {isRunning ? (
            <>
              <span className="block-row-spinner" data-testid="block-spinner" />
              <span
                data-testid="block-status"
                style={{
                  fontSize: 11,
                  color: "var(--accent)",
                  fontFamily: "var(--font-ui)",
                  fontWeight: 500,
                  letterSpacing: "0.02em",
                }}
              >
                running
              </span>
              <span
                data-testid="block-timestamp"
                style={{
                  fontSize: 11,
                  color: "var(--fg-faint)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
                title={new Date(block.started_at_ms).toLocaleString()}
              >
                <span aria-hidden="true">{"\uF073"}</span>
                {formatTimestamp(block.started_at_ms)}
              </span>
              <span
                data-testid="block-duration"
                style={{
                  fontSize: 11,
                  color: "var(--fg-faint)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span aria-hidden="true">{"\uF017"}</span>
                {formatDuration(elapsedMs)}
              </span>
            </>
          ) : (
            <>
              <span
                data-testid="block-timestamp"
                style={{
                  fontSize: 11,
                  color: "var(--fg-faint)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
                title={new Date(block.started_at_ms).toLocaleString()}
              >
                <span aria-hidden="true">{"\uF073"}</span>
                {formatTimestamp(block.started_at_ms)}
              </span>
              <span
                data-testid="block-duration"
                style={{
                  fontSize: 11,
                  color: "var(--fg-faint)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span aria-hidden="true">{"\uF017"}</span>
                {formatDuration(elapsedMs)}
              </span>
              <span data-testid="block-status" style={{ fontSize: 11 }}>
                {statusBadge(block, status)}
              </span>
              <div data-testid="block-fmt-raw" style={FMT_RAW_GROUP}>
                <button
                  type="button"
                  data-testid="block-fmt-pill"
                  style={FMT_PILL_OFF}
                  // FMT is inert until M4 brings real formatters. The pill
                  // surface stays so the toggle is discoverable.
                  onClick={(e) => e.stopPropagation()}
                >
                  FMT
                </button>
                <button
                  type="button"
                  data-testid="block-raw-pill"
                  style={FMT_PILL_ON}
                  onClick={(e) => e.stopPropagation()}
                >
                  RAW
                </button>
              </div>
            </>
          )}

          <div className="block-row-actions" data-testid="block-actions">
            <span
              title="copy"
              style={{ ...ACTION_ICON, color: "var(--fg-faint)" }}
              onClick={handleCopy}
            >
              ⧉
            </span>
            <span
              title="rerun"
              style={{ ...ACTION_ICON, color: "var(--fg-faint)" }}
              onClick={(e) => e.stopPropagation()}
            >
              ↻
            </span>
            <span
              title="share"
              style={{ ...ACTION_ICON, color: "var(--fg-faint)" }}
              onClick={(e) => e.stopPropagation()}
            >
              ↗
            </span>
            <span
              title="ask shax"
              style={{ ...ACTION_ICON, color: "var(--accent)" }}
              onClick={(e) => e.stopPropagation()}
            >
              ✦
            </span>
          </div>
        </div>

        {(block.cwd !== null || block.git_branch !== null) && (
          <div
            data-testid="block-meta"
            style={{
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

        {/*
         * Output rendering:
         *  - Running blocks always show their live byte buffer inline (no
         *    toggle); the user watches output stream in.
         *  - Completed blocks are open by default whenever we already have
         *    the bytes in memory — either from this session's streaming or
         *    from a previous expand-fetch. The user can collapse with a
         *    click on the header and re-open with another click.
         *  - Historical blocks seeded from disk default to closed so we
         *    don't fire dozens of IPC fetches on boot; clicking opens and
         *    fetches once.
         * Tier-0 raw rendering: bytes UTF-8 decoded, ANSI escapes pass through
         * untouched (the fidelity contract). M4 brings real formatters.
         */}
        {interactive && !isRunning && (
          <div
            data-testid="block-interactive-label"
            style={{
              margin: "4px 0 0 0",
              fontSize: 11,
              color: "var(--fg-faint)",
              fontStyle: "italic",
            }}
          >
            interactive session
          </div>
        )}
        {open && (
          <pre
            data-testid="block-output"
            style={{
              margin: "4px 0 0 0",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              color: "var(--fg-dim)",
              // The User-Agent stylesheet sets `<pre>` to a generic
              // `monospace`, which overrides the Nerd-Font-first stack
              // inherited from BlockRow. Force inheritance so Nerd Font
              // glyphs (eza icons, devicons, powerline arrows, …) render
              // the same as they do in the rest of the UI.
              fontFamily: "inherit",
            }}
          >
            {outputText ?? "…"}
          </pre>
        )}
      </div>
    </div>
  );
}

export const BlockRow = memo(BlockRowInner);
