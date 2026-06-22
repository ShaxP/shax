/**
 * TitleBar unit tests (jsdom / Vitest).
 *
 * Visual-only component: assertions cover structure (traffic lights, active
 * tab pill, toolbar icons) and the cwd / tabLabel rendering paths.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TitleBar } from "./TitleBar";

afterEach(() => {
  cleanup();
});

describe("TitleBar", () => {
  it("renders the title-bar wrapper", () => {
    render(<TitleBar cwd={null} />);
    expect(screen.getByTestId("title-bar")).toBeInTheDocument();
  });

  it("renders the active tab pill with the default label and a fallback cwd", () => {
    render(<TitleBar cwd={null} />);
    const tab = screen.getByTestId("active-tab");
    expect(tab).toBeInTheDocument();
    expect(tab).toHaveTextContent("shax");
    expect(tab).toHaveTextContent("—");
  });

  it("renders the supplied cwd and custom tab label", () => {
    render(<TitleBar cwd="/Users/ada/dev/shax" tabLabel="zsh" />);
    const tab = screen.getByTestId("active-tab");
    expect(tab).toHaveTextContent("zsh");
    expect(tab).toHaveTextContent("/Users/ada/dev/shax");
  });

  it("renders the right-side toolbar group", () => {
    render(<TitleBar cwd={null} />);
    expect(screen.getByTestId("title-toolbar")).toBeInTheDocument();
  });
});
