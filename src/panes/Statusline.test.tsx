/**
 * Statusline unit tests (jsdom / Vitest).
 *
 * Visual-only component: assertions cover the modal pill, branch/cwd
 * presentation, and the neutral fallback when either is null.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Statusline } from "./Statusline";

afterEach(() => {
  cleanup();
});

describe("Statusline", () => {
  it("renders the statusline wrapper and the COMMAND mode pill by default", () => {
    render(<Statusline cwd={null} branch={null} />);
    expect(screen.getByTestId("statusline")).toBeInTheDocument();
    const pill = screen.getByTestId("statusline-mode");
    expect(pill).toHaveTextContent("COMMAND");
    expect(pill).toHaveAttribute("data-mode", "COMMAND");
  });

  // M12.1 — three-way modal indicator (COMMAND / CHAT / BLOCK)
  it("shows CHAT when the mode prop is CHAT", () => {
    render(<Statusline cwd={null} branch={null} mode="CHAT" />);
    const pill = screen.getByTestId("statusline-mode");
    expect(pill).toHaveTextContent("CHAT");
    expect(pill).toHaveAttribute("data-mode", "CHAT");
  });

  it("shows BLOCK when the mode prop is BLOCK", () => {
    render(<Statusline cwd={null} branch={null} mode="BLOCK" />);
    const pill = screen.getByTestId("statusline-mode");
    expect(pill).toHaveTextContent("BLOCK");
    expect(pill).toHaveAttribute("data-mode", "BLOCK");
  });

  it("uses a distinct amber background for BLOCK versus the accent used for COMMAND/CHAT", () => {
    const { rerender } = render(<Statusline cwd={null} branch={null} mode="COMMAND" />);
    const commandBg = screen.getByTestId("statusline-mode").style.background;
    rerender(<Statusline cwd={null} branch={null} mode="CHAT" />);
    const chatBg = screen.getByTestId("statusline-mode").style.background;
    rerender(<Statusline cwd={null} branch={null} mode="BLOCK" />);
    const blockBg = screen.getByTestId("statusline-mode").style.background;
    // COMMAND and CHAT both signal "active surface with the accent" — same color.
    expect(chatBg).toBe(commandBg);
    // BLOCK is the odd surface out — must be visually distinct.
    expect(blockBg).not.toBe(commandBg);
  });

  it("shows neutral fallbacks when cwd and branch are null", () => {
    render(<Statusline cwd={null} branch={null} />);
    expect(screen.getByTestId("statusline-cwd")).toHaveTextContent("—");
    expect(screen.getByTestId("statusline-branch")).toHaveTextContent("—");
  });

  it("renders the supplied cwd and branch", () => {
    render(<Statusline cwd="/Users/ada/dev/shax" branch="main" />);
    expect(screen.getByTestId("statusline-cwd")).toHaveTextContent("/Users/ada/dev/shax");
    expect(screen.getByTestId("statusline-branch")).toHaveTextContent("main");
  });

  // M7.7b — assistant-dock indicators
  it("shows the assistant-active indicator when the dock is open", () => {
    render(<Statusline cwd={null} branch={null} assistantActive />);
    const indicator = screen.getByTestId("statusline-assistant-active");
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent(/assistant active/i);
  });

  it("hides the assistant-active indicator when the dock is closed", () => {
    render(<Statusline cwd={null} branch={null} assistantActive={false} />);
    expect(screen.queryByTestId("statusline-assistant-active")).toBeNull();
  });

  it("shows the approval-pending chip with the count when > 0", () => {
    render(<Statusline cwd={null} branch={null} approvalsPending={1} />);
    const chip = screen.getByTestId("statusline-approvals-pending");
    expect(chip).toHaveTextContent(/1 approval pending/i);
  });

  it("hides the approval-pending chip when the count is 0", () => {
    render(<Statusline cwd={null} branch={null} approvalsPending={0} />);
    expect(screen.queryByTestId("statusline-approvals-pending")).toBeNull();
  });
});
