/**
 * Renderer for the INFO lens (M4.5 slice 2).
 *
 * Pure component — takes a `MetadataView` and lays out titled
 * sections as key-value pairs. Fits the same
 * `--formatter-max-height` / `--formatter-flex` layout system
 * every other content view uses, so the maximised host and the
 * modal panel both size cleanly.
 */

import type { CSSProperties } from "react";
import type { MetadataView } from "./types";

const HOST: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  lineHeight: 1.55,
  maxHeight: "var(--formatter-max-height, 480px)",
  overflowY: "auto",
  color: "var(--fg-dim)",
  padding: "8px 12px",
};

const SECTION: CSSProperties = {
  marginBottom: 14,
};

const SECTION_TITLE: CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  color: "var(--fg-faint)",
  marginBottom: 4,
  paddingBottom: 3,
  borderBottom: "1px solid var(--border)",
};

const ROW: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "12ch 1fr",
  gap: "1.5ch",
  padding: "1px 0",
};

const KEY: CSSProperties = {
  color: "var(--fg-faint)",
};

const VALUE: CSSProperties = {
  color: "var(--fg)",
  wordBreak: "break-word",
  whiteSpace: "pre-wrap",
};

const HINT: CSSProperties = {
  marginLeft: 8,
  color: "var(--fg-faint)",
  fontSize: 11,
};

interface MetadataRendererProps {
  sections: MetadataView;
  style?: CSSProperties;
}

export function MetadataRenderer({ sections, style }: MetadataRendererProps): React.ReactElement {
  return (
    <div data-testid="info-view" style={{ ...HOST, ...style }}>
      {sections.map((section) => (
        <section key={section.title} style={SECTION} data-testid="info-section">
          <div style={SECTION_TITLE}>{section.title}</div>
          {section.rows.map((row) => (
            <div key={row.key} style={ROW}>
              <span style={KEY}>{row.key}</span>
              <span style={VALUE}>
                {row.value}
                {row.hint !== undefined && <span style={HINT}>{row.hint}</span>}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
