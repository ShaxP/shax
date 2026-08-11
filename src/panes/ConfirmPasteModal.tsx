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
 * The "Paste as one command" toggle governs how embedded LFs are treated
 * before the payload is sent:
 *
 *   - toggle ON (default): each embedded LF is prefixed with `\`,
 *     turning the payload into one shell command joined by
 *     backslash-continuation. Safe default — nothing runs until the
 *     user hits Enter afterwards.
 *   - toggle OFF: the payload is sent unchanged. Every LF the shell
 *     sees is treated as an end-of-line and executes whatever line came
 *     before it — the pre-M12.3 behaviour.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { isTopmostModalLayer, useModalLayer } from "../lib/modalLayer";

export interface ConfirmPasteModalProps {
  /** The raw clipboard text (with LF line endings, CRLF already
   *  normalised by the caller). Rendered as-is in the preview area. */
  payload: string;
  /**
   * User confirmed — send the bytes. `pasteAsOneCommand` reflects the
   * toggle at confirmation time; the caller decides whether to
   * `\`-prefix embedded LFs.
   */
  onConfirm: (pasteAsOneCommand: boolean) => void;
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

const TOGGLE_ROW: CSSProperties = {
  padding: "8px 20px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  color: "var(--fg-dim)",
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
  color: "#fff",
  fontWeight: 600,
};

export function ConfirmPasteModal({
  payload,
  onConfirm,
  onCancel,
}: ConfirmPasteModalProps): React.ReactElement {
  useModalLayer("confirm-paste-modal");
  const panelRef = useRef<HTMLDivElement>(null);
  const [pasteAsOneCommand, setPasteAsOneCommand] = useState(true);

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
        onConfirm(pasteAsOneCommand);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel, onConfirm, pasteAsOneCommand]);

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
            {stats.bytes.toLocaleString()} bytes. Review before sending to the shell.
          </div>
        </div>
        <div style={PREVIEW_WRAPPER} data-testid="confirm-paste-preview">
          {payload}
        </div>
        <div style={TOGGLE_ROW}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              data-testid="confirm-paste-one-command"
              checked={pasteAsOneCommand}
              onChange={(e) => setPasteAsOneCommand(e.target.checked)}
            />
            <span>
              Paste as one command
              <span style={{ color: "var(--fg-faint)", marginLeft: 6 }}>
                (backslash-continue embedded newlines)
              </span>
            </span>
          </label>
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
            onClick={() => onConfirm(pasteAsOneCommand)}
          >
            Paste
          </button>
        </div>
      </div>
    </div>
  );
}
