/**
 * `ls` static formatter (M4 slice 4.4).
 *
 * The reference "rich" formatter — per spec §07 rule 2, we
 * **probe** the filesystem rather than parsing the colour codes
 * `ls --color` emits. The bytes the user saw are a lens; the
 * filesystem is the truth.
 *
 * Render shape depends on the parsed argv flags:
 *
 *   - `-l` / `--long` (or any of the long-implied flags): rows
 *     with type icon, name, size, mtime.
 *   - default: a compact grid of `<icon>name` chips that wraps
 *     to fill the available width.
 *
 * Sorting and dotfile-filtering match the standard flag set:
 * `-a` shows dotfiles, `-t` sorts by mtime, `-S` by size, `-r`
 * reverses, `-h` human-readable sizes (default `-h` since the
 * raw `ls` output the user just saw didn't carry sizes anyway —
 * the unit they'd expect is bytes-with-suffix).
 *
 * No interactivity (click-to-cd, click-to-open) — that's M5's
 * widget. This slice gives the static tier-1 render.
 */

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { readDirEntries, type DirEntry } from "../lib/ipc";
import { PASS, type Formatter, type FormatterContext } from "./types";

// ─── flag parsing ────────────────────────────────────────────────────────────

/** Subset of `ls`'s flag space that affects render or order. */
export interface LsFlags {
  long: boolean; // -l
  all: boolean; // -a / --all
  almostAll: boolean; // -A
  humanReadable: boolean; // -h
  onePerLine: boolean; // -1
  sortByTime: boolean; // -t
  sortBySize: boolean; // -S
  reverse: boolean; // -r
  /** Positional path arguments (zero or more). */
  paths: string[];
}

const FLAG_LONG_MAP: Record<string, keyof Omit<LsFlags, "paths">> = {
  l: "long",
  a: "all",
  A: "almostAll",
  h: "humanReadable",
  "1": "onePerLine",
  t: "sortByTime",
  S: "sortBySize",
  r: "reverse",
};

const FLAG_NAME_MAP: Record<string, keyof Omit<LsFlags, "paths">> = {
  "--all": "all",
  "--almost-all": "almostAll",
  "--long": "long",
  "--human-readable": "humanReadable",
  "--reverse": "reverse",
};

/** Split an argv into recognised LsFlags. Unknown flags are
 *  ignored (they don't change *our* render shape, but we keep
 *  positional tokens). */
export function parseLsArgv(argv: readonly string[]): LsFlags {
  const flags: LsFlags = {
    long: false,
    all: false,
    almostAll: false,
    humanReadable: false,
    onePerLine: false,
    sortByTime: false,
    sortBySize: false,
    reverse: false,
    paths: [],
  };
  // Skip argv[0] (the program name itself).
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined || tok.length === 0) continue;
    if (tok === "--") {
      // Standard "rest is positional" sentinel.
      for (let j = i + 1; j < argv.length; j++) {
        const t = argv[j];
        if (t !== undefined && t.length > 0) flags.paths.push(t);
      }
      break;
    }
    if (tok.startsWith("--")) {
      const hit = FLAG_NAME_MAP[tok];
      if (hit !== undefined) flags[hit] = true;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // `-la` / `-lh` style: each char is its own flag.
      for (const ch of tok.slice(1)) {
        const hit = FLAG_LONG_MAP[ch];
        if (hit !== undefined) flags[hit] = true;
      }
      continue;
    }
    flags.paths.push(tok);
  }
  return flags;
}

// ─── classification → icon + colour ──────────────────────────────────────────

/** Pick an icon for an entry. Dirs / symlinks / executables get
 *  a dedicated marker; regular files map by extension to a
 *  language / format glyph, falling back to a generic file
 *  glyph. All glyphs come from the bundled Nerd Font (PUA). */
function entryIcon(entry: DirEntry): string {
  if (entry.kind === "dir") return ""; // fa-folder
  if (entry.kind === "symlink") return ""; // fa-link
  if (entry.kind === "device") return ""; // fa-plug
  if (entry.kind === "socket") return ""; // fa-share-alt
  if (entry.kind === "fifo") return ""; // fa-bars
  if (entry.kind === "other") return ""; // fa-question
  if (entry.is_executable) return ""; // fa-rocket
  // Regular file: extension lookup.
  const dot = entry.name.lastIndexOf(".");
  if (dot > 0 && dot < entry.name.length - 1) {
    const ext = entry.name.slice(dot + 1).toLowerCase();
    const glyph = EXTENSION_ICONS[ext];
    if (glyph !== undefined) return glyph;
  }
  return ""; // fa-file
}

