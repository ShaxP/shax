/**
 * Statusline unit tests (jsdom / Vitest).
 *
 * Visual-only component: assertions cover the mode pill (all four
 * states + alt-screen cwd chip), vi sub-mode, identity + clock
 * cluster, and the assistant / approvals chips. cwd + branch props
 * are gone since M12.4 — those live on the prompt strip now.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Statusline } from "./Statusline";

afterEach(() => {
  cleanup();
});

describe("Statusline / mode pill", () => {
  it("renders the wrapper and defaults to the COMMAND pill", () => {
    render(<Statusline />);
    expect(screen.getByTestId("statusline")).toBeInTheDocument();
    const pill = screen.getByTestId("statusline-mode");
    expect(pill).toHaveTextContent("COMMAND");
    expect(pill).toHaveAttribute("data-mode", "COMMAND");
  });

  it("shows CHAT when the mode prop is CHAT", () => {
    render(<Statusline mode="CHAT" />);
    expect(screen.getByTestId("statusline-mode")).toHaveTextContent("CHAT");
  });

  it("shows BLOCK when the mode prop is BLOCK", () => {
    render(<Statusline mode="BLOCK" />);
    expect(screen.getByTestId("statusline-mode")).toHaveTextContent("BLOCK");
  });

  // M12.4 — alt-screen INTERACTIVE mode
  it("shows INTERACTIVE with the cwd chip when mode is INTERACTIVE + interactiveCwd", () => {
    render(<Statusline mode="INTERACTIVE" interactiveCwd="~/dev/shax" />);
    expect(screen.getByTestId("statusline-mode")).toHaveTextContent("INTERACTIVE");
    expect(screen.getByTestId("statusline-interactive-cwd")).toHaveTextContent("~/dev/shax");
  });

  it("INTERACTIVE without a cwd doesn't render the cwd chip", () => {
    render(<Statusline mode="INTERACTIVE" />);
    expect(screen.queryByTestId("statusline-interactive-cwd")).toBeNull();
  });

  it("cwd chip only appears alongside INTERACTIVE, not other modes", () => {
    const { rerender } = render(<Statusline mode="COMMAND" interactiveCwd="~/dev/shax" />);
    expect(screen.queryByTestId("statusline-interactive-cwd")).toBeNull();
    rerender(<Statusline mode="CHAT" interactiveCwd="~/dev/shax" />);
    expect(screen.queryByTestId("statusline-interactive-cwd")).toBeNull();
    rerender(<Statusline mode="BLOCK" interactiveCwd="~/dev/shax" />);
    expect(screen.queryByTestId("statusline-interactive-cwd")).toBeNull();
  });

  it("BLOCK gets a distinct amber background from COMMAND / CHAT", () => {
    const { rerender } = render(<Statusline mode="COMMAND" />);
    const commandBg = screen.getByTestId("statusline-mode").style.background;
    rerender(<Statusline mode="CHAT" />);
    const chatBg = screen.getByTestId("statusline-mode").style.background;
    rerender(<Statusline mode="BLOCK" />);
    const blockBg = screen.getByTestId("statusline-mode").style.background;
    expect(chatBg).toBe(commandBg);
    expect(blockBg).not.toBe(commandBg);
  });

  it("INTERACTIVE gets its own distinct background (cyan)", () => {
    const { rerender } = render(<Statusline mode="COMMAND" />);
    const commandBg = screen.getByTestId("statusline-mode").style.background;
    rerender(<Statusline mode="BLOCK" />);
    const blockBg = screen.getByTestId("statusline-mode").style.background;
    rerender(<Statusline mode="INTERACTIVE" />);
    const interactiveBg = screen.getByTestId("statusline-mode").style.background;
    // Must be distinct from BOTH the accent (COMMAND / CHAT) and
    // amber (BLOCK) so the four states are all visually separable.
    expect(interactiveBg).not.toBe(commandBg);
    expect(interactiveBg).not.toBe(blockBg);
  });
});

describe("Statusline / vi sub-mode chip (M12.2)", () => {
  it("hides the vi sub-chip by default", () => {
    render(<Statusline mode="COMMAND" viKeymap={null} />);
    expect(screen.queryByTestId("statusline-vi-submode")).toBeNull();
  });

  it("renders INSERT/NORMAL/VISUAL for the known keymaps on COMMAND", () => {
    const { rerender } = render(<Statusline mode="COMMAND" viKeymap="viins" />);
    expect(screen.getByTestId("statusline-vi-submode")).toHaveTextContent("INSERT");
    rerender(<Statusline mode="COMMAND" viKeymap="vicmd" />);
    expect(screen.getByTestId("statusline-vi-submode")).toHaveTextContent("NORMAL");
    rerender(<Statusline mode="COMMAND" viKeymap="visual" />);
    expect(screen.getByTestId("statusline-vi-submode")).toHaveTextContent("VISUAL");
  });

  it("hides the sub-chip when mode is INTERACTIVE (vim owns modality)", () => {
    render(<Statusline mode="INTERACTIVE" interactiveCwd="~/dev/shax" viKeymap="vicmd" />);
    expect(screen.queryByTestId("statusline-vi-submode")).toBeNull();
  });
});

// ── M12.4: identity + clock ─────────────────────────────────────────

describe("Statusline / identity chip (M12.4)", () => {
  it("renders `user@host` when both are supplied", () => {
    render(<Statusline user="me" host="laptop" />);
    expect(screen.getByTestId("statusline-identity")).toHaveTextContent("me@laptop");
  });

  it("renders only user when host is missing (graceful degradation)", () => {
    render(<Statusline user="me" host={null} />);
    expect(screen.getByTestId("statusline-identity")).toHaveTextContent("me");
  });

  it("hides the identity chip when both user and host are null", () => {
    render(<Statusline />);
    expect(screen.queryByTestId("statusline-identity")).toBeNull();
  });
});

describe("Statusline / clock chip (M12.4)", () => {
  it("renders the supplied clock string", () => {
    render(<Statusline clock="13:37:02" />);
    expect(screen.getByTestId("statusline-clock")).toHaveTextContent("13:37:02");
  });

  it("hides the clock chip when clock is null", () => {
    render(<Statusline />);
    expect(screen.queryByTestId("statusline-clock")).toBeNull();
  });

  it("passes clockTooltip through as the title attribute for hover", () => {
    render(<Statusline clock="13:37:02" clockTooltip="Monday, August 12, 2026" />);
    const chip = screen.getByTestId("statusline-clock");
    expect(chip).toHaveAttribute("title", "Monday, August 12, 2026");
  });
});

// ── M7.7b chips (unchanged from earlier slices) ─────────────────────

describe("Statusline / assistant-dock indicators", () => {
  it("shows the assistant-active indicator when the dock is open", () => {
    render(<Statusline assistantActive />);
    const indicator = screen.getByTestId("statusline-assistant-active");
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent(/assistant active/i);
  });

  it("hides the assistant-active indicator when the dock is closed", () => {
    render(<Statusline assistantActive={false} />);
    expect(screen.queryByTestId("statusline-assistant-active")).toBeNull();
  });

  it("shows the approval-pending chip with the count when > 0", () => {
    render(<Statusline approvalsPending={1} />);
    const chip = screen.getByTestId("statusline-approvals-pending");
    expect(chip).toHaveTextContent(/1 approval pending/i);
  });

  it("hides the approval-pending chip when the count is 0", () => {
    render(<Statusline approvalsPending={0} />);
    expect(screen.queryByTestId("statusline-approvals-pending")).toBeNull();
  });
});

// ── M12.4: removed items — regression guard against re-introducing dupes

describe("Statusline / M12.4 removed items", () => {
  it("does not render a cwd chip in the resting statusbar (moved to prompt strip)", () => {
    render(<Statusline mode="COMMAND" />);
    expect(screen.queryByTestId("statusline-cwd")).toBeNull();
  });

  it("does not render a branch chip (moved to prompt strip)", () => {
    render(<Statusline mode="COMMAND" />);
    expect(screen.queryByTestId("statusline-branch")).toBeNull();
  });

  it("does not render the utf-8 placeholder", () => {
    render(<Statusline mode="COMMAND" />);
    expect(screen.queryByText(/utf-8/i)).toBeNull();
  });

  it("does not render the ⌘K Ask Shax hint (dedup with the top bar)", () => {
    render(<Statusline mode="COMMAND" />);
    expect(screen.queryByText(/Ask Shax/i)).toBeNull();
  });
});
