/**
 * Read-only viewer for a single completed block, opened from search
 * results in M3 slice 3.1. The corresponding pane may belong to a
 * previous session (no longer live), so this modal is the universal
 * fallback — it fetches the bytes from the persistent store via
 * `getBlockOutput` and renders them with the same ANSI strip the in-
 * pane block list uses.
 *
 * No interaction beyond Close. Slice 3.2 layers in "jump to live pane"
 * when the source pane still exists in the current session.
 */

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { blockGetOutput } from "../lib/ipc";
import type { BlockSummary } from "../lib/ipc";
import { formatDuration } from "./blockFormat";

const TEXT_DECODER = new TextDecoder();

/**
 * Mirrors `stripAnsi` in `BlockRow.tsx`. Could be lifted into a shared
 * helper later; until then the duplication is small and intentional.
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
        if (c === 0x1b && input.charCodeAt(j + 1) === 0x5c) {
          j += 2;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    i += 2;
  }
  return out;
}

export interface BlockViewerModalProps {
  /** Block to view; metadata is rendered as-is, output is fetched. */
  block: BlockSummary;
  onClose: () => void;
}

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.55)",
  zIndex: 1100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const PANEL: CSSProperties = {
  width: "min(900px, 92vw)",
  maxHeight: "84vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--surface)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius)",
  boxShadow: "0 20px 48px rgba(0, 0, 0, 0.5)",
  fontFamily: "var(--font-ui)",
  overflow: "hidden",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
};

const COMMAND_LINE: CSSProperties = {
  flex: 1,
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--fg)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const META_LINE: CSSProperties = {
  padding: "6px 16px",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-faint)",
};

const OUTPUT_PRE: CSSProperties = {
  margin: 0,
  padding: "12px 16px",
  flex: 1,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-dim)",
  background: "var(--pane2)",
};

const CLOSE_BTN: CSSProperties = {
  background: "transparent",
  color: "var(--fg-faint)",
  border: "none",
  fontSize: 18,
  cursor: "pointer",
  padding: "0 4px",
};

function statusGlyph(b: BlockSummary): string {
  if (b.aborted) return "·";
  if (b.exit_code === null) return "…";
  return b.exit_code === 0 ? "✓" : "✗";
}

function statusColor(b: BlockSummary): string {
  if (b.aborted) return "var(--fg-faint)";
  if (b.exit_code === null) return "var(--accent)";
  return b.exit_code === 0 ? "var(--green)" : "var(--red)";
}

export function BlockViewerModal({ block, onClose }: BlockViewerModalProps): React.ReactElement {
  const [output, setOutput] = useState<string | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void blockGetOutput(block.id).then((bytes) => {
      if (cancelled) return;
      const text = TEXT_DECODER.decode(bytes);
      setOutput(stripAnsi(text));
      setPending(false);
    });
    return () => {
      cancelled = true;
    };
  }, [block.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleBackdropPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      data-testid="block-viewer-modal"
      style={BACKDROP}
      onPointerDown={handleBackdropPointerDown}
    >
      <div style={PANEL} role="dialog" aria-label="Block viewer">
        <div style={HEADER}>
          <span style={{ color: statusColor(block) }}>{statusGlyph(block)}</span>
          <span style={COMMAND_LINE}>{block.command ?? "(no command)"}</span>
          {block.duration_ms !== null && (
            <span style={{ fontSize: 11, color: "var(--fg-faint)" }}>
              {formatDuration(block.duration_ms)}
            </span>
          )}
          <button
            type="button"
            data-testid="block-viewer-close"
            onClick={onClose}
            style={CLOSE_BTN}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        {(block.cwd !== null || block.git_branch !== null) && (
          <div style={META_LINE}>
            {block.cwd}
            {block.cwd !== null && block.git_branch !== null && (
              <span style={{ padding: "0 6px" }}>·</span>
            )}
            {block.git_branch !== null && (
              <>
                {/* `⎇` matches the PromptStrip and Statusline branch glyph. */}
                <span aria-hidden="true" style={{ marginRight: 4 }}>
                  ⎇
                </span>
                {block.git_branch}
              </>
            )}
          </div>
        )}
        {block.interactive ? (
          <div
            data-testid="block-viewer-interactive"
            style={{
              padding: 16,
              color: "var(--fg-faint)",
              fontStyle: "italic",
              fontSize: 12,
            }}
          >
            interactive session — no captured output to display
          </div>
        ) : (
          <pre data-testid="block-viewer-output" style={OUTPUT_PRE}>
            {pending ? "…" : (output ?? "")}
          </pre>
        )}
      </div>
    </div>
  );
}