const EXTENSION_ICONS: Record<string, string> = {
  // Code
  rs: "", // dev-rust
  py: "", // dev-python
  js: "", // dev-javascript
  mjs: "",
  cjs: "",
  ts: "", // dev-typescript
  tsx: "",
  jsx: "",
  go: "", // dev-go
  rb: "", // dev-ruby
  java: "",
  c: "",
  h: "",
  cpp: "",
  hpp: "",
  // Markup / data
  md: "", // fa-book
  markdown: "",
  mdx: "",
  json: "",
  yaml: "",
  yml: "",
  toml: "",
  xml: "",
  html: "",
  htm: "",
  css: "",
  scss: "",
  // Images
  png: "",
  jpg: "",
  jpeg: "",
  gif: "",
  svg: "",
  webp: "",
  // Archives
  zip: "",
  tar: "",
  gz: "",
  tgz: "",
  bz2: "",
  xz: "",
  // Misc
  log: "",
  txt: "",
  csv: "",
  pdf: "",
  lock: "",
  env: "",
};

/** Colour token (CSS `var(--…)`) for an entry. Mirrors the
 *  bash `dircolors` defaults at a coarse level — directories
 *  blue, executables green, symlinks cyan, archives red,
 *  images magenta. Regular files take the default foreground. */
function entryColor(entry: DirEntry): string {
  if (entry.kind === "dir") return "var(--accent)"; // blue
  if (entry.kind === "symlink") return "var(--cyan)";
  if (entry.kind === "device") return "var(--amber)";
  if (entry.kind === "fifo" || entry.kind === "socket") return "var(--amber)";
  if (entry.is_executable) return "var(--green)";
  const dot = entry.name.lastIndexOf(".");
  if (dot > 0 && dot < entry.name.length - 1) {
    const ext = entry.name.slice(dot + 1).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return "var(--magenta, #d090d0)";
    if (ARCHIVE_EXTS.has(ext)) return "var(--red)";
  }
  return "var(--fg)";
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "tiff"]);
const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "deb", "rpm"]);

// ─── sorting + formatting helpers ────────────────────────────────────────────

/** Apply visibility (dotfile) + sort flags to a snapshot.
 *  Doesn't mutate the input. */
