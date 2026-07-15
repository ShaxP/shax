/**
 * The Shax mark: a chevron and a two-bar cursor set in a rounded square,
 * painted in the theme's accent colour.
 *
 * Traced by eye from `design/shax icon.png`. Kept as an inline SVG
 * component (rather than a static `.svg` referenced via `<img>`) so the
 * background fill can consume `var(--accent)` and re-tint automatically
 * under dark / light. If we later need this as an OS icon (dock, app
 * bundle), rasterise from this source at build time.
 */
import type { CSSProperties } from "react";

export interface ShaxMarkProps {
  /** Rendered pixel size (square). Defaults to 64. */
  size?: number;
  /** Optional passthrough style. */
  style?: CSSProperties;
  /** Optional passthrough className. */
  className?: string;
}

export function ShaxMark({ size = 64, style, className }: ShaxMarkProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Shax"
      xmlns="http://www.w3.org/2000/svg"
      style={style}
      className={className}
    >
      {/* Rounded-square background in the theme accent. */}
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      {/* Left glyph: rightward chevron, rounded caps + joins. */}
      <path
        d="M 10 9 L 16 16 L 10 23"
        stroke="#ffffff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Right glyph, top bar: solid — the "current command" line. */}
      <line
        x1="19"
        y1="13"
        x2="26"
        y2="13"
        stroke="#ffffff"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/*
       * Right glyph, bottom bar: dimmer + shorter — reads as the next
       * (yet-to-come) prompt line, giving the mark a subtle sense of
       * "ready for input." Opacity 0.42 matches the alpha in the source
       * design at 8-bit resolution.
       */}
      <line
        x1="19"
        y1="19"
        x2="24"
        y2="19"
        stroke="#ffffff"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.42"
      />
    </svg>
  );
}
