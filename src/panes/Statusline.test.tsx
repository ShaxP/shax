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
  it("renders the statusline wrapper and the NORMAL mode pill", () => {
    render(<Statusline cwd={null} branch={null} />);
    expect(screen.getByTestId("statusline")).toBeInTheDocument();
    expect(screen.getByTestId("statusline-mode")).toHaveTextContent("NORMAL");
  });

  // M7.7c — modal indicator
  it("shows INSERT when the mode prop is INSERT", () => {
    render(<Statusline cwd={null} branch={null} mode="INSERT" />);
    const pill = screen.getByTestId("statusline-mode");
    expect(pill).toHaveTextContent("INSERT");
    expect(pill).toHaveAttribute("data-mode", "INSERT");
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
