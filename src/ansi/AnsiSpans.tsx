/**
 * Render `AnsiSpan[]` as styled DOM (M4.5 slice 3).
 *
 * One `<span>` per parser span. Palette colours map to CSS
 * custom properties (`--ansi-red`, `--ansi-bright-green`, …)
 * so a theme can override; indexed / truecolor spans render
 * with concrete `rgb(…)` values.
 *
 * The parser guarantees non-empty text runs, so the DOM stays
 * flat and compact — no empty spans to skip in devtools.
 */

import type { CSSProperties } from "react";
import {
  hasSgr,
  parseAnsi,
  type AnsiSpan,
  type PaletteColor,
  type SgrColor,
  type SgrStyle,
} from "./sgr";

interface AnsiSpansProps {
  text: string;
  /** Wrapper style — passed to the outer `<span>`. */
  style?: CSSProperties;
  /** Test id for the wrapper. */
  testId?: string;
}

export function AnsiSpans({ text, style, testId }: AnsiSpansProps): React.ReactElement {
  // Fast path: no ANSI at all → single unstyled span.
  if (!hasSgr(text)) {
    return (
      <span data-testid={testId} style={style}>
        {text}
      </span>
    );
  }
  const spans = parseAnsi(text);
  return (
    <span data-testid={testId} style={style}>
      {spans.map((span, i) => (
        <span key={i} style={styleForSpan(span)}>
          {span.text}
        </span>
      ))}
    </span>
  );
}

function styleForSpan(span: AnsiSpan): CSSProperties {
  const s = span.style;
  const style: CSSProperties = {};
  const { fg, bg } = resolveInverse(s.fg, s.bg, s.inverse === true);
  if (fg !== undefined) style.color = cssColor(fg);
  if (bg !== undefined) style.background = cssColor(bg);
  if (s.bold === true) style.fontWeight = 600;
  if (s.dim === true) style.opacity = 0.7;
  if (s.italic === true) style.fontStyle = "italic";
  const decorations: string[] = [];
  if (s.underline === true) decorations.push("underline");
  if (s.strikethrough === true) decorations.push("line-through");
  if (decorations.length > 0) style.textDecoration = decorations.join(" ");
  return style;
}

/** SGR 7 (inverse) swaps fg and bg. When only one side is set,
 *  we swap with the term's default — the CSS current-color /
 *  transparent defaults handle that visually. */
function resolveInverse(
  fg: SgrColor | undefined,
  bg: SgrColor | undefined,
  inverse: boolean,
): { fg?: SgrColor; bg?: SgrColor } {
  if (!inverse) return { fg, bg };
  // Swap. If a side was undefined, the swap leaves it
  // undefined — which will render as default when the other
  // side is set to a concrete colour.
  const defaultBg: SgrColor = { kind: "palette", name: "white" };
  const defaultFg: SgrColor = { kind: "palette", name: "black" };
  return {
    fg: bg ?? defaultBg,
    bg: fg ?? defaultFg,
  };
}

function cssColor(color: SgrColor): string {
  if (color.kind === "palette") return paletteVar(color.name);
  if (color.kind === "rgb") return `rgb(${color.r}, ${color.g}, ${color.b})`;
  // Unknown indexed — treat as default.
  return "inherit";
}

function paletteVar(name: PaletteColor): string {
  return `var(--ansi-${name})`;
}

// Re-exports for tests / other renderers that want the primitives.
export { hasSgr, parseAnsi };
export type { AnsiSpan, SgrStyle, SgrColor, PaletteColor };
