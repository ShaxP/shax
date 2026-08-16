import { StrictMode } from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";

import { SidebarTogglePanel } from "./SidebarTogglePanel";

const CTX = {
  ptyId: "pty-1",
  cwd: "/tmp",
  branch: null,
  gitRoot: null,
} as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe("SidebarTogglePanel", () => {
  it("dispatches shax:toggle-sidebar on mount and closes the palette", () => {
    const toggleListener = vi.fn();
    window.addEventListener("shax:toggle-sidebar", toggleListener);
    const onSubmit = vi.fn();
    try {
      render(<SidebarTogglePanel ctx={CTX} onSubmit={onSubmit} />);
      expect(toggleListener).toHaveBeenCalledTimes(1);
      // Panel closes the palette by passing null (no shell command to emit).
      expect(onSubmit).toHaveBeenCalledWith(null);
    } finally {
      window.removeEventListener("shax:toggle-sidebar", toggleListener);
    }
  });

  it("dispatches EXACTLY ONCE under React.StrictMode (regression: dev double-toggle)", () => {
    // Dev builds mount inside <React.StrictMode>, which double-invokes
    // useEffect on mount. Without a mount-ref guard the panel would
    // dispatch shax:toggle-sidebar twice, cancelling out the toggle and
    // making the palette command look like a no-op. Reported by the
    // user on the first M13.1 build; the ref-guard in the effect body
    // is what fixes it.
    const toggleListener = vi.fn();
    window.addEventListener("shax:toggle-sidebar", toggleListener);
    const onSubmit = vi.fn();
    try {
      render(
        <StrictMode>
          <SidebarTogglePanel ctx={CTX} onSubmit={onSubmit} />
        </StrictMode>,
      );
      expect(toggleListener).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("shax:toggle-sidebar", toggleListener);
    }
  });
});
