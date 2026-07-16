import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { LsWidget } from "./LsWidget";
import { parseLsArgv } from "../../formatters/ls";
import type { DirEntry } from "../../lib/ipc";

// `readDirEntries` is called by the widget on expand + on
// silent refresh. Mock it so tests can drive both paths
// without a real Tauri backend.
vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    readDirEntries: vi.fn().mockResolvedValue([]),
  };
});
import { readDirEntries } from "../../lib/ipc";

function mkEntry(name: string, overrides: Partial<DirEntry> = {}): DirEntry {
  return {
    name,
    kind: "file",
    size: 100,
    modified_ms: 1_700_000_000_000,
    is_executable: false,
    symlink_target: null,
    ...overrides,
  };
}

function withBlock(
  id: string,
  { isLatest = true }: { isLatest?: boolean } = {},
): (children: React.ReactElement) => React.ReactElement {
  return (children) => (
    <div data-block-id={id} data-is-latest={isLatest ? "true" : "false"}>
      {children}
    </div>
  );
}

const NAV = (blockId: string, direction: "up" | "down" | "left" | "right"): boolean => {
  const detail: { blockId: string; direction: typeof direction; claimed: boolean } = {
    blockId,
    direction,
    claimed: false,
  };
  act(() => {
    window.dispatchEvent(new CustomEvent("shax:widget-nav", { detail }));
  });
  return detail.claimed;
};

