/**
 * M9.6 — confirmation modal for close actions that would kill a
 * running foreground command.
 *
 * Rendered at App level whenever `pendingClose` state is non-null.
 * One instance handles all four scopes (pane / tab / window / app)
 * via the `verb` prop — the wording table below is the source of
 * truth for the exact sentences.
 *
 * Alt-screen apps (vim / htop / less / top) are already excluded
 * upstream: `PtyManager::running_command_pane_ids` filters them
 * on the backend, so this modal only appears when the user is
 * about to kill a long-running non-interactive command (build,
 * server, ssh, sleep, tail -f, etc.).
 */

import { useEffect, useRef, type CSSProperties } from "react";
import { isTopmostModalLayer, useModalLayer } from "../lib/modalLayer";

/** Which close action prompted the modal. Drives the wording +
 *  the confirm-button label. */
export type ConfirmCloseVerb = "pane" | "tab" | "window" | "app";

export interface ConfirmCloseModalProps {
  /** Number of running non-alt-screen commands about to be lost. */
  count: number;
  verb: ConfirmCloseVerb;
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
  minWidth: 360,
  maxWidth: 480,
  background: "var(--pane)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  padding: 20,
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  color: "var(--fg)",
  outline: "none",
  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.5)",
};

const HEADLINE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 16,
};

const ACTIONS: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
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

/** Message body for each verb. Singular/plural chosen from `count`. */
function headline(verb: ConfirmCloseVerb, count: number): string {
  const noun = count === 1 ? "1 command is" : `${count} commands are`;
  const action =
    verb === "pane"
      ? "Close pane anyway?"
      : verb === "tab"
        ? "Close tab anyway?"
        : verb === "window"
          ? "Close window anyway?"
          : "Quit anyway?";
  return `${noun} still running. ${action}`;
}

function confirmLabel(verb: ConfirmCloseVerb): string {
  return verb === "app" ? "Quit anyway" : "Close anyway";
}

export function ConfirmCloseModal({
  count,
  verb,
  onConfirm,
  onCancel,
}: ConfirmCloseModalProps): React.ReactElement {
  useModalLayer("confirm-close-modal");
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus the panel so keyboard shortcuts land here, not the
  // shell behind the modal.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Escape → cancel, Enter → confirm. Only when this modal is on
  // top of the stack (so we don't hijack keys from a nested
  // overlay opened on top).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!isTopmostModalLayer("confirm-close-modal")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCancel();
      } else if (e.key === "Enter") {
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
      data-testid="confirm-close-modal"
      data-verb={verb}
      data-count={count}
      style={BACKDROP}
      // Clicking the backdrop is a soft "cancel" — matches how
      // most macOS confirmation dialogs behave when you tap
      // outside them.
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        style={PANEL}
        // Stop clicks on the panel body from reaching the
        // backdrop click handler above.
        onClick={(e) => e.stopPropagation()}
      >
        <div style={HEADLINE}>{headline(verb, count)}</div>
        <div style={ACTIONS}>
          <button
            type="button"
            data-testid="confirm-close-cancel"
            style={BUTTON_BASE}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="confirm-close-confirm"
            style={BUTTON_CONFIRM}
            onClick={onConfirm}
          >
            {confirmLabel(verb)}
          </button>
        </div>
      </div>
    </div>
  );
}
