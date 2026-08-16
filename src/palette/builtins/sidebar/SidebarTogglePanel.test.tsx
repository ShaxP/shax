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
});
