import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, defaultWindowDecorations } from "./preferences";
import type { Platform } from "../lib/platform";

describe("defaultWindowDecorations", () => {
  // The asymmetry is deliberate and mirrors `impl Default for
  // WindowDecorations` in src-tauri/src/preferences.rs. Linux tiling
  // compositors draw their own chrome, so the GTK title bar is
  // redundant; macOS needs decorations for the traffic lights that
  // TitleBar.tsx reserves its left inset for.
  it("is 'none' on Linux", () => {
    expect(defaultWindowDecorations("linux")).toBe("none");
  });

  it("is 'system' on every other platform", () => {
    const others: Platform[] = ["macos", "windows", "other"];
    for (const platform of others) {
      expect(defaultWindowDecorations(platform)).toBe("system");
    }
  });

  it("is reflected in DEFAULT_APPEARANCE", () => {
    // Guards the wiring, not the value — the fallback block the
    // non-Tauri path serves must carry the field at all, or the
    // settings checkbox renders permanently unchecked.
    expect(DEFAULT_APPEARANCE.window_decorations).toBeDefined();
    expect(["system", "none"]).toContain(DEFAULT_APPEARANCE.window_decorations);
  });
});
