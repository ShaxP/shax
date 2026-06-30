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

import { memo, useEffect, useMemo, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import type { PtyId } from "../lib/ipc";
import { shellTokenize } from "../lib/shellTokenize";
import { findFormatter, invokeFormatter, isPass, type FormatterContext } from "../formatters";
import { hasDistinctSource } from "../viewer/ContentView";
import { detectContentType } from "../viewer/detectContentType";
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
/**
 * Strip zsh's missing-newline-at-EOF indicator (`%` + padding
 * + `\r`) from the tail of captured stdout. The styling is
 * gone after `stripAnsi`, but the literal `%` survives and
 * would otherwise leak into every formatter and into RAW.
 * See `viewer/stripAnsi.ts` for the shared variant; this is
 * the inline copy to avoid coupling BlockRow to that module
 * (kept symmetric with the local `stripAnsi` below).
 */
function stripShellArtifacts(input: string): string {
  return input.replace(/\n?%[ \t\r]*$/, "");
}

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
  /** True when this row is currently fit-to-pane. The row's
   *  container becomes absolute-positioned, filling the pane,
   *  covering the prompt strip. The action toolbar swaps the
   *  maximise icon for a minimise icon. */
  isMaximized?: boolean;
  /** Hide the row from the layout entirely. Used by BlockList
   *  to suppress every block other than the maximised one. */
  hidden?: boolean;
  /** Click handler for the per-row maximise icon. Toggles
   *  `isMaximized` in the parent's state. */
  onToggleMaximize?: () => void;
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

const COMMUNITY_PILL: CSSProperties = {
  ...FMT_PILL_BASE,
  background: "transparent",
  color: "var(--fg-faint)",
  border: "1px solid var(--border)",
  padding: "1px 6px",
  fontWeight: 500,
  textTransform: "lowercase",
  letterSpacing: "0.05em",
  cursor: "help",
  marginLeft: 6,
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
  isMaximized = false,
  hidden = false,
  onToggleMaximize,
}: BlockRowProps): React.ReactElement {
  // `userOpen` is the user-toggled override:
  //   - null  → follow the natural default
  //   - true  → user opened a historical block (collapsed by default)
  //   - false → user collapsed a block that was open by default
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [fetchedOutput, setFetchedOutput] = useState<string | null>(null);
  const [fetched, setFetched] = useState<boolean>(false);
  // FMT/SRC/RAW user toggle. `null` = follow the natural
  // default (FMT when a formatter applies, RAW otherwise).
  // Once the user explicitly picks a side, we honour it for
  // the lifetime of the row. SRC is only ever set when the
  // block's content type has a distinct source view; the
  // surface hides the SRC button otherwise.
  const [formatMode, setFormatMode] = useState<"raw" | "fmt" | "src" | null>(null);

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
  // Strip ANSI first, then zsh's missing-newline `%` indicator
  // (a literal char that survives ANSI strip). Without the
  // second step every formatter that parses ctx.stdout — wc,
  // future text formatters — sees a stray `%` row at the end
  // and renders it, and RAW shows a trailing `%` too.
  const outputText = rawText !== null ? stripShellArtifacts(stripAnsi(rawText)) : null;

  // Formatter resolution. The argv is tokenised from the block's
  // command; cwd / exit / duration come from the block summary;
  // stdout is the ANSI-stripped captured text, rawAnsi the
  // unstripped version. stderr + env are placeholders (the
  // backend doesn't separate them yet, see `FormatterContext`
  // header notes).
  const argv = useMemo(() => shellTokenize(block.command), [block.command]);
  const formatterCtx: FormatterContext | null = useMemo(() => {
    if (outputText === null || rawText === null) return null;
    return {
      argv,
      cwd: block.cwd,
      env: {},
      exitCode: block.exit_code,
      durationMs: block.duration_ms,
      stdout: outputText,
      stderr: "",
      rawAnsi: rawText,
      paneId: pty,
    };
  }, [argv, block.cwd, block.exit_code, block.duration_ms, outputText, rawText, pty]);
  const formatter = useMemo(
    () => (formatterCtx === null ? null : findFormatter(formatterCtx)),
    [formatterCtx],
  );
  // Per spec §07: a SRC button is only meaningful when the
  // block's content type has a *distinct* source view (markdown
  // rendered vs. markdown source; image vs. hex). For plain
  // source / `ls` / `git diff` etc., FMT already IS the source
  // view so SRC would just duplicate it.
  const contentType = useMemo(() => detectContentType({ argv }), [argv]);
  const srcAvailable = formatter !== null && hasDistinctSource(contentType);
  // The "natural" mode: FMT when a formatter applies, else RAW.
  // Per spec §02 the highest-tier render is the default; the
  // user toggle can flip it.
  const effectiveMode: "raw" | "fmt" | "src" = formatMode ?? (formatter !== null ? "fmt" : "raw");
  // Render the formatter output when we're in FMT or SRC mode +
  // a formatter is registered. The invoke wrapper turns any
  // throw into PASS, which we then treat identically to "no
  // formatter" and fall back to RAW.
  const formatterOutput = useMemo(() => {
    if (effectiveMode === "raw") return null;
    if (formatter === null || formatterCtx === null) return null;
    const lens = effectiveMode === "src" ? "source" : "rendered";
    const result = invokeFormatter(formatter, formatterCtx, lens);
    return isPass(result) ? null : result;
  }, [effectiveMode, formatter, formatterCtx]);
  // The RAW fallback chain: if the user picked FMT but the
  // formatter declined / threw, we still need to show *something*.
  const showFormatted = formatterOutput !== null;

  // Interactive blocks (vim, htop, less, …) never expand into an output
  // view — their bytes are cursor / grid manipulation, not flow text,
  // and rendering them produces nonsense. We also skip the historical
  // IPC fetch for the same reason. The user still sees the command,
  // duration, and the small "interactive session" label below.
  const interactive = block.interactive;

  // Listen for block-focus-mode action dispatches addressed to
  // this block: Tab toggles FMT/RAW, `y` yanks, `h`/`←` collapse,
  // `l`/`→` expand. The keyboard handler lives in TerminalPane;
  // targeting a specific block via `detail.blockId` keeps
  // BlockRow out of the global keymap.
  useEffect(() => {
    const onAction = (e: Event): void => {
      const detail = (
        e as CustomEvent<{
          pty: PtyId | null;
          blockId: string;
          kind: "toggle-fmt-raw" | "yank" | "collapse" | "expand";
        }>
      ).detail;
      // Pane-scope filter: only react when the event originated
      // from this row's pane. Without it, an inspected-block row
      // (search jump) carries the same id as the live row in
      // another pane, so a single key press would expand both.
      if (detail?.pty !== pty) return;
      if (detail.blockId !== block.id) return;
      if (detail.kind === "toggle-fmt-raw") {
        // Cycle through every lens the row currently exposes.
        // Two-state row (no SRC available) cycles FMT → RAW →
        // FMT; three-state row (cat on markdown / image / svg)
        // cycles FMT → SRC → RAW → FMT.
        if (formatter === null) return;
        setFormatMode((prev) => {
          const cur = prev ?? "fmt";
          const cycle: ("raw" | "fmt" | "src")[] = srcAvailable
            ? ["fmt", "src", "raw"]
            : ["fmt", "raw"];
          const idx = cycle.indexOf(cur);
          return cycle[(idx + 1) % cycle.length] ?? "fmt";
        });
        return;
      }
      if (detail.kind === "yank") {
        if (typeof navigator === "undefined" || navigator.clipboard === undefined) return;
        // Copy the block as a unit: command line + output, with
        // no prompt-style prefix (the toolbar copy button is
        // command-only and produces `ls -l` — `y` matches that
        // for the command portion and appends the output). Either
        // half may be unavailable (interactive block, historical
        // row not yet fetched, prompt with no command captured);
        // we copy whichever parts we have and bail only when
        // both are empty.
        const parts: string[] = [];
        if (block.command !== null && block.command.length > 0) {
          parts.push(block.command);
        }
        if (outputText !== null && outputText.length > 0) {
          parts.push(outputText);
        }
        if (parts.length === 0) return;
        void navigator.clipboard.writeText(parts.join("\n")).catch(() => undefined);
        return;
      }
      if (detail.kind === "expand") {
        // No-op for blocks that can't expand (alt-screen, still
        // running — both rendered specially). For everything
        // else, set the user-open override and lazy-fetch the
        // bytes if this is a historical row.
        if (isRunning || interactive) return;
        setUserOpen(true);
        if (!fetched && liveOutput === undefined && getOutput !== undefined) {
          setFetched(true);
          void getOutput(pty, block.id).then((bytes) => {
            setFetchedOutput(TEXT_DECODER.decode(bytes));
          });
        }
        return;
      }
      if (detail.kind === "collapse") {
        if (isRunning || interactive) return;
        setUserOpen(false);
        return;
      }
    };
    window.addEventListener("shax:block-action", onAction);
    return () => window.removeEventListener("shax:block-action", onAction);
  }, [
    block.id,
    block.command,
    formatter,
    outputText,
    isRunning,
    interactive,
    fetched,
    liveOutput,
    getOutput,
    pty,
    srcAvailable,
  ]);

  // Natural default: open whenever we already have the bytes in memory, OR
  // the block is still running (always-open is the rule for running). For
  // historical blocks the natural default is closed — we don't want to fire
  // 50 concurrent IPC fetches on boot to populate seeded rows that the user
  // may never look at.
  const naturalOpen = isRunning || liveOutput !== undefined;
  // Fit-to-pane forces the row open — a maximised collapsed
  // block would just show the command header filling the pane
  // with nothing to actually look at.
  const open = interactive
    ? false
    : isRunning
      ? true
      : isMaximized
        ? true
        : (userOpen ?? naturalOpen);

  // For historical blocks (no live bytes, not yet fetched),
  // maximising should also trigger the same lazy IPC fetch
  // the user would have gotten by clicking expand. Without
  // this, an unfetched row fills the pane with the command
  // header and an empty output area.
  useEffect(() => {
    if (!isMaximized) return;
    if (fetched) return;
    if (liveOutput !== undefined) return;
    if (getOutput === undefined) return;
    if (isRunning || interactive) return;
    setFetched(true);
    void getOutput(pty, block.id).then((bytes) => {
      setFetchedOutput(TEXT_DECODER.decode(bytes));
    });
  }, [isMaximized, fetched, liveOutput, getOutput, isRunning, interactive, pty, block.id]);

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

  // While maximised, override the row's normal flow with an
  // absolute overlay that fills the pane. Also lift the
  // formatter's max-height so e.g. the CodeMirror viewer and
  // the markdown renderer expand to fill the available space.
  const containerStyle: CSSProperties = hidden
    ? { display: "none" }
    : isMaximized
      ? {
          // Keep ROW's flex *row* direction — the edge bar +
          // content area sit side by side, same as inline mode.
          // What changes is only the row becoming a fill-the-
          // pane overlay; the CONTENT child takes the remaining
          // horizontal space and (because of align-items:
          // stretch) the full pane height.
          ...ROW,
          position: "absolute",
          inset: 0,
          zIndex: 30,
          background: "var(--bg)",
          margin: 0,
          maxWidth: "none",
          // `--formatter-flex: 1 1 0` flips the cat formatter's
          // host from a fixed-height box (the inline default)
          // to a flex item that grows to fill the formatter-
          // output wrapper — which itself becomes flex:1 inside
          // CONTENT's column below.
          ["--formatter-flex" as never]: "1 1 0",
          ["--formatter-max-height" as never]: "100%",
        }
      : ROW;

  return (
    <div
      className="block-row"
      data-testid="block-row"
      data-block-id={block.id}
      data-status={status}
      data-selected={selected ? "true" : "false"}
      data-maximized={isMaximized ? "true" : "false"}
      style={containerStyle}
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
                  // Disabled visually when no formatter applies — RAW
                  // is the only option for that block. Still
                  // rendered (consistent layout across rows).
                  style={effectiveMode === "fmt" && formatter !== null ? FMT_PILL_ON : FMT_PILL_OFF}
                  disabled={formatter === null}
                  data-active={effectiveMode === "fmt" ? "true" : "false"}
                  data-available={formatter !== null ? "true" : "false"}
                  title={
                    formatter === null
                      ? "no formatter for this command"
                      : `formatter: ${formatter.name}`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (formatter === null) return;
                    setFormatMode("fmt");
                  }}
                >
                  FMT
                </button>
                {srcAvailable && (
                  <button
                    type="button"
                    data-testid="block-src-pill"
                    style={effectiveMode === "src" ? FMT_PILL_ON : FMT_PILL_OFF}
                    data-active={effectiveMode === "src" ? "true" : "false"}
                    title="View source (markdown source, image hex, …)"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFormatMode("src");
                    }}
                  >
                    SRC
                  </button>
                )}
                <button
                  type="button"
                  data-testid="block-raw-pill"
                  style={effectiveMode === "raw" ? FMT_PILL_ON : FMT_PILL_OFF}
                  data-active={effectiveMode === "raw" ? "true" : "false"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFormatMode("raw");
                  }}
                >
                  RAW
                </button>
              </div>
              {formatter !== null && formatter.source === "community" && (
                <span
                  data-testid="block-community-pill"
                  style={COMMUNITY_PILL}
                  title="Add-on — runs in an isolated sandbox with no access to your files, network, or app internals."
                >
                  add-on
                </span>
              )}
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
              title="open in viewer"
              data-testid="block-view"
              style={{ ...ACTION_ICON, color: "var(--fg-faint)" }}
              onClick={(e) => {
                e.stopPropagation();
                // App listens at window level — keeps BlockRow free of
                // a deep prop chain. The detail carries enough for the
                // viewer to fetch bytes by both live-pane and
                // historical (store) paths.
                window.dispatchEvent(
                  new CustomEvent("shax:open-viewer", {
                    detail: { pty, block },
                  }),
                );
              }}
            >
              {"\uF06E"}
            </span>
            {onToggleMaximize !== undefined && (
              <span
                title={
                  isMaximized
                    ? "Restore (f)"
                    : "Fit to pane (f) — fills the pane and covers the prompt"
                }
                data-testid="block-maximize"
                style={{ ...ACTION_ICON, color: "var(--fg-faint)" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleMaximize();
                }}
              >
                {isMaximized ? "✕" : "⛶"}
              </span>
            )}
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
        {open && showFormatted && (
          <div
            data-testid="block-formatter-output"
            style={
              isMaximized
                ? {
                    // Fill the remaining height in CONTENT's flex
                    // column — that's pane height minus the
                    // command header and meta strip. Display flex
                    // column lets the cat formatter's HOST grow
                    // into us via `--formatter-flex: 1 1 0`.
                    flex: 1,
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                  }
                : undefined
            }
          >
            {formatterOutput}
          </div>
        )}
        {open && !showFormatted && (
          <pre
            data-testid="block-output"
            data-block-scroll-host="raw"
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
              ...(isMaximized
                ? {
                    // RAW mode in fit-to-pane: fill the remaining
                    // height and scroll internally instead of
                    // overflowing the pane.
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                  }
                : undefined),
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
