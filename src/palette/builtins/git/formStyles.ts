/**
 * Shared inline styles for the three git form-panels (stash,
 * commit, rebase). Kept here rather than duplicated per-panel so
 * spacing / colour choices stay uniform.
 */

import type { CSSProperties } from "react";

export const PANEL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minHeight: 280,
  fontFamily: "var(--font-ui)",
  fontSize: 12,
};

export const FIELD_ROW: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

export const FIELD_LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--fg-dim)",
  letterSpacing: 0.3,
  textTransform: "uppercase",
};

export const TEXT_INPUT: CSSProperties = {
  padding: "6px 10px",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  outline: "none",
};

export const TEXTAREA: CSSProperties = {
  ...TEXT_INPUT,
  minHeight: 80,
  resize: "vertical",
  fontFamily: "var(--font-ui)",
};

export const TOGGLE_LABEL: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  color: "var(--fg)",
  cursor: "pointer",
};

export const PREVIEW: CSSProperties = {
  marginTop: "auto",
  padding: "8px 10px",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg)",
  wordBreak: "break-all",
  whiteSpace: "pre-wrap",
};

export const PREVIEW_LABEL: CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: 10.5,
  fontWeight: 600,
  color: "var(--fg-dim)",
  letterSpacing: 0.4,
  textTransform: "uppercase",
  marginBottom: 4,
};

export const FOOTER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  paddingTop: 4,
  fontSize: 11,
  color: "var(--fg-dim)",
  justifyContent: "space-between",
};

export const KBD: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  padding: "1px 5px",
  border: "1px solid var(--border-strong)",
  borderRadius: 3,
  color: "var(--fg-dim)",
  marginRight: 4,
};

export const SUBMIT_BUTTON: CSSProperties = {
  padding: "5px 12px",
  border: "1px solid var(--accent)",
  borderRadius: 4,
  background: "var(--accent)",
  color: "#fff",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

export const SUBMIT_BUTTON_DESTRUCTIVE: CSSProperties = {
  ...SUBMIT_BUTTON,
  background: "var(--red)",
  border: "1px solid var(--red)",
};

export const ERROR_BOX: CSSProperties = {
  padding: 10,
  color: "var(--red)",
  fontSize: 12,
};
