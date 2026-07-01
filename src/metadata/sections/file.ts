/**
 * Universal `FILE` section for the INFO lens.
 *
 * Populated from the backend `FileStat` — same rows for every
 * cat / bat block regardless of content type. Format-specific
 * sections (PNG, JPEG, GIF, TEXT) are appended by other
 * builders in `metadata/sections/`.
 */

import type { FileStat } from "../../lib/ipc";
import type { MetadataSection } from "../types";

export function buildFileSection(stat: FileStat): MetadataSection {
  const rows: { key: string; value: string; hint?: string }[] = [
    { key: "Name", value: stat.name },
    { key: "Path", value: stat.path },
    {
      key: "Size",
      value: humanBytes(stat.size_bytes),
      hint: `${stat.size_bytes.toLocaleString()} bytes`,
    },
  ];
  if (stat.created_unix_ms !== null) {
    rows.push({ key: "Created", value: formatTimestamp(stat.created_unix_ms) });
  } else {
    rows.push({ key: "Created", value: "unknown", hint: "not tracked on this filesystem" });
  }
  rows.push({ key: "Modified", value: formatTimestamp(stat.modified_unix_ms) });
  if (stat.is_executable !== null) {
    rows.push({ key: "Executable", value: stat.is_executable ? "yes" : "no" });
  }
  if (stat.is_symlink) {
    rows.push({
      key: "Symlink",
      value: stat.symlink_target ?? "(unreadable)",
    });
  }
  return { title: "File", rows };
}

/** Byte count → human-friendly string.
 *
 * `1024 B` → `1.0 KiB`, `1_500_000 B` → `1.4 MiB`. The full
 * exact byte count lives in the `hint` next to the value, so
 * the human-friendly value never lies. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const unit = units[unitIndex];
  if (unit === undefined) return `${bytes} B`;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

/** ISO-ish local timestamp: `2026-06-30 14:02` (minute
 *  precision — seconds would be noise for file metadata).
 *
 *  Locale-safe: uses the intl API to render in the user's
 *  timezone but with a fixed field order so the column stays
 *  aligned. */
export function formatTimestamp(unixMs: number): string {
  const date = new Date(unixMs);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}-${m}-${d} ${h}:${min}`;
}
