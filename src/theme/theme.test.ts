import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../lib/ipc";
import { DEFAULT_APPEARANCE, type Preferences } from "./preferences";
import { applyTheme, findPreset, resolveActivePresetId, systemTheme } from "./theme";

// Small helper to fake the `prefers-color-scheme` media
// query. jsdom returns a stubbed MediaQueryList that always
// reports `matches: false` and never fires change events;
// this replaces `window.matchMedia` with a version we can
// control.
function fakeMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: "(prefers-color-scheme: light)",
    addEventListener: vi.fn((_event: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    }),
    removeEventListener: vi.fn((_event: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.delete(cb);
    }),
  };
  window.matchMedia = (): MediaQueryList => mql as unknown as MediaQueryList;
  return {
    mql,
    flip: (newMatches: boolean): void => {
      mql.matches = newMatches;
      for (const cb of listeners) {
        cb({ matches: newMatches } as MediaQueryListEvent);
      }
    },
  };
}

// Fixture presets — minimal shape, just enough to
// exercise the applier. Real presets ship in the M10.1
// catalog and have identical structure.
const DARK_PRESET: Theme = {
  id: "shax-dark",
  name: "Shax Dark",
  mode: "dark",
  source: "test",
  license: "test",
  chrome: {
    bg: "#111111",
    fg: "#eeeeee",
  },
  terminal: {
    foreground: "#eeeeee",
    background: "#111111",
    cursor: "#7ea6d8",
    selectionBackground: "#333333",
    ansi: {
      black: "#000",
      red: "#f00",
      green: "#0f0",
      yellow: "#ff0",
      blue: "#00f",
      magenta: "#f0f",
      cyan: "#0ff",
      white: "#fff",
      brightBlack: "#111",
      brightRed: "#f11",
      brightGreen: "#1f1",
      brightYellow: "#ff1",
      brightBlue: "#11f",
      brightMagenta: "#f1f",
      brightCyan: "#1ff",
      brightWhite: "#eee",
    },
  },
  syntax: {
    comment: "#666",
    keyword: "#c678dd",
    string: "#98c379",
    number: "#d19a66",
    literal: "#56b6c2",
    builtin: "#e6c07b",
    name: "#e06c75",
    title: "#61aeee",
    type: "#d19a66",
  },
  warning: "#f00",
  caution: "#ff0",
  match: "#ff0",
};

const LIGHT_PRESET: Theme = {
  ...DARK_PRESET,
  id: "shax-light",
  name: "Shax Light",
  mode: "light",
  chrome: {
    bg: "#fafaf7",
    fg: "#1a1c22",
  },
};

const CATALOG: Theme[] = [DARK_PRESET, LIGHT_PRESET];

function prefsWith(overrides: Partial<Preferences>): Preferences {
  return {
    theme: "system",
    assistant_docked: false,
    assistant_dock_width: 420,
    appearance: DEFAULT_APPEARANCE,
    ...overrides,
  };
}

describe("resolveActivePresetId", () => {
  it("returns theme_light for the light mode", () => {
    expect(resolveActivePresetId(prefsWith({ theme: "light" }), "dark")).toBe("shax-light");
  });

  it("returns theme_dark for the dark mode", () => {
    expect(resolveActivePresetId(prefsWith({ theme: "dark" }), "light")).toBe("shax-dark");
  });

  it("picks theme_light in system mode when the OS reports light", () => {
    expect(resolveActivePresetId(prefsWith({ theme: "system" }), "light")).toBe("shax-light");
  });

  it("picks theme_dark in system mode when the OS reports dark", () => {
    expect(resolveActivePresetId(prefsWith({ theme: "system" }), "dark")).toBe("shax-dark");
  });

  it("honours a non-default preset id in appearance", () => {
    const prefs = prefsWith({
      theme: "dark",
      appearance: { ...DEFAULT_APPEARANCE, theme_dark: "catppuccin-mocha" },
    });
    expect(resolveActivePresetId(prefs, "dark")).toBe("catppuccin-mocha");
  });
});

describe("findPreset", () => {
  it("returns the matching preset", () => {
    expect(findPreset(CATALOG, "shax-light")?.id).toBe("shax-light");
  });

  it("returns null when the id is unknown", () => {
    expect(findPreset(CATALOG, "does-not-exist")).toBeNull();
  });

  it("returns null when the catalog is empty (boot race)", () => {
    expect(findPreset([], "shax-dark")).toBeNull();
  });
});

describe("systemTheme", () => {
  it("returns light when prefers-color-scheme: light matches", () => {
    fakeMatchMedia(true);
    expect(systemTheme()).toBe("light");
  });

  it("returns dark when prefers-color-scheme: light does NOT match", () => {
    fakeMatchMedia(false);
    expect(systemTheme()).toBe("dark");
  });
});

