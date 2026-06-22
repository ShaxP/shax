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

export interface StatuslineProps {
  cwd: string | null;
  branch: string | null;
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

export function Statusline({ cwd, branch }: StatuslineProps): React.ReactElement {
  return (
    <div data-testid="statusline" style={ROW}>
      <span style={MODE_PILL} data-testid="statusline-mode">
        NORMAL
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
