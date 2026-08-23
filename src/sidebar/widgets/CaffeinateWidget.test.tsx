/**
 * CaffeinateWidget tests (M13.4, spec §19 D6).
 *
 * The contract under test is that the widget never claims a state the
 * OS did not grant:
 *   - off → on asks the backend and adopts what it returns
 *   - a backend that grants nothing leaves the widget off
 *   - a rejected request leaves the widget off and says why
 *   - a window opening onto an already-held assertion adopts it, and
 *     dates it from the backend's start time rather than its own mount
 *   - a change made in ANY window reaches every other window's widget
 *   - the duration reads from the shared clock tick
 *   - no pane is involved at any point — this is app state (D6)
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const keepAwakeMock = vi.hoisted(() => vi.fn());
const keepAwakeStateMock = vi.hoisted(() => vi.fn());
/** Captures the widget's cross-window subscriber so tests can push a
 *  change through it, standing in for another window's toggle. */
const changeHandlers = vi.hoisted(() => [] as Array<(s: unknown) => void>);
vi.mock("../../lib/ipc", () => ({
  powerKeepAwake: keepAwakeMock,
  powerKeepAwakeState: keepAwakeStateMock,
  onKeepAwakeChanged: (handler: (s: unknown) => void) => {
    changeHandlers.push(handler);
    return () => {
      const i = changeHandlers.indexOf(handler);
      if (i >= 0) changeHandlers.splice(i, 1);
    };
  },
}));

/** Simulate the backend broadcasting a change made in another window. */
function broadcast(state: { held: boolean; since_ms: number | null }): void {
  act(() => {
    for (const handler of [...changeHandlers]) handler(state);
  });
}

const HELD = { held: true, since_ms: 1_767_225_600_000 };
const OFF = { held: false, since_ms: null };

const platformMock = vi.hoisted(() => vi.fn(() => "macos"));
vi.mock("../../lib/platform", () => ({ currentPlatform: platformMock }));

import { ClockProvider } from "../../lib/ClockContext";
import { CaffeinateWidget } from "./CaffeinateWidget";

afterEach(cleanup);

beforeEach(() => {
  changeHandlers.length = 0;
  keepAwakeMock
    .mockReset()
    .mockImplementation((enable: boolean) =>
      Promise.resolve(enable ? { held: true, since_ms: Date.now() } : OFF),
    );
  keepAwakeStateMock.mockReset().mockResolvedValue(OFF);
  platformMock.mockReturnValue("macos");
});

function renderWidget(clock: Date = new Date(2026, 0, 1, 12, 0, 0)) {
  return render(
    <ClockProvider value={clock}>
      <CaffeinateWidget visible={true} />
    </ClockProvider>,
  );
}

function toggle(): HTMLElement {
  return screen.getByTestId("sidebar-caffeinate-switch");
}

describe("CaffeinateWidget / turning on", () => {
  it("asks the backend for the assertion and adopts the granted state", async () => {
    renderWidget();
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    expect(keepAwakeMock).toHaveBeenCalledWith(true);
  });

  it("involves no pane — this is app state, not shell state (spec §D6)", async () => {
    // The widget renders with no FocusedPaneProvider ancestor at all.
    // Under the previous emit-into-the-pane design it could not work
    // without one; now a pane is simply irrelevant to it.
    renderWidget();
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
  });

  it("turns back off and asks the backend to release", async () => {
    renderWidget();
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "false"));
    expect(keepAwakeMock).toHaveBeenLastCalledWith(false);
  });
});

describe("CaffeinateWidget / the OS is the source of truth", () => {
  it("stays off when the backend grants nothing (no Tauri host)", async () => {
    // `powerKeepAwake` resolves false outside Tauri — there is no OS
    // to keep awake. A widget that flipped on regardless would be
    // showing state that does not exist.
    keepAwakeMock.mockResolvedValue(OFF);
    renderWidget();
    fireEvent.click(toggle());
    await waitFor(() => expect(keepAwakeMock).toHaveBeenCalled());
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("sidebar-caffeinate-duration")).not.toBeInTheDocument();
  });

  it("reports a rejected request and stays off", async () => {
    keepAwakeMock.mockRejectedValue(new Error("could not start /usr/bin/caffeinate: EPERM"));
    renderWidget();
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByTestId("sidebar-caffeinate-error")).toBeInTheDocument());
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("keeps the full failure in the tooltip and a readable label on the card", async () => {
    // The card is 280px with a nowrap line, so the backend's message
    // is truncated to uselessness if shown raw. The label has to stay
    // short; the detail has to stay reachable.
    const detail = "systemd-inhibit not found; keep-awake needs systemd on this machine";
    keepAwakeMock.mockRejectedValue(new Error(detail));
    renderWidget();
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByTestId("sidebar-caffeinate-error")).toBeInTheDocument());
    const line = screen.getByTestId("sidebar-caffeinate-error");
    expect(line.textContent).toBe("not available on this system");
    expect(line.getAttribute("title")).toBe(detail);
  });

  it("adopts an assertion another window already holds", async () => {
    // The assertion is process-wide, so a second window must read it
    // back rather than rendering a convincing "off" for a machine that
    // is genuinely being kept awake.
    keepAwakeStateMock.mockResolvedValue(HELD);
    renderWidget();
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
  });

  it("dates an adopted assertion from the backend's start time", async () => {
    // The backend owns the start time, so a window that opened long
    // after the assertion began still shows the same duration as the
    // window that started it — rather than no duration, or its own
    // mount time dressed up as one.
    keepAwakeStateMock.mockResolvedValue(HELD);
    render(
      <ClockProvider value={new Date(HELD.since_ms + 134_000)}>
        <CaffeinateWidget visible={true} />
      </ClockProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("sidebar-caffeinate-duration").textContent).toBe(
        "awake for 2m 14s",
      ),
    );
  });
});

