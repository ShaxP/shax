import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, resolveTheme, systemTheme } from "./theme";

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

describe("resolveTheme", () => {
  beforeEach(() => {
    fakeMatchMedia(false);
  });

  it("passes concrete themes through unchanged", () => {
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });

  it("maps `system` to whatever `prefers-color-scheme` reports", () => {
    fakeMatchMedia(true);
    expect(resolveTheme("system")).toBe("light");
    fakeMatchMedia(false);
    expect(resolveTheme("system")).toBe("dark");
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
    fakeMatchMedia(false);
  });

  it('writes `data-theme="dark"` on the document root for the dark preference', () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it('writes `data-theme="light"` for the light preference', () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("resolves `system` at apply time from the current media query", () => {
    fakeMatchMedia(true);
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fakeMatchMedia(false);
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("re-resolves when the OS flips between dark and light under system mode", () => {
    const { flip } = fakeMatchMedia(false);
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    flip(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    flip(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("stops listening to the media query when switching from system to a concrete theme", () => {
    const { mql, flip } = fakeMatchMedia(false);
    applyTheme("system");
    applyTheme("dark");
    // Manually flip the OS — should NOT touch data-theme
    // because the listener was detached.
    flip(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(mql.removeEventListener).toHaveBeenCalled();
  });
});
