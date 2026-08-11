/**
 * Statusline — the bottom chrome row of the Shax window.
 *
 * Renders a modal-indicator pill, a branch indicator with cwd, and a
 * right-side cluster (encoding placeholder, Ask Shax hint, app status dot).
 *
 * cwd and branch come from the active pane's latest OSC 133 A — passed in by
 * the parent so this stays a pure presentational component.
 *
 * Visuals follow the design at `/design/Shax Main Shell.dc.html` and consume
 * tokens from `src/theme/tokens.css`.
 */

import type { CSSProperties } from "react";

/**
 * The three surfaces that own the keyboard at rest (M12.1, spec §18):
 *
 *   - `COMMAND` — the prompt strip owns focus. The resting state of any
 *     pane the user is typing into.
 *   - `CHAT` — the assistant input owns focus.
 *   - `BLOCK` — block-focus mode is engaged in the active pane (Ctrl+J
 *     or click on a block).
 *
 * These are surface labels, not vim editor modes — `COMMAND` is not
 * "press `i` to edit," it just names where the keys are going. Modal
 * overlays (search, palette, viewer, safety gate, settings, confirm-close)
 * do not change the pill; they own the keyboard while open but the pill
 * reflects what will regain focus when they close.
 */
export type StatuslineMode = "COMMAND" | "CHAT" | "BLOCK";

/**
 * Vi sub-modes surfaced by the M12.2 zsh shim via `OSC 133;M`. Only
 * meaningful when the user picked Vi in preferences; the shim doesn't
 * emit the marker in Emacs mode. Values not in this map (`main`,
 * `emacs`, unrecognised) render no sub-chip — the pill stays single.
 */
export type ViSubMode = "INSERT" | "NORMAL" | "VISUAL";

/**
 * Map from a zsh KEYMAP value (as reported over OSC 133;M) to the
 * sub-mode label rendered in the pill. Returns `null` for anything
 * that doesn't correspond to a distinct visible vi mode — the pill
 * then hides the sub-chip.
 */
export function viSubModeFromKeymap(keymap: string | null): ViSubMode | null {
  if (keymap === null) return null;
  switch (keymap) {
    case "viins":
    case "main": // zsh's "main" aliases to whatever bindkey -e / -v set; in vi mode it's viins.
      return "INSERT";
    case "vicmd":
      return "NORMAL";
    case "visual":
      return "VISUAL";
    default:
      return null;
  }
}

export interface StatuslineProps {
  cwd: string | null;
  branch: string | null;
  /** See {@link StatuslineMode}. */
  mode?: StatuslineMode;
  /**
   * Raw zsh KEYMAP value from the most recent OSC 133;M on the active
   * pane (M12.2). Rendered as a second chip next to the primary mode
   * chip when the mode is COMMAND and the mapped sub-mode is
   * non-null. Ignored (no sub-chip) for CHAT / BLOCK — those surfaces
   * are outside the shell prompt.
   */
  viKeymap?: string | null;
  /**
   * True when the assistant dock is open (M7.7b). Adds a small "+
   * assistant active" indicator on the right so users know the
   * dock is engaged even when the panel is scrolled or the pane
   * is fullscreen-y.
   */
  assistantActive?: boolean;
  /**
   * Number of assistant tool calls waiting for user approval
   * (M7.7b). Rendered as an amber "⚠ N approval pending" chip
   * on the right so the user can find the pending modal from any
   * pane. `0` hides the chip.
   */
  approvalsPending?: number;
}

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: 30,
  background: "var(--titlebar)",
  borderTop: "1px solid var(--border)",
  fontSize: 11,
  fontFamily: "var(--font-ui)",
  flexShrink: 0,
};

const MODE_PILL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: "100%",
  padding: "0 13px",
  color: "#fff",
  fontWeight: 700,
  letterSpacing: "0.08em",
};

/** Per-mode background color. `COMMAND` uses the primary accent (the
 *  default surface for typing shell commands); `CHAT` uses the same
 *  accent because entering the assistant is the intentional visual peak;
 *  `BLOCK` gets a distinct amber tone so navigating scrollback with
 *  hjkl-style motion doesn't look like the resting state. */
const MODE_BACKGROUND: Record<StatuslineMode, string> = {
  COMMAND: "var(--accent)",
  CHAT: "var(--accent)",
  BLOCK: "var(--amber)",
};

/** Sub-chip (M12.2 vi sub-mode) sits directly right of the mode pill.
 *  Single subdued background across all three vi sub-modes — the letters
 *  tell you which one; three different colors would just add noise. */
const SUB_MODE_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: "100%",
  padding: "0 11px",
  background: "var(--surface-hover)",
  color: "var(--fg)",
  fontWeight: 600,
  letterSpacing: "0.08em",
  fontSize: 10,
  borderRight: "1px solid var(--border)",
};

const BRANCH_GROUP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 13px",
  color: "var(--fg-dim)",
};

const CWD_TEXT: CSSProperties = {
  color: "var(--fg-faint)",
  padding: "0 6px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "40%",
};

const RIGHT_CELL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 13px",
  color: "var(--fg-dim)",
  borderLeft: "1px solid var(--border)",
};

export function Statusline({
  cwd,
  branch,
  mode = "COMMAND",
  viKeymap = null,
  assistantActive = false,
  approvalsPending = 0,
}: StatuslineProps): React.ReactElement {
  // Sub-chip only rides alongside COMMAND — CHAT / BLOCK are their own
  // surfaces and don't have a vi sub-mode. Non-vi keymaps (unmapped
  // values, `emacs`) map to null in viSubModeFromKeymap and hide it.
  const subMode = mode === "COMMAND" ? viSubModeFromKeymap(viKeymap) : null;
  return (
    <div data-testid="statusline" style={ROW}>
      <span
        style={{ ...MODE_PILL, background: MODE_BACKGROUND[mode] }}
        data-testid="statusline-mode"
        data-mode={mode}
      >
        {mode}
      </span>
      {subMode !== null && (
        <span style={SUB_MODE_CHIP} data-testid="statusline-vi-submode" data-submode={subMode}>
          {subMode}
        </span>
      )}
      <span style={BRANCH_GROUP} data-testid="statusline-branch">
        <span style={{ color: "var(--accent)" }}>⎇</span>
        <span>{branch ?? "—"}</span>
      </span>
      <span style={CWD_TEXT} data-testid="statusline-cwd">
        {cwd ?? "—"}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ color: "var(--fg-faint)", padding: "0 13px" }}>utf-8</span>
      <span style={RIGHT_CELL}>
        <span style={{ color: "var(--accent)" }}>✦</span> ⌘K Ask Shax
      </span>
      {approvalsPending > 0 && (
        <span
          data-testid="statusline-approvals-pending"
          style={{ ...RIGHT_CELL, color: "var(--amber)" }}
          title={
            approvalsPending === 1
              ? "One assistant command is waiting for your approval."
              : `${approvalsPending} assistant commands are waiting for your approval.`
          }
        >
          <span aria-hidden="true">⚠</span> {approvalsPending} approval
          {approvalsPending === 1 ? "" : "s"} pending
        </span>
      )}
      {assistantActive && (
        <span
          data-testid="statusline-assistant-active"
          style={{ ...RIGHT_CELL, color: "var(--accent)" }}
          title="The assistant dock is open."
        >
          <span aria-hidden="true">+</span> assistant active
        </span>
      )}
      <span style={RIGHT_CELL}>
        shax{" "}
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--accent)",
            display: "inline-block",
          }}
        />
      </span>
    </div>
  );
}