describe("CaffeinateWidget / one assertion, many windows", () => {
  it("follows a change made in another window", async () => {
    renderWidget();
    await waitFor(() => expect(keepAwakeStateMock).toHaveBeenCalled());
    expect(toggle()).toHaveAttribute("aria-checked", "false");

    // Another window turned it on. This widget never issued the
    // request, so only the broadcast can tell it.
    broadcast(HELD);
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    expect(keepAwakeMock).not.toHaveBeenCalled();
  });

  it("follows a release made in another window", async () => {
    keepAwakeStateMock.mockResolvedValue(HELD);
    renderWidget();
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));

    broadcast(OFF);
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("sidebar-caffeinate-duration")).not.toBeInTheDocument();
  });

  it("shows the same duration as the window that started it", () => {
    renderWidget(new Date(HELD.since_ms + 45_000));
    broadcast(HELD);
    // 45s after the backend's stamp, not 0s from this widget's own
    // first sight of the assertion.
    expect(screen.getByTestId("sidebar-caffeinate-duration").textContent).toBe("awake for 45s");
  });

  it("unsubscribes on unmount so a dead widget can't be updated", async () => {
    const { unmount } = renderWidget();
    await waitFor(() => expect(keepAwakeStateMock).toHaveBeenCalled());
    expect(changeHandlers).toHaveLength(1);
    unmount();
    expect(changeHandlers).toHaveLength(0);
  });
});

