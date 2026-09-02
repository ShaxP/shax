/**
 * M12.3 — confirmation modal for large clipboard pastes.
 *
 * Triggered by `PromptStrip`'s paste handler when the clipboard payload
 * is ≥ 5 lines OR ≥ 500 bytes. Small pastes flow straight through with
 * bracketed-paste wrapping; large ones stop here so the user can inspect
 * what's about to hit the shell — historically the source of "I pasted
 * a shell command from a shady stackoverflow answer and it ran instantly"
 * accidents.
 *
 * Confirming the paste sends the payload wrapped in bracketed-paste
 * markers (`\e[200~ … \e[201~`) with **raw LFs**. Every shell we support
 * (zsh, bash 4.4+, fish) with bracketed-paste enabled inserts the payload
 * into its line-editor buffer as multi-line text and waits for Enter
 * before executing anything — that's the safety layer. The user reviews
 * the pasted content in the strip and hits Enter when ready.
 *
 * (An earlier revision offered a "Paste as one command" toggle that
 * `\`-prefixed embedded LFs to fold the payload into one
 * backslash-continued command. That was based on a wrong mental model of
 * backslash-continuation semantics — POSIX `\<LF>` collapses the
 * newline to nothing rather than preserving it, so pasted scripts came
 * out as `echo oneecho twoecho three…` with concatenated words. Deleted.)
 */

import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { isTopmostModalLayer, useModalLayer } from "../lib/modalLayer";

export interface ConfirmPasteModalProps {
  /** The raw clipboard text (with LF line endings, CRLF already
   *  normalised by the caller). Rendered as-is in the preview area. */
  payload: string;
  /** User confirmed — send the bytes. */
  onConfirm: () => void;
  onCancel: () => void;
}

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 110,
};

const PANEL: CSSProperties = {
  width: "min(640px, 92vw)",
  maxHeight: "min(560px, 82vh)",
  display: "flex",
  flexDirection: "column",
  background: "var(--pane)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  color: "var(--fg)",
  outline: "none",
  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.5)",
};

const HEADER: CSSProperties = {
  padding: "16px 20px 8px 20px",
};

const HEADLINE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 6,
};

const SUBLINE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-dim)",
};

const PREVIEW_WRAPPER: CSSProperties = {
  flex: 1,
  minHeight: 0,
  margin: "8px 20px",
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--pane2)",
  overflow: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-secondary)",
  color: "var(--fg)",
  whiteSpace: "pre",
};

const ACTIONS: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 20px 16px 20px",
  borderTop: "1px solid var(--border)",
};

const BUTTON_BASE: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 4,
  border: "1px solid var(--border-strong)",
  background: "var(--pane2)",
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  cursor: "pointer",
};

const BUTTON_CONFIRM: CSSProperties = {
  ...BUTTON_BASE,
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "var(--accent-fg)",
  fontWeight: 600,
};

export function ConfirmPasteModal({
  payload,
  onConfirm,
  onCancel,
}: ConfirmPasteModalProps): React.ReactElement {
  useModalLayer("confirm-paste-modal");
  const panelRef = useRef<HTMLDivElement>(null);

  const stats = useMemo(() => {
    const lines = payload.split("\n").length;
    const bytes = new TextEncoder().encode(payload).byteLength;
    return { lines, bytes };
  }, [payload]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!isTopmostModalLayer("confirm-paste-modal")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCancel();
      } else if (e.key === "Enter" && !e.shiftKey) {
        // Enter → confirm. Shift+Enter is deliberately excluded so a
        // reflex-tap on Enter can't accidentally confirm during a
        // Shift+Enter multi-line composition elsewhere.
        e.preventDefault();
        e.stopImmediatePropagation();
        onConfirm();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel, onConfirm]);

  return (
    <div
      data-testid="confirm-paste-modal"
      data-lines={stats.lines}
      data-bytes={stats.bytes}
      style={BACKDROP}
      onClick={onCancel}
    >
      <div ref={panelRef} tabIndex={-1} style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={HEADER}>
          <div style={HEADLINE}>Paste {stats.lines} lines?</div>
          <div style={SUBLINE}>
            {stats.bytes.toLocaleString()} bytes. The shell will insert the payload into its
            line-editor buffer; press Enter afterwards to submit.
          </div>
        </div>
        <div style={PREVIEW_WRAPPER} data-testid="confirm-paste-preview">
          {payload}
        </div>
        <div style={ACTIONS}>
          <button
            type="button"
            data-testid="confirm-paste-cancel"
            style={BUTTON_BASE}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="confirm-paste-confirm"
            style={BUTTON_CONFIRM}
            onClick={() => onConfirm()}
          >
            Paste
          </button>
        </div>
      </div>
    </div>
  );
}
