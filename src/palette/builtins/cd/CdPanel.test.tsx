import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CdPanel } from "./CdPanel";
import { HomeDirProvider } from "../../../lib/HomeDirContext";
import type { PaneContext } from "../../registry";
import type { DirEntry } from "../../../lib/ipc";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return {
    ...actual,
    readDirEntries: vi.fn(),
  };
});

import { readDirEntries } from "../../../lib/ipc";

const CTX: PaneContext = { ptyId: "pty-1", cwd: "/tmp/work", branch: null, gitRoot: null };

function entry(name: string, kind: DirEntry["kind"] = "file"): DirEntry {
  return {
    name,
    kind,
    size: 0,
    modified_ms: null,
    is_executable: false,
    symlink_target: null,
  };
}

function renderPanel(onSubmit: (c: string | null) => void = () => {}) {
  return render(
    <HomeDirProvider value="/Users/me">
      <CdPanel ctx={CTX} onSubmit={onSubmit} />
    </HomeDirProvider>,
  );
}

beforeEach(() => {
  vi.mocked(readDirEntries).mockReset();
});

afterEach(() => {
  vi.mocked(readDirEntries).mockReset();
});

describe("CdPanel", () => {
  it("lists directories first, hides dotfiles by default", async () => {
    vi.mocked(readDirEntries).mockResolvedValue([
      entry("z-file.txt", "file"),
      entry("a-dir", "dir"),
      entry(".git", "dir"),
      entry("b-file.txt", "file"),
      entry("a-file", "file"),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId("palette-cd-row")).toHaveLength(4));
    const rows = screen.getAllByTestId("palette-cd-row");
    // Dirs first (only a-dir since .git is hidden), then files by name.
    expect(rows[0]).toHaveTextContent("a-dir");
    expect(rows[1]).toHaveTextContent("a-file");
    expect(rows[2]).toHaveTextContent("b-file.txt");
    expect(rows[3]).toHaveTextContent("z-file.txt");
  });

  it("⌘H toggles hidden files on", async () => {
    vi.mocked(readDirEntries).mockResolvedValue([
      entry(".env", "file"),
      entry("visible.txt", "file"),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId("palette-cd-row")).toHaveLength(1));
    const filter = screen.getByTestId("palette-cd-filter");
    fireEvent.keyDown(filter, { key: "h", metaKey: true });
    await waitFor(() => expect(screen.getAllByTestId("palette-cd-row")).toHaveLength(2));
  });

  it("typing in the filter narrows the list", async () => {
    vi.mocked(readDirEntries).mockResolvedValue([
      entry("alpha", "dir"),
      entry("apple", "dir"),
      entry("banana", "dir"),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId("palette-cd-row")).toHaveLength(3));
    const filter = screen.getByTestId("palette-cd-filter");
    fireEvent.change(filter, { target: { value: "ap" } });
    await waitFor(() => {
      const rows = screen.getAllByTestId("palette-cd-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent("apple");
    });
  });

  it("Enter on a directory descends into it", async () => {
    vi.mocked(readDirEntries).mockResolvedValueOnce([entry("sub", "dir")]);
    vi.mocked(readDirEntries).mockResolvedValueOnce([entry("inner.txt", "file")]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId("palette-cd-row")).toHaveLength(1));
    const filter = screen.getByTestId("palette-cd-filter");
    fireEvent.keyDown(filter, { key: "Enter" });
    // Second load: the panel should now show /tmp/work/sub's contents.
    await waitFor(() => expect(vi.mocked(readDirEntries)).toHaveBeenCalledWith("/tmp/work/sub"));
    await waitFor(() => {
      const rows = screen.getAllByTestId("palette-cd-row");
      expect(rows[0]).toHaveTextContent("inner.txt");
    });
    const breadcrumb = screen.getByTestId("palette-cd-breadcrumb");
    expect(breadcrumb).toHaveTextContent("sub");
  });

  it("⌘Enter emits `cd <current>` without descending", async () => {
    vi.mocked(readDirEntries).mockResolvedValue([entry("sub", "dir")]);
    const onSubmit = vi.fn();
    renderPanel(onSubmit);
    await waitFor(() => expect(screen.getAllByTestId("palette-cd-row")).toHaveLength(1));
    const filter = screen.getByTestId("palette-cd-filter");
    fireEvent.keyDown(filter, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("cd /tmp/work");
  });

  it('"Use this dir" button emits `cd <current>`', async () => {
    vi.mocked(readDirEntries).mockResolvedValue([]);
    const onSubmit = vi.fn();
    renderPanel(onSubmit);
    await waitFor(() => expect(screen.getByTestId("palette-cd-use-current")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("palette-cd-use-current"));
    expect(onSubmit).toHaveBeenCalledWith("cd /tmp/work");
  });

  it("Backspace with empty filter goes up to the parent", async () => {
    vi.mocked(readDirEntries).mockResolvedValueOnce([]);
    vi.mocked(readDirEntries).mockResolvedValueOnce([]);
    renderPanel();
    await waitFor(() => expect(vi.mocked(readDirEntries)).toHaveBeenCalledWith("/tmp/work"));
    const filter = screen.getByTestId("palette-cd-filter");
    fireEvent.keyDown(filter, { key: "Backspace" });
    await waitFor(() => expect(vi.mocked(readDirEntries)).toHaveBeenCalledWith("/tmp"));
  });

  it("Backspace with non-empty filter deletes a char (does NOT go up)", async () => {
    vi.mocked(readDirEntries).mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(vi.mocked(readDirEntries)).toHaveBeenCalledTimes(1));
    const filter = screen.getByTestId("palette-cd-filter");
    fireEvent.change(filter, { target: { value: "x" } });
    fireEvent.keyDown(filter, { key: "Backspace" });
    // No second load — didn't navigate up.
    expect(vi.mocked(readDirEntries)).toHaveBeenCalledTimes(1);
  });

  it("shell-escapes paths with spaces when emitting cd", async () => {
    const ctxWithSpaces: PaneContext = {
      ptyId: "pty-1",
      cwd: "/tmp/has space/x",
      branch: null,
      gitRoot: null,
    };
    vi.mocked(readDirEntries).mockResolvedValue([]);
    const onSubmit = vi.fn();
    render(
      <HomeDirProvider value="/Users/me">
        <CdPanel ctx={ctxWithSpaces} onSubmit={onSubmit} />
      </HomeDirProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("palette-cd-use-current")).toBeInTheDocument());
    act(() => {
      fireEvent.click(screen.getByTestId("palette-cd-use-current"));
    });
    expect(onSubmit).toHaveBeenCalledWith("cd '/tmp/has space/x'");
  });

  it("surfaces IPC errors gracefully", async () => {
    vi.mocked(readDirEntries).mockRejectedValue(new Error("permission denied"));
    renderPanel();
    await waitFor(() => expect(screen.getByText(/permission denied/i)).toBeInTheDocument());
  });

  it("scrolls the selected row into view as arrow keys walk down the list", async () => {
    vi.mocked(readDirEntries).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => entry(`dir-${String(i).padStart(2, "0")}`, "dir")),
    );
    const scrollSpy = vi.fn();
    // jsdom doesn't implement scrollIntoView — stub it on the prototype
    // so our effect can call it under test.
    HTMLElement.prototype.scrollIntoView = scrollSpy;
    try {
      renderPanel();
      await waitFor(() => expect(screen.getAllByTestId("palette-cd-row")).toHaveLength(30));
      const filter = screen.getByTestId("palette-cd-filter");
      // Reset the initial mount call so we count only the arrow-driven ones.
      scrollSpy.mockClear();
      fireEvent.keyDown(filter, { key: "ArrowDown" });
      fireEvent.keyDown(filter, { key: "ArrowDown" });
      fireEvent.keyDown(filter, { key: "ArrowDown" });
      expect(scrollSpy).toHaveBeenCalledTimes(3);
      expect(scrollSpy).toHaveBeenLastCalledWith({ block: "nearest" });
    } finally {
      // Clean up the stub so other tests don't see it.
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});
