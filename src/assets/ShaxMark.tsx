/**
 * The Shax word-mark glyph: a chevron and a stacked-lines cursor set in
 * a rounded square, painted in the theme's accent colour.
 *
 * Bundled here rather than referenced as a static `.svg` so the fill can
 * consume `var(--accent)` and re-tint automatically under dark / light.
 * If we later need it as an OS icon (dock, app bundle) we'll rasterise
 * from this SVG at build time.
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
      viewBox="0 0 64 64"
      role="img"
      aria-label="Shax"
      xmlns="http://www.w3.org/2000/svg"
      style={style}
      className={className}
    >
      <rect width="64" height="64" rx="14" fill="var(--accent)" />
      {/*
       * Left glyph: rightward chevron. Absolute coords so the stroke's
       * round joins line up crisply.
       */}
      <path
        d="M 21 20 L 32 32 L 21 44"
        stroke="#ffffff"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/*
       * Right glyph: two short horizontal lines, offset so they read as
       * a cursor / prompt-tail rather than a strict `=`. Feels less
       * mathematical.
       */}
      <line
        x1="37"
        y1="28"
        x2="47"
        y2="28"
        stroke="#ffffff"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <line
        x1="37"
        y1="38"
        x2="47"
        y2="38"
        stroke="#ffffff"
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  );
}