describe("applyTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
    fakeMatchMedia(false);
  });

  it('writes `data-theme="dark"` on the document root when the active preset is dark', () => {
    applyTheme(prefsWith({ theme: "dark" }), CATALOG);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it('writes `data-theme="light"` when the active preset is light', () => {
    applyTheme(prefsWith({ theme: "light" }), CATALOG);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("writes the preset's chrome colours as CSS custom properties on :root", () => {
    applyTheme(prefsWith({ theme: "dark" }), CATALOG);
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#111111");
    expect(document.documentElement.style.getPropertyValue("--fg")).toBe("#eeeeee");
  });

  it("writes the preset's ANSI 16 as --ansi-* CSS custom properties", () => {
    applyTheme(prefsWith({ theme: "dark" }), CATALOG);
    expect(document.documentElement.style.getPropertyValue("--ansi-red")).toBe("#f00");
    expect(document.documentElement.style.getPropertyValue("--ansi-bright-white")).toBe("#eee");
  });

  it("writes the preset's syntax colours as --syntax-* CSS custom properties", () => {
    applyTheme(prefsWith({ theme: "dark" }), CATALOG);
    expect(document.documentElement.style.getPropertyValue("--syntax-keyword")).toBe("#c678dd");
  });

  it("resolves `system` at apply time from the current media query", () => {
    fakeMatchMedia(true);
    applyTheme(prefsWith({ theme: "system" }), CATALOG);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fakeMatchMedia(false);
    applyTheme(prefsWith({ theme: "system" }), CATALOG);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("re-resolves when the OS flips between dark and light under system mode", () => {
    const { flip } = fakeMatchMedia(false);
    applyTheme(prefsWith({ theme: "system" }), CATALOG);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    flip(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    flip(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("stops listening to the media query when switching from system to a concrete theme", () => {
    const { mql, flip } = fakeMatchMedia(false);
    applyTheme(prefsWith({ theme: "system" }), CATALOG);
    applyTheme(prefsWith({ theme: "dark" }), CATALOG);
    // Manually flip the OS — should NOT touch data-theme
    // because the listener was detached.
    flip(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(mql.removeEventListener).toHaveBeenCalled();
  });

  it("falls back to data-theme only when the catalog is empty (boot race)", () => {
    // Boot race — the preferences load resolved before
    // the catalog IPC. `applyTheme` must not crash and
    // must at least set `data-theme` so tokens.css can
    // render the pre-JS fallback palette.
    applyTheme(prefsWith({ theme: "dark" }), []);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // Chrome vars remain unset — the :root fallback in
    // tokens.css covers them.
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
  });

  it("falls back to data-theme only when the preset id doesn't resolve", () => {
    // User has a preferences.json that references a
    // renamed preset id. Falls back gracefully.
    const prefs = prefsWith({
      theme: "dark",
      appearance: { ...DEFAULT_APPEARANCE, theme_dark: "gone-in-a-rename" },
    });
    applyTheme(prefs, CATALOG);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
  });

  // ── M10.3 appearance vars ─────────────────────────────────

  it("writes the default font stack when font_family is null", () => {
    applyTheme(prefsWith({ theme: "dark" }), CATALOG);
    const stack = document.documentElement.style.getPropertyValue("--font-mono");
    expect(stack).toContain('"JetBrains Mono"');
    expect(stack).toContain('"Fira Code"');
    expect(stack).toContain("monospace");
  });

  it("puts the user's chosen font first in the --font-mono stack", () => {
    const prefs = prefsWith({
      theme: "dark",
      appearance: { ...DEFAULT_APPEARANCE, font_family: "Menlo" },
    });
    applyTheme(prefs, CATALOG);
    const stack = document.documentElement.style.getPropertyValue("--font-mono");
    expect(stack.startsWith("Menlo,")).toBe(true);
  });

  it("writes --font-size-terminal in px from font_size", () => {
    const prefs = prefsWith({
      theme: "dark",
      appearance: { ...DEFAULT_APPEARANCE, font_size: 18 },
    });
    applyTheme(prefs, CATALOG);
    expect(document.documentElement.style.getPropertyValue("--font-size-terminal")).toBe("18px");
  });

  it("writes appearance vars even when the catalog is empty (boot race)", () => {
    // Boot ordering: preferences may load before the theme
    // catalog IPC returns. Font family + size shouldn't
    // depend on the preset being resolved — they're user
    // preferences, orthogonal to preset.
    applyTheme(prefsWith({ theme: "dark", appearance: DEFAULT_APPEARANCE }), []);
    expect(document.documentElement.style.getPropertyValue("--font-mono")).not.toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-size-terminal")).toBe("13px");
  });

  it("writes both --terminal-ligatures and --terminal-font-features = normal when ligatures is true", () => {
    // M10.4 bug fix: the preference must drive CSS vars,
    // which tokens.css's `:root, .xterm` rule inherits to
    // every mono surface (prompt strip, code viewer, ...).
    // Both properties are written because font-feature-
    // settings overrides font-variant-* per CSS spec —
    // covering both means consumers that set either one
    // inline still see the correct final value.
    applyTheme(
      prefsWith({
        theme: "dark",
        appearance: { ...DEFAULT_APPEARANCE, ligatures: true },
      }),
      CATALOG,
    );
    expect(document.documentElement.style.getPropertyValue("--terminal-ligatures")).toBe("normal");
    expect(document.documentElement.style.getPropertyValue("--terminal-font-features")).toBe(
      "normal",
    );
  });

  it("writes --terminal-ligatures = none + explicit feature-off list when ligatures is false", () => {
    applyTheme(
      prefsWith({
        theme: "dark",
        appearance: { ...DEFAULT_APPEARANCE, ligatures: false },
      }),
      CATALOG,
    );
    expect(document.documentElement.style.getPropertyValue("--terminal-ligatures")).toBe("none");
    expect(document.documentElement.style.getPropertyValue("--terminal-font-features")).toBe(
      '"liga" 0, "clig" 0, "calt" 0',
    );
  });
});
