/**
 * TitleBar unit tests (jsdom / Vitest).
 *
 * Covers the M2 slice 2.1 tab bar: multi-tab rendering, active marker,
 * switch / new / close callbacks, and the "no close button on the last
 * tab" rule (App handles the leave-one-fresh-tab fallback, but the
 * button shouldn't be there at all when there's only one).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TitleBar } from "./TitleBar";
import type { TabDescriptor } from "./TitleBar";

const noop = (): void => undefined;

afterEach(() => cleanup());

function tab(id: string, label = "shax", cwd: string | null = null): TabDescriptor {
  return { id, label, cwd };
}

describe("TitleBar / structure", () => {
  it("renders the title-bar wrapper", () => {
    render(<TitleBar tabs={[tab("a")]} activeId="a" onSwitch={noop} onNew={noop} onClose={noop} />);
    expect(screen.getByTestId("title-bar")).toBeInTheDocument();
  });

  it("renders the right-side toolbar group", () => {
    render(<TitleBar tabs={[tab("a")]} activeId="a" onSwitch={noop} onNew={noop} onClose={noop} />);
    expect(screen.getByTestId("title-toolbar")).toBeInTheDocument();
  });

  it("renders a + button for opening a new tab", () => {
    render(<TitleBar tabs={[tab("a")]} activeId="a" onSwitch={noop} onNew={noop} onClose={noop} />);
    expect(screen.getByTestId("title-new-tab")).toBeInTheDocument();
  });
});

describe("TitleBar / tab list", () => {
  it("renders one pill per tab with the supplied label and cwd", () => {
    render(
      <TitleBar
        tabs={[tab("a", "zsh", "/Users/ada/dev/shax"), tab("b", "shax", null)]}
        activeId="a"
        onSwitch={noop}
        onNew={noop}
        onClose={noop}
      />,
    );
    const pills = screen.getAllByTestId("title-tab");
    expect(pills).toHaveLength(2);
    expect(pills[0]).toHaveTextContent("zsh");
    expect(pills[0]).toHaveTextContent("/Users/ada/dev/shax");
    // Inactive tab still shows the fallback cwd.
    expect(pills[1]).toHaveTextContent("—");
  });

  it("marks exactly one tab as active via data-active", () => {
    render(
      <TitleBar
        tabs={[tab("a"), tab("b"), tab("c")]}
        activeId="b"
        onSwitch={noop}
        onNew={noop}
        onClose={noop}
      />,
    );
    const pills = screen.getAllByTestId("title-tab");
    const actives = pills.filter((p) => p.getAttribute("data-active") === "true");
    expect(actives).toHaveLength(1);
    expect(actives[0]).toHaveAttribute("data-tab-id", "b");
  });
});

describe("TitleBar / interactions", () => {
  it("clicking a tab calls onSwitch with its id", () => {
    const onSwitch = vi.fn();
    render(
      <TitleBar
        tabs={[tab("a"), tab("b")]}
        activeId="a"
        onSwitch={onSwitch}
        onNew={noop}
        onClose={noop}
      />,
    );
    const second = screen.getAllByTestId("title-tab")[1];
    if (second !== undefined) fireEvent.click(second);
    expect(onSwitch).toHaveBeenCalledWith("b");
  });

  it("clicking the + button calls onNew", () => {
    const onNew = vi.fn();
    render(
      <TitleBar tabs={[tab("a")]} activeId="a" onSwitch={noop} onNew={onNew} onClose={noop} />,
    );
    fireEvent.click(screen.getByTestId("title-new-tab"));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("clicking a tab's × calls onClose without bubbling into onSwitch", () => {
    const onSwitch = vi.fn();
    const onClose = vi.fn();
    render(
      <TitleBar
        tabs={[tab("a"), tab("b")]}
        activeId="a"
        onSwitch={onSwitch}
        onNew={noop}
        onClose={onClose}
      />,
    );
    const closes = screen.getAllByTestId("title-tab-close");
    if (closes[1] !== undefined) fireEvent.click(closes[1]);
    expect(onClose).toHaveBeenCalledWith("b");
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("does not render a × on the last remaining tab", () => {
    render(<TitleBar tabs={[tab("a")]} activeId="a" onSwitch={noop} onNew={noop} onClose={noop} />);
    expect(screen.queryAllByTestId("title-tab-close")).toHaveLength(0);
  });
});