export function applyLsView(entries: readonly DirEntry[], flags: LsFlags): DirEntry[] {
  let view = entries.slice();
  if (!flags.all && !flags.almostAll) {
    view = view.filter((e) => !e.name.startsWith("."));
  } else if (flags.almostAll && !flags.all) {
    // `-A` drops `.` and `..` but keeps other dotfiles.
    view = view.filter((e) => e.name !== "." && e.name !== "..");
  }
  if (flags.sortByTime) {
    view.sort((a, b) => (b.modified_ms ?? 0) - (a.modified_ms ?? 0));
  } else if (flags.sortBySize) {
    view.sort((a, b) => b.size - a.size);
  } else {
    // Case-insensitive name sort, dirs aren't grouped (matches
    // BSD ls default; GNU users get the same behaviour). Dotted
    // names compare by their full string so `.bashrc` interleaves
    // with `bashfoo` rather than coming first.
    view.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
  if (flags.reverse) view.reverse();
  return view;
}

/** Human-readable size, base-1024, max 3 sig figs. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["K", "M", "G", "T", "P"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const formatted = n >= 10 ? n.toFixed(0) : n.toFixed(1);
  return `${formatted}${units[u]}`;
}

/** mtime as `MMM DD HH:MM` if this year, else `MMM DD  YYYY` —
 *  matches GNU `ls -l` exactly. */
export function formatLsMtime(ms: number | null, nowMs: number = Date.now()): string {
  if (ms === null) return "—";
  const d = new Date(ms);
  const now = new Date(nowMs);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = String(d.getDate()).padStart(2, " ");
  if (d.getFullYear() === now.getFullYear()) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${month} ${day} ${hh}:${mm}`;
  }
  return `${month} ${day}  ${d.getFullYear()}`;
}

// ─── view ────────────────────────────────────────────────────────────────────

// No surrounding border, no header bar — the block row already
// frames the output. The formatter just paints the entries,
// bounded by a max-height so long listings don't take over the
// pane.
const SHELL = {
  margin: "4px 0 0 0",
} as const satisfies CSSProperties;

const STATUS_LINE: CSSProperties = {
  padding: "4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-faint)",
};

const SCROLL_HOST: CSSProperties = {
  // Content-fit by default; cap at the pane's visible height
  // (set as `--block-pane-height` on BlockList's scroll
  // container). Short listings sit at their natural size; long
  // ones cap to the pane and scroll inside. Fallback for
  // surfaces that don't set the variable.
  maxHeight: "var(--block-pane-height, 70vh)",
  overflowY: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
};

const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: "2px 12px",
  alignItems: "baseline",
};

const LONG_ROW: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.6em 1fr 6em 10em",
  gap: 8,
  alignItems: "baseline",
  padding: "2px 0",
};

interface LsViewProps {
  ctx: FormatterContext;
}

function LsView({ ctx }: LsViewProps): React.ReactElement {
  const flags = useMemo(() => parseLsArgv(ctx.argv), [ctx.argv]);
  // Argument path → which directory to probe. The MVP only
  // handles a single path (or implicit cwd); multi-path ls
  // would be a follow-up. We resolve relative to ctx.cwd.
  const target = useMemo(() => resolveLsTarget(flags.paths, ctx.cwd), [flags.paths, ctx.cwd]);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntries(null);
    setError(null);
    if (target === null) {
      setError("ls formatter: no cwd or path resolvable");
      return;
    }
    let cancelled = false;
    void readDirEntries(target).then(
      (es) => {
        if (cancelled) return;
        setEntries(es);
      },
      (e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (error !== null) {
    return (
      <div data-testid="formatter-ls-error" style={{ ...SHELL, ...STATUS_LINE }}>
        ls formatter: {error}
      </div>
    );
  }
  if (entries === null) {
    return (
      <div data-testid="formatter-ls-loading" style={{ ...SHELL, ...STATUS_LINE }}>
        Probing {target}…
      </div>
    );
  }

  const view = applyLsView(entries, flags);

  return (
    <div data-testid="formatter-ls" style={SHELL}>
      <div style={SCROLL_HOST}>
        {flags.long || flags.onePerLine ? (
          view.map((e) => <LsLongRow key={e.name} entry={e} />)
        ) : (
          <div style={GRID}>
            {view.map((e) => (
              <LsGridCell key={e.name} entry={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LsGridCell({ entry }: { entry: DirEntry }): React.ReactElement {
  return (
    <span
      data-testid="formatter-ls-entry"
      data-kind={entry.kind}
      style={{ display: "inline-flex", alignItems: "baseline", gap: 6, minWidth: 0 }}
    >
      <span aria-hidden="true" style={{ color: entryColor(entry), flexShrink: 0 }}>
        {entryIcon(entry)}
      </span>
      <span style={{ color: entryColor(entry), overflow: "hidden", textOverflow: "ellipsis" }}>
        {entry.name}
        {entry.kind === "dir" ? "/" : ""}
      </span>
    </span>
  );
}

function LsLongRow({ entry }: { entry: DirEntry }): React.ReactElement {
  return (
    <div data-testid="formatter-ls-entry" data-kind={entry.kind} style={LONG_ROW}>
      <span aria-hidden="true" style={{ color: entryColor(entry) }}>
        {entryIcon(entry)}
      </span>
      <span style={{ color: entryColor(entry), overflow: "hidden", textOverflow: "ellipsis" }}>
        {entry.name}
        {entry.kind === "dir" ? "/" : ""}
        {entry.kind === "symlink" && entry.symlink_target !== null
          ? ` → ${entry.symlink_target}`
          : ""}
      </span>
      <span style={{ color: "var(--fg-dim)", textAlign: "right" }}>
        {entry.kind === "dir" ? "—" : humanSize(entry.size)}
      </span>
      <span style={{ color: "var(--fg-faint)" }}>{formatLsMtime(entry.modified_ms)}</span>
    </div>
  );
}

/** Resolve the path argv references. Single positional wins; if
 *  none, we use ctx.cwd. Relative positionals are joined with
 *  ctx.cwd. */
export function resolveLsTarget(paths: readonly string[], cwd: string | null): string | null {
  const first = paths[0];
  if (first === undefined) return cwd;
  if (first.startsWith("/")) return first;
  if (cwd === null) return null;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${base}/${first}`;
}

// ─── formatter registration ──────────────────────────────────────────────────

function render(ctx: FormatterContext): React.ReactNode | typeof PASS {
  // No cwd + no path → can't probe. RAW fallback.
  if (ctx.cwd === null && parseLsArgv(ctx.argv).paths.length === 0) return PASS;
  return <LsView ctx={ctx} />;
}

export const lsFormatter: Formatter = {
  name: "ls",
  matcher: { kind: "argv0", argv0: "ls" },
  render,
};

// Common Nerd Font aliases that behave like `ls -l --color`. Same
// renderer; they slot into the same matcher chain.
export const ezaFormatter: Formatter = {
  ...lsFormatter,
  name: "eza",
  matcher: { kind: "argv0", argv0: "eza" },
};

/** `exa` (the predecessor of `eza`). Some users still have it. */
export const exaFormatter: Formatter = {
  ...lsFormatter,
  name: "exa",
  matcher: { kind: "argv0", argv0: "exa" },
};

// Re-export individual helpers for tests.
export { entryColor, entryIcon };

// `__testing` is intentionally bundled so the tests have a stable
// surface for the pure helpers without touching internal names.
export const __testing = { entryColor, entryIcon };
