/**
 * Statusline — the bottom chrome row of the Shax window.
 *
 * Renders a modal-indicator pill (visual NORMAL), a branch indicator with
 * cwd, and a right-side cluster (encoding placeholder, Ask Shax hint, app
 * status dot). Like the TitleBar this is visual-only at M1.5; modal editing
 * (NORMAL / INSERT) belongs to a later slice and the assistant lights up at
 * M6.
 *
 * cwd and branch come from the active pane's latest OSC 133 A — passed in by
 * the parent so this stays a pure presentational component.
 *
 * Visuals follow the design at `/design/Shax Main Shell.dc.html` and consume
 * tokens from `src/theme/tokens.css`.
 */

import type { CSSProperties } from "react";

export type StatuslineMode = "NORMAL" | "INSERT";

export interface StatuslineProps {
  cwd: string | null;
  branch: string | null;
  /**
   * Modal indicator (M7.7c). Flips to `INSERT` when the
   * assistant input owns focus, `NORMAL` everywhere else. The
   * assistant input is currently the only INSERT surface; more
   * modal editors (block-focus vim-style, palette input) may
   * feed this same slot later.
   */
  mode?: StatuslineMode;
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
  background: "var(--accent)",
  color: "#fff",
  fontWeight: 700,
  letterSpacing: "0.08em",
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
  mode = "NORMAL",
  assistantActive = false,
  approvalsPending = 0,
}: StatuslineProps): React.ReactElement {
  return (
    <div data-testid="statusline" style={ROW}>
      <span style={MODE_PILL} data-testid="statusline-mode" data-mode={mode}>
        {mode}
      </span>
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
