/**
 * The viewer's editor chrome must be expressed entirely in the
 * active preset's CSS custom properties.
 *
 * Two failure modes are guarded here, both of which are silent at
 * runtime — CSS neither warns nor throws:
 *
 *  1. A literal colour. This is what `@codemirror/theme-one-dark`
 *     did: it hardcoded `#282c34` for every dark preset, so the
 *     viewer painted grey no matter which theme was active.
 *  2. A typo'd variable (`var(--panel)` for `var(--pane)`). The
 *     declaration is simply dropped and the element renders
 *     unstyled, which is easy to miss in review.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { __testing } from "./Viewer";

const { EDITOR_CHROME } = __testing;

/** Custom properties `tokens.css` defines at `:root`. */
const definedTokens = new Set(
  // Repo-root-relative: vitest runs from the project root, and
  // `import.meta.url` is not a file: URL under the jsdom environment.
  [...readFileSync("src/theme/tokens.css", "utf8").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(
    (m) => m[1] as string,
  ),
);

/** Every declaration value in the chrome spec, flattened. */
function declarationValues(): string[] {
  return Object.values(EDITOR_CHROME).flatMap((rule) => Object.values(rule));
}

describe("viewer editor chrome", () => {
  it("expresses every colour as a preset variable, never a literal", () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
    for (const value of declarationValues()) {
      expect(
        literal.test(value),
        `"${value}" hardcodes a colour; the viewer must follow the active preset`,
      ).toBe(false);
    }
  });

  it("only references variables tokens.css defines", () => {
    // A `var(--x, fallback)` is fine even when --x is written only
    // at runtime — the fallback covers the pre-JS paint window — so
    // only bare references have to resolve against tokens.css.
    const bare = /var\(\s*(--[a-z0-9-]+)\s*\)/g;
    for (const value of declarationValues()) {
      for (const [, name] of value.matchAll(bare)) {
        expect(
          definedTokens.has(name as string),
          `${name} is not defined in tokens.css — a typo here renders unstyled, silently`,
        ).toBe(true);
      }
    }
  });

  it("paints the editor surface from the preset, not a fixed palette", () => {
    // The specific regression the One Dark removal fixed.
    expect(EDITOR_CHROME["&"].backgroundColor).toBe("var(--pane)");
    expect(EDITOR_CHROME[".cm-gutters"].backgroundColor).toBe("var(--pane2)");
  });
});
