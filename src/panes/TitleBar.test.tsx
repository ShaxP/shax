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

// ── M12 focus close-out: tab click keeps keys landing on the prompt

describe("TitleBar / tab click focus (M12 close-out)", () => {
  function countRefocusEvents(fn: () => void): number {
    let count = 0;
    const listener = (): void => {
      count += 1;
    };
    window.addEventListener("shax:refocus-pane", listener);
    try {
      fn();
    } finally {
      window.removeEventListener("shax:refocus-pane", listener);
    }
    return count;
  }

  it("mousedown on a tab pill fires shax:refocus-pane and preventDefaults", () => {
    // Regression guard for the "click the current tab → mode chip
    // flips to COMMAND but typing goes nowhere" bug. The pill is a
    // <div> (not a native focusable); its mousedown default
    // behaviour would blur whatever currently owns focus and let
    // it fall to `<body>`. preventDefault stops that, and
    // shax:refocus-pane routes focus back to the active pane's
    // prompt.
    render(
      <TitleBar
        tabs={[tab("a"), tab("b")]}
        activeId="a"
        onSwitch={noop}
        onNew={noop}
        onClose={noop}
      />,
    );
    const pills = screen.getAllByTestId("title-tab");
    const evt = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    let refocused = 0;
    const listener = (): void => {
      refocused += 1;
    };
    window.addEventListener("shax:refocus-pane", listener);
    try {
      pills[0]?.dispatchEvent(evt);
      expect(evt.defaultPrevented).toBe(true);
      expect(refocused).toBe(1);
    } finally {
      window.removeEventListener("shax:refocus-pane", listener);
    }
  });

  it("mousedown on the tab close × does NOT preventDefault or refocus", () => {
    // The close-button glyph handles its own click via
    // stopPropagation on click. Its mousedown must NOT be
    // shadowed by the tab-pill's focus-preservation logic —
    // otherwise clicking × would spuriously refocus the pane
    // whose tab just closed.
    render(
      <TitleBar
        tabs={[tab("a"), tab("b")]}
        activeId="a"
        onSwitch={noop}
        onNew={noop}
        onClose={noop}
      />,
    );
    const closes = screen.getAllByTestId("title-tab-close");
    const evt = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    const n = countRefocusEvents(() => {
      closes[0]?.dispatchEvent(evt);
    });
    expect(evt.defaultPrevented).toBe(false);
    expect(n).toBe(0);
  });

  it("right-click on a tab pill does not fire refocus", () => {
    render(<TitleBar tabs={[tab("a")]} activeId="a" onSwitch={noop} onNew={noop} onClose={noop} />);
    const pills = screen.getAllByTestId("title-tab");
    const evt = new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true });
    const n = countRefocusEvents(() => {
      pills[0]?.dispatchEvent(evt);
    });
    expect(n).toBe(0);
  });

  it("clicking a tab still calls onSwitch (regression guard)", () => {
    // preventDefault on mousedown does not block the onClick that
    // follows; the tab-switch behaviour must still work.
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
    const pills = screen.getAllByTestId("title-tab");
    if (pills[1] !== undefined) fireEvent.click(pills[1]);
    expect(onSwitch).toHaveBeenCalledWith("b");
  });
});
