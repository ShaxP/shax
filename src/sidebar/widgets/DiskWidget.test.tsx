/**
 * DiskWidget tests (M13.5.4, spec §19 D10).
 *
 * The card is a pager over mounted volumes; what's worth pinning:
 *   - it renders every field from the mockup (name, mount, free,
 *     usage, fs)
 *   - the pager renders only when there is more than one volume
 *   - the heat map for the usage bar
 *   - selection sticks to mount point when a volume earlier in the
 *     list vanishes — the invariant D10 keys everything on
 *   - selection recovers cleanly when the selected volume itself
 *     vanishes (falls back to the primary)
 *   - byte formatting helpers
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { DiskProvider } from "../../lib/DiskContext";
import type { VolumeInfo } from "../../lib/ipc";
import { DiskWidget, formatFree, formatTotal, usageColour } from "./DiskWidget";

afterEach(cleanup);

const GB = 1024 ** 3;
const TB = 1024 ** 4;

function volume(overrides: Partial<VolumeInfo> = {}): VolumeInfo {
  return {
    name: "Macintosh HD",
    mount_point: "/",
    filesystem: "apfs",
    total_bytes: 1 * TB,
    used_bytes: 580 * GB,
    ...overrides,
  };
}

function renderWithVolumes(volumes: VolumeInfo[], visible = true) {
  return render(
    <DiskProvider value={{ volumes }}>
      <DiskWidget visible={visible} />
    </DiskProvider>,
  );
}

describe("DiskWidget / hidden", () => {
  it("renders nothing when no volumes are enumerated (pre-probe / non-Tauri)", () => {
    renderWithVolumes([]);
    expect(screen.queryByTestId("sidebar-disk")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-disk-rail")).not.toBeInTheDocument();
  });
});

describe("DiskWidget / expanded — single volume", () => {
  it("renders every field the mockup shows", () => {
    // `design/disk-widget-1.png`: Macintosh HD, 412GB free, /,
    // 58% used of 1 TB · APFS.
    renderWithVolumes([
      volume({
        name: "Macintosh HD",
        mount_point: "/",
        filesystem: "apfs",
        total_bytes: 1 * TB,
        used_bytes: 580 * GB,
      }),
    ]);
    expect(screen.getByTestId("sidebar-disk-name").textContent).toBe("Macintosh HD");
    expect(screen.getByTestId("sidebar-disk-mount").textContent).toBe("/");
    // Free = 1 TB - 580 GB = 444 GB (the exact number depends on
    // the byte math; we're loose on it and pin the shape).
    expect(screen.getByTestId("sidebar-disk-free").textContent).toMatch(/GB free$/);
    // Usage number rounds to the nearest integer per the format.
    expect(screen.getByTestId("sidebar-disk-usage").textContent).toMatch(
      /^\d+% used of [\d.]+ (GB|TB)$/,
    );
    // Filesystem is upper-cased.
    expect(screen.getByTestId("sidebar-disk-fs").textContent).toBe("APFS");
  });

  it("does NOT render the pager chrome when only one volume exists", () => {
    // The mockup only shows the ◀ n ▶ pager when there is a choice
    // to page through. One volume means no chrome to compete with
    // the reading itself.
    renderWithVolumes([volume()]);
    expect(screen.queryByTestId("sidebar-disk-pager")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-disk-prev")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-disk-next")).not.toBeInTheDocument();
  });

  it("upper-cases the filesystem regardless of what the OS reports", () => {
    // Linux hands back `ext4`, macOS `apfs`, Windows `NTFS`.
    // Rendering `apfs` next to `EXFAT` on the same reader's card is
    // jarring; upper-casing normalises the tier.
    renderWithVolumes([volume({ filesystem: "ext4" })]);
    expect(screen.getByTestId("sidebar-disk-fs").textContent).toBe("EXT4");
  });

  it("does not divide by zero when a volume reports total = 0", () => {
    // Defensive guard — a phantom mount should be filtered in Rust,
    // but if one slips through the widget must not crash.
    renderWithVolumes([volume({ total_bytes: 0, used_bytes: 0 })]);
    expect(screen.getByTestId("sidebar-disk-usage").textContent).toMatch(/^0% used/);
    expect(screen.getByTestId("sidebar-disk-fill").style.width).toBe("0%");
  });
});

describe("DiskWidget / expanded — pager", () => {
  it("shows `DISK ◀ n ▶` and the current position when there are multiple volumes", () => {
    renderWithVolumes([
      volume({ name: "Macintosh HD", mount_point: "/" }),
      volume({ name: "Scratch", mount_point: "/Volumes/Scratch" }),
      volume({ name: "Backup", mount_point: "/Volumes/Backup" }),
    ]);
    expect(screen.getByTestId("sidebar-disk-pager")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-disk-position").textContent).toBe("1");
  });

  it("steps forward with ▶ and wraps at the end", () => {
    renderWithVolumes([
      volume({ name: "A", mount_point: "/a" }),
      volume({ name: "B", mount_point: "/b" }),
      volume({ name: "C", mount_point: "/c" }),
    ]);
    expect(screen.getByTestId("sidebar-disk-name").textContent).toBe("A");
    fireEvent.click(screen.getByTestId("sidebar-disk-next"));
    expect(screen.getByTestId("sidebar-disk-name").textContent).toBe("B");
    fireEvent.click(screen.getByTestId("sidebar-disk-next"));
    fireEvent.click(screen.getByTestId("sidebar-disk-next"));
    // Third click wraps to A.
    expect(screen.getByTestId("sidebar-disk-name").textContent).toBe("A");
  });

  it("steps backward with ◀ and wraps at the start", () => {
    renderWithVolumes([
      volume({ name: "A", mount_point: "/a" }),
      volume({ name: "B", mount_point: "/b" }),
    ]);
    fireEvent.click(screen.getByTestId("sidebar-disk-prev"));
    // From A prev goes to B (wrap).
    expect(screen.getByTestId("sidebar-disk-name").textContent).toBe("B");
  });
});

describe("DiskWidget / selection by mount point (spec §D10)", () => {
  it("stays on the same volume when one EARLIER in the list vanishes", () => {
    // The invariant that keys everything on mount-point selection.
    // Page to `Scratch` at position 2; unmount `Macintosh HD`
    // (position 1). The card must still show `Scratch`, not slide
    // onto whatever now sits at position 1.
    const before = [
      volume({ name: "Macintosh HD", mount_point: "/" }),
      volume({ name: "Scratch", mount_point: "/Volumes/Scratch" }),
      volume({ name: "Backup", mount_point: "/Volumes/Backup" }),
    ];
    const { rerender } = renderWithVolumes(before);
    fireEvent.click(screen.getByTestId("sidebar-disk-next"));
    expect(screen.getByTestId("sidebar-disk-name").textContent).toBe("Scratch");

    // Now Macintosh HD vanishes (the widget state's mount point is
    // still `/Volumes/Scratch`, and the list shifts down).
    const after = [
      volume({ name: "Scratch", mount_point: "/Volumes/Scratch" }),
      volume({ name: "Backup", mount_point: "/Volumes/Backup" }),
    ];
    rerender(
      <DiskProvider value={{ volumes: after }}>
        <DiskWidget visible={true} />
      </DiskProvider>,
    );
    expect(screen.getByTestId("sidebar-disk-name").textContent).toBe("Scratch");
  });

  it("falls back to the primary when the SELECTED volume itself vanishes", () => {
    // Same shape as NetworkWidget's fallback — the mount you paged
    // to is genuinely gone (drive ejected), so falling forward
    // rather than showing an empty card is the right recovery.
    const before = [
      volume({ name: "Macintosh HD", mount_point: "/" }),
      volume({ name: "Backup", mount_point: "/Volumes/Backup" }),
    ];
    const { rerender } = renderWithVolumes(before);
    fireEvent.click(screen.getByTestId("sidebar-disk-next"));
    expect(screen.getByTestId("sidebar-disk-name").textContent).toBe("Backup");

    // Backup ejected — only Macintosh HD remains.
    const after = [volume({ name: "Macintosh HD", mount_point: "/" })];
    rerender(
      <DiskProvider value={{ volumes: after }}>
        <DiskWidget visible={true} />
      </DiskProvider>,
    );
    expect(screen.getByTestId("sidebar-disk-name").textContent).toBe("Macintosh HD");
  });
});

describe("DiskWidget / heat map (usageColour helper)", () => {
  it.each([
    [0, "var(--accent)"],
    [50, "var(--accent)"],
    [69.9, "var(--accent)"],
    [70, "var(--amber)"],
    [89.9, "var(--amber)"],
    [90, "var(--red)"],
    [100, "var(--red)"],
  ])("%s%% used is %s", (percent, expected) => {
    // Boundaries land on the hotter side (`70` = amber, `90` = red)
    // so a nearly-full disk is never flattered by rounding into a
    // calmer tier.
    expect(usageColour(percent)).toBe(expected);
  });

  it("paints the fill with the heat colour matching the reading", () => {
    // `design/disk-widget-3.png` — external drive at 91 % used
    // renders red. Widget must derive the bar colour from the
    // current volume's usage, not from a static token.
    renderWithVolumes([volume({ total_bytes: 2 * TB, used_bytes: Math.round(2 * TB * 0.91) })]);
    expect(screen.getByTestId("sidebar-disk-fill").style.background).toBe("var(--red)");
  });
});

describe("DiskWidget / byte formatters", () => {
  describe("formatFree — expanded", () => {
    it("integer above 100 GB, one decimal below, TB above 1 TB", () => {
      expect(formatFree(50 * GB, false)).toBe("50GB"); // integer sub-100
      expect(formatFree(4 * GB, false)).toBe("4.0GB"); // decimal single-digit
      expect(formatFree(200 * GB, false)).toBe("200GB");
      expect(formatFree(1.5 * TB, false)).toBe("1.5TB");
      expect(formatFree(15 * TB, false)).toBe("15TB");
    });

    it("falls back to MB for sub-1-GB volumes (defensive branch)", () => {
      expect(formatFree(500 * 1024 * 1024, false)).toBe("500MB");
    });
  });

  describe("formatFree — rail (compact)", () => {
    it("drops the B in the suffix so the rail row stays narrow", () => {
      // The rail is 44-56 px wide; `412 GB` cost more than the
      // reading is worth there. `412G` is what fits.
      expect(formatFree(412 * GB, true)).toBe("412G");
      expect(formatFree(2 * TB, true)).toBe("2T");
    });
  });

  describe("formatTotal", () => {
    it("promotes to TB at 1 TB and drops the decimal above 10 TB", () => {
      expect(formatTotal(1 * TB)).toBe("1.0 TB");
      expect(formatTotal(2 * TB)).toBe("2.0 TB");
      expect(formatTotal(15 * TB)).toBe("15 TB");
    });

    it("stays in GB below 1 TB", () => {
      expect(formatTotal(500 * GB)).toBe("500 GB");
    });
  });
});

describe("DiskWidget / rail", () => {
  it("renders a compact free-GB figure when collapsed", () => {
    renderWithVolumes(
      [
        volume({
          total_bytes: 1 * TB,
          // 412 GB free ≈ 588 GB used → 412 * GB left over.
          used_bytes: 1 * TB - 412 * GB,
        }),
      ],
      false,
    );
    expect(screen.getByTestId("sidebar-disk-rail").textContent).toBe("412G");
    expect(screen.queryByTestId("sidebar-disk")).not.toBeInTheDocument();
  });
});