describe("LsWidget", () => {
  it("shows an empty-directory note when there are no entries", () => {
    render(
      <LsWidget
        initialEntries={[]}
        dirPath="/home/ada"
        paneId="pty-1"
        flags={parseLsArgv(["ls"])}
      />,
    );
    expect(screen.getByTestId("widget-ls")).toHaveTextContent("empty directory");
  });

  it("renders one inline row per entry with name + size + mtime", () => {
    const entries: DirEntry[] = [
      mkEntry("README.md", { size: 4096 }),
      mkEntry("src", { kind: "dir", size: 0 }),
    ];
    render(
      <LsWidget
        initialEntries={entries}
        dirPath="/repo"
        paneId="pty-1"
        flags={parseLsArgv(["ls"])}
      />,
    );
    const rows = screen.getAllByTestId("widget-ls-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("README.md");
    expect(rows[0]).toHaveTextContent("4.0K");
    expect(rows[1]).toHaveTextContent("src/");
  });

  it("hides dotfiles by default, shows them under -a", () => {
    const entries: DirEntry[] = [mkEntry(".hidden"), mkEntry("visible")];
    const { rerender } = render(
      <LsWidget initialEntries={entries} dirPath="/x" paneId="pty-1" flags={parseLsArgv(["ls"])} />,
    );
    expect(screen.getAllByTestId("widget-ls-row")).toHaveLength(1);
    rerender(
      <LsWidget
        initialEntries={entries}
        dirPath="/x"
        paneId="pty-1"
        flags={parseLsArgv(["ls", "-a"])}
      />,
    );
    expect(screen.getAllByTestId("widget-ls-row")).toHaveLength(2);
  });

  it("widget-nav j/k walks entries", () => {
    render(
      withBlock("b1")(
        <LsWidget
          initialEntries={[mkEntry("a"), mkEntry("b"), mkEntry("c")]}
          dirPath="/x"
          paneId="pty-1"
          flags={parseLsArgv(["ls"])}
        />,
      ),
    );
    expect(NAV("b1", "down")).toBe(true);
    expect(screen.getAllByTestId("widget-ls-row")[0]).toHaveAttribute("data-focused", "true");
    expect(NAV("b1", "down")).toBe(true);
    expect(screen.getAllByTestId("widget-ls-row")[1]).toHaveAttribute("data-focused", "true");
    // Past the last row → no claim (advances block-focus).
    NAV("b1", "down");
    NAV("b1", "down");
    expect(NAV("b1", "down")).toBe(false);
  });

  it("l on a folder expands via a silent probe; children indent under the parent", async () => {
    const readDir = vi.mocked(readDirEntries);
    readDir.mockClear();
    readDir.mockResolvedValueOnce([mkEntry("nested-file")]);
    render(
      withBlock("b2")(
        <LsWidget
          initialEntries={[mkEntry("src", { kind: "dir" })]}
          dirPath="/repo"
          paneId="pty-1"
          flags={parseLsArgv(["ls"])}
        />,
      ),
    );
    NAV("b2", "down"); // focus src
    expect(NAV("b2", "right")).toBe(true);
    // Wait for the async probe to resolve + widget to re-render.
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
    expect(readDir).toHaveBeenCalledWith("/repo/src");
    const rows = screen.getAllByTestId("widget-ls-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("nested-file");
  });

  it("h on an expanded folder collapses it", async () => {
    const readDir = vi.mocked(readDirEntries);
    readDir.mockClear();
    readDir.mockResolvedValueOnce([mkEntry("nested")]);
    render(
      withBlock("b3")(
        <LsWidget
          initialEntries={[mkEntry("src", { kind: "dir" })]}
          dirPath="/repo"
          paneId="pty-1"
          flags={parseLsArgv(["ls"])}
        />,
      ),
    );
    NAV("b3", "down");
    NAV("b3", "right");
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
    expect(screen.getAllByTestId("widget-ls-row")).toHaveLength(2);
    expect(NAV("b3", "left")).toBe(true);
    expect(screen.getAllByTestId("widget-ls-row")).toHaveLength(1);
  });

  it("Space on a folder emits `cd <path>` and freezes the widget", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("b4")(
        <LsWidget
          initialEntries={[mkEntry("src", { kind: "dir" })]}
          dirPath="/repo"
          paneId="pty-1"
          flags={parseLsArgv(["ls"])}
        />,
      ),
    );
    NAV("b4", "down"); // focus src
    const primary = { blockId: "b4", claimed: false };
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:widget-primary", { detail: primary }));
    });
    expect(primary.claimed).toBe(true);
    const emit = spy.mock.calls[0]?.[0] as CustomEvent<{ paneId: string; command: string }>;
    expect(emit.detail.command).toBe("cd /repo/src");
    // Widget freezes immediately — `cd` invalidates the listing.
    expect(screen.getByTestId("widget-ls")).toHaveAttribute("data-is-live", "false");
    window.removeEventListener("shax:emit-command", spy);
  });

  it("Space on a file emits `cat <path>` and stays live", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("b5")(
        <LsWidget
          initialEntries={[mkEntry("README.md")]}
          dirPath="/repo"
          paneId="pty-1"
          flags={parseLsArgv(["ls"])}
        />,
      ),
    );
    NAV("b5", "down"); // focus README.md
    const primary = { blockId: "b5", claimed: false };
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:widget-primary", { detail: primary }));
    });
    expect(primary.claimed).toBe(true);
    const emit = spy.mock.calls[0]?.[0] as CustomEvent<{ paneId: string; command: string }>;
    expect(emit.detail.command).toBe("cat /repo/README.md");
    expect(screen.getByTestId("widget-ls")).toHaveAttribute("data-is-live", "true");
    window.removeEventListener("shax:emit-command", spy);
  });

  it("quotes paths with spaces", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("b6")(
        <LsWidget
          initialEntries={[mkEntry("my file.txt")]}
          dirPath="/home/ada/my repo"
          paneId="pty-1"
          flags={parseLsArgv(["ls"])}
        />,
      ),
    );
    NAV("b6", "down");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:widget-primary", { detail: { blockId: "b6", claimed: false } }),
      );
    });
    const emit = spy.mock.calls[0]?.[0] as CustomEvent<{ paneId: string; command: string }>;
    expect(emit.detail.command).toBe("cat '/home/ada/my repo/my file.txt'");
    window.removeEventListener("shax:emit-command", spy);
  });

  it("historical (non-latest) widgets refuse Space", () => {
    const spy = vi.fn();
    window.addEventListener("shax:emit-command", spy);
    render(
      withBlock("bold", { isLatest: false })(
        <LsWidget
          initialEntries={[mkEntry("README.md")]}
          dirPath="/repo"
          paneId="pty-1"
          flags={parseLsArgv(["ls"])}
        />,
      ),
    );
    NAV("bold", "down");
    const primary = { blockId: "bold", claimed: false };
    act(() => {
      window.dispatchEvent(new CustomEvent("shax:widget-primary", { detail: primary }));
    });
    expect(primary.claimed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("widget-ls-historical")).toBeInTheDocument();
    window.removeEventListener("shax:emit-command", spy);
  });

  it("user-typed block completion freezes the widget", () => {
    render(
      withBlock("b7")(
        <LsWidget
          initialEntries={[mkEntry("a")]}
          dirPath="/x"
          paneId="pty-77"
          flags={parseLsArgv(["ls"])}
        />,
      ),
    );
    expect(screen.getByTestId("widget-ls")).toHaveAttribute("data-is-live", "true");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-complete", {
          detail: { paneId: "pty-77", blockId: "buser", source: "user" },
        }),
      );
    });
    expect(screen.getByTestId("widget-ls")).toHaveAttribute("data-is-live", "false");
  });

  it("does NOT freeze when the widget's own block finishes streaming", () => {
    // Regression: every `ls` used to render with the 'historical'
    // badge because the widget received its own block-complete event
    // (source: 'user', because the user typed `ls`) and treated it
    // as "some later command finished — freeze". The fix compares
    // detail.blockId to the widget's own data-block-id and skips.
    render(
      withBlock("b-own")(
        <LsWidget
          initialEntries={[mkEntry("a")]}
          dirPath="/x"
          paneId="pty-88"
          flags={parseLsArgv(["ls"])}
        />,
      ),
    );
    expect(screen.getByTestId("widget-ls")).toHaveAttribute("data-is-live", "true");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shax:block-complete", {
          detail: { paneId: "pty-88", blockId: "b-own", source: "user" },
        }),
      );
    });
    // Still live — no historical badge.
    expect(screen.getByTestId("widget-ls")).toHaveAttribute("data-is-live", "true");
    expect(screen.queryByTestId("widget-ls-historical")).toBeNull();
  });
});