describe("CaffeinateWidget / duration", () => {
  it("derives the running duration from the shared clock tick", async () => {
    const start = new Date(2026, 0, 1, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const { rerender } = render(
      <ClockProvider value={start}>
        <CaffeinateWidget visible={true} />
      </ClockProvider>,
    );
    fireEvent.click(toggle());
    // Flush the backend round-trip while timers are faked.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toggle()).toHaveAttribute("aria-checked", "true");

    const later = new Date(start.getTime() + 134_000);
    rerender(
      <ClockProvider value={later}>
        <CaffeinateWidget visible={true} />
      </ClockProvider>,
    );
    expect(screen.getByTestId("sidebar-caffeinate-duration").textContent).toBe("awake for 2m 14s");
    vi.useRealTimers();
  });
});

describe("CaffeinateWidget / platform wording", () => {
  it("says 'Mac' on macOS", () => {
    platformMock.mockReturnValue("macos");
    renderWidget();
    expect(screen.getByTestId("sidebar-caffeinate-subtitle").textContent).toBe(
      "keep this Mac awake",
    );
  });

  it("says 'computer' elsewhere — including Windows, which is now supported", () => {
    // Windows was deferred under the emit-a-shell-command design
    // because it has no such command. `SetThreadExecutionState` needs
    // none, so the widget is live on all three platforms.
    platformMock.mockReturnValue("windows");
    renderWidget();
    expect(screen.getByTestId("sidebar-caffeinate-subtitle").textContent).toBe(
      "keep this computer awake",
    );
    expect(toggle()).not.toBeDisabled();
  });
});

describe("CaffeinateWidget / platform-honest wording", () => {
  it("does not promise Linux users their screen stays on", () => {
    // `--what=idle` inhibits idle system sleep; screen blanking is the
    // screensaver's business and we don't touch it. Claiming otherwise
    // would promise more than we deliver.
    platformMock.mockReturnValue("linux");
    renderWidget();
    const tooltip = screen.getByTestId("sidebar-caffeinate").getAttribute("title") ?? "";
    expect(tooltip).toMatch(/screen/i);
  });

  it("makes no such caveat on macOS, where -d covers the display", () => {
    platformMock.mockReturnValue("macos");
    renderWidget();
    const tooltip = screen.getByTestId("sidebar-caffeinate").getAttribute("title") ?? "";
    expect(tooltip).not.toMatch(/screen/i);
  });
});

describe("CaffeinateWidget / rail", () => {
  it("renders the coffee glyph and no card when collapsed", () => {
    render(
      <ClockProvider value={new Date(2026, 0, 1, 12, 0, 0)}>
        <CaffeinateWidget visible={false} />
      </ClockProvider>,
    );
    const rail = screen.getByTestId("sidebar-caffeinate-rail");
    expect(rail.textContent).toContain("☕");
    expect(screen.queryByTestId("sidebar-caffeinate")).not.toBeInTheDocument();
  });

  it("is display-only — clicking the rail glyph does not toggle (spec §D1)", () => {
    render(
      <ClockProvider value={new Date(2026, 0, 1, 12, 0, 0)}>
        <CaffeinateWidget visible={false} />
      </ClockProvider>,
    );
    fireEvent.click(screen.getByTestId("sidebar-caffeinate-rail"));
    // The rail click-target is "expand the sidebar", never "operate
    // the widget".
    expect(keepAwakeMock).not.toHaveBeenCalled();
  });
});

describe("CaffeinateWidget / on-state visual reshape (M13.5 §D13)", () => {
  // The mockup shows a card whose whole outline flips to the accent
  // colour when active, with a title flipping verb → adjective and a
  // subtitle carrying the duration in-context. Off-state is
  // unchanged from M13.4. These cases pin the reshape so a future
  // restyle can't quietly walk it back.

  it("flips the title from verb to adjective when active", async () => {
    // Off: "Caffeinate" (imperative — do this).
    renderWidget();
    await waitFor(() => expect(keepAwakeStateMock).toHaveBeenCalled());
    expect(screen.getByTestId("sidebar-caffeinate-title").textContent).toBe("Caffeinate");

    // On: "Caffeinated" (adjective — describing the state).
    broadcast(HELD);
    expect(screen.getByTestId("sidebar-caffeinate-title").textContent).toBe("Caffeinated");
  });

  it("renders `awake for N` when active, not the bare duration", () => {
    renderWidget(new Date(HELD.since_ms + 45_000));
    broadcast(HELD);
    const line = screen.getByTestId("sidebar-caffeinate-duration").textContent ?? "";
    // The duration is embedded in prose so a reader who doesn't know
    // what `45s` counts now does. The number itself is still there.
    expect(line).toMatch(/^awake for /);
    expect(line).toContain("45s");
  });

  it("changes the toggle switch background from surface to accent when active", async () => {
    renderWidget();
    await waitFor(() => expect(keepAwakeStateMock).toHaveBeenCalled());
    const offBg = toggle().style.background;

    broadcast(HELD);
    const onBg = toggle().style.background;

    // We assert the delta rather than the exact string because
    // browsers normalise `var(--accent)` differently. The point is:
    // the two states must render distinct backgrounds — a common
    // regression when a restyle drops the conditional.
    expect(onBg).not.toBe("");
    expect(onBg).not.toBe(offBg);
    // And it must be the accent variable (D13 explicitly rejected
    // green as the on-colour — semantic is active-vs-idle, not
    // good-vs-bad).
    expect(onBg).toContain("--accent");
    expect(onBg).not.toContain("--green");
  });

  it("flips the card's border colour when active", async () => {
    renderWidget();
    await waitFor(() => expect(keepAwakeStateMock).toHaveBeenCalled());
    const card = screen.getByTestId("sidebar-caffeinate");
    const restingBorder = card.style.borderColor;
    // The `data-active` attribute is the machine-readable form of
    // the same visual state — assert it alongside the styling so a
    // renderer regression that drops one but not the other is caught.
    expect(card.getAttribute("data-active")).toBe("false");

    broadcast(HELD);
    expect(card.getAttribute("data-active")).toBe("true");
    // Border colour must change on activation. Exact value depends
    // on how the browser resolves `var(--accent)`, so we compare
    // against the resting value rather than a fixed string.
    expect(card.style.borderColor).not.toBe(restingBorder);
    expect(card.style.borderColor).toContain("--accent");
  });

  it("fills the card with an accent-soft background when active", async () => {
    // The spec's first pass said "border-only"; the mockup showed
    // border + soft fill. This case pins the fill in place so a
    // future style refactor cannot quietly walk it back to
    // border-only — which reads as "just another bordered card" in a
    // sidebar where every widget already has a border.
    renderWidget();
    await waitFor(() => expect(keepAwakeStateMock).toHaveBeenCalled());
    const card = screen.getByTestId("sidebar-caffeinate");
    // Resting card: transparent (or empty) background. Anything
    // non-empty here would mean the active fill has leaked into the
    // resting render.
    const restingBg = card.style.background;
    expect(restingBg === "" || restingBg === "transparent").toBe(true);

    broadcast(HELD);
    // Active card: an accent-soft fill. `--accent-soft` is the
    // token; any bg that reads as `--accent` (full-strength) would
    // overshoot and turn the whole card blue.
    expect(card.style.background).toContain("--accent-soft");
    expect(card.style.background).not.toBe(restingBg);
  });

  it("carries the resting card unchanged when off", async () => {
    // Regression guard: the reshape is on-only. The resting card
    // must not gain an accent border OR the accent-soft background
    // on mount, even briefly.
    renderWidget();
    await waitFor(() => expect(keepAwakeStateMock).toHaveBeenCalled());
    const card = screen.getByTestId("sidebar-caffeinate");
    expect(card.getAttribute("data-active")).toBe("false");
    expect(card.style.borderColor).not.toContain("--accent");
    expect(card.style.background).not.toContain("--accent");
  });
});
