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
});
