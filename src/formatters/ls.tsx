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
import { readDirEntries, resolveLsArg, type DirEntry } from "../lib/ipc";
import { LsWidget } from "../widgets/ls/LsWidget";
import { isWidgetPromotable } from "../widgets/ls/promotionGate";
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
  /**
   * `--group-directories-first`. Sorts directories ahead of
   * everything else, name order preserved within each group.
   * GNU `ls` supports it, and it is in eza's default alias on
   * several distros (Omarchy ships
   * `alias ls='eza -lh --group-directories-first --icons=auto'`).
   */
  groupDirectoriesFirst: boolean;
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
  "--group-directories-first": "groupDirectoriesFirst",
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
    groupDirectoriesFirst: false,
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
    if (IMAGE_EXTS.has(ext)) return "var(--magenta)";
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
  if (flags.groupDirectoriesFirst) {
    // Stable partition, so whichever sort ran above still orders
    // each group internally. Applied BEFORE `reverse` so `-r`
    // flips the whole listing — matching GNU ls, where grouping is
    // part of the comparison and `-r` inverts the comparison,
    // putting files ahead of directories.
    const dirs = view.filter((e) => e.kind === "dir");
    const rest = view.filter((e) => e.kind !== "dir");
    view = [...dirs, ...rest];
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
  // M10.5: scales with the terminal font-size preference.
  fontSize: "var(--font-size-secondary)",
  color: "var(--fg-faint)",
};

const SCROLL_HOST: CSSProperties = {
  // Inline blocks get a fixed cap. The modal overrides
  // `--formatter-max-height` to let the listing fill the panel.
  maxHeight: "var(--formatter-max-height, 320px)",
  overflowY: "auto",
  fontFamily: "var(--font-mono)",
  // M10.5: scales with the terminal font-size preference.
  fontSize: "var(--font-size-secondary)",
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

/** Resolution state for the positional argument. Plain paths resolve
 *  synchronously off `ctx.cwd`; anything with a `~`/`$`/glob makes
 *  a round-trip to the Rust `resolve_ls_arg` command which mirrors
 *  what the shell would have done at execution time. */
type Resolution =
  /** Awaiting the backend `resolve_ls_arg` round-trip. */
  | { state: "resolving" }
  /** Backend (or sync fast path) resolved to a probable directory,
   *  optionally with a glob-matched name filter to overlay. */
  | { state: "ready"; parentDir: string; filterNames: string[] | null }
  /** No positional and no ctx.cwd, OR the backend couldn't expand
   *  the token (unknown env var, brace expansion, cross-parent
   *  glob). The formatter shows a "check RAW" line instead of an
   *  error dialog — the raw bytes carry the shell's truthful
   *  output for that block. */
  | { state: "unresolvable"; reason: string };

function LsView({ ctx }: LsViewProps): React.ReactElement {
  const flags = useMemo(() => parseLsArgv(ctx.argv), [ctx.argv]);
  const positional = flags.paths[0];
  // Sync fast path for the common cases: bare `ls`, `ls src`,
  // `ls /etc`. Anything with a `~`, `$`, or glob metachar routes
  // through the async backend command instead — the initial state
  // is `resolving` and a useEffect below dispatches the round trip.
  const [resolution, setResolution] = useState<Resolution>(() => {
    if (positional === undefined) {
      if (ctx.cwd === null) {
        return { state: "unresolvable", reason: "no cwd" };
      }
      return { state: "ready", parentDir: ctx.cwd, filterNames: null };
    }
    if (!needsBackendResolution(positional)) {
      const parent = joinRelative(positional, ctx.cwd);
      if (parent === null) {
        return { state: "unresolvable", reason: "no cwd for relative path" };
      }
      return { state: "ready", parentDir: parent, filterNames: null };
    }
    return { state: "resolving" };
  });

  // Backend round trip for the expansion cases. Runs once per
  // (cwd, positional) pair; cancellable so a fast pane-focus swap
  // doesn't race the previous block's callback.
  useEffect(() => {
    if (positional === undefined || !needsBackendResolution(positional)) return;
    if (ctx.cwd === null) {
      setResolution({ state: "unresolvable", reason: "no cwd" });
      return;
    }
    let cancelled = false;
    setResolution({ state: "resolving" });
    void resolveLsArg(ctx.cwd, positional).then((r) => {
      if (cancelled) return;
      if (r.parent_dir === null) {
        setResolution({
          state: "unresolvable",
          reason: `couldn't expand \`${positional}\``,
        });
        return;
      }
      setResolution({
        state: "ready",
        parentDir: r.parent_dir,
        filterNames: r.filter_names,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [positional, ctx.cwd]);

  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Probe the resolved directory once resolution lands.
  useEffect(() => {
    if (resolution.state !== "ready") return;
    setEntries(null);
    setError(null);
    let cancelled = false;
    void readDirEntries(resolution.parentDir).then(
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
  }, [resolution]);

  if (resolution.state === "unresolvable") {
    return (
      <div data-testid="formatter-ls-unresolvable" style={{ ...SHELL, ...STATUS_LINE }}>
        ls formatter: {resolution.reason} — see RAW for the shell's output.
      </div>
    );
  }
  if (resolution.state === "resolving") {
    return (
      <div data-testid="formatter-ls-resolving" style={{ ...SHELL, ...STATUS_LINE }}>
        Resolving {positional}…
      </div>
    );
  }
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
        Probing {resolution.parentDir}…
      </div>
    );
  }

  // Apply the glob filter (if any) BEFORE `-a`/sort/dotfile
  // visibility so `applyLsView` sees only the matched entries.
  // The filter is a Set for O(1) lookup on large listings.
  const filterSet = resolution.filterNames === null ? null : new Set(resolution.filterNames);
  const filtered = filterSet === null ? entries : entries.filter((e) => filterSet.has(e.name));

  // Widget promotion (M5 slice 3). Bare `ls`, `-a`, path args, and
  // known "safe" flags render as the interactive widget. The
  // pre-filtered entry list flows into the widget so it renders the
  // same content the shell would have shown.
  if (isWidgetPromotable(ctx.argv)) {
    return (
      <LsWidget
        initialEntries={filtered}
        dirPath={resolution.parentDir}
        paneId={ctx.paneId}
        flags={flags}
        filterNames={resolution.filterNames}
      />
    );
  }

  const view = applyLsView(filtered, flags);

  return (
    <div data-testid="formatter-ls" style={SHELL}>
      <div data-block-scroll-host="ls" style={SCROLL_HOST}>
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

/** True when a positional path needs the backend `resolve_ls_arg`
 *  command to expand into a real filesystem path — tilde, env
 *  variables, and glob patterns can't be resolved from React
 *  alone. Plain paths (`src`, `/etc`, `../parent`) skip the round
 *  trip and go straight to `readDirEntries`.
 *
 *  Exported for tests. */
export function needsBackendResolution(path: string): boolean {
  if (path.startsWith("~")) return true;
  return path.includes("$") || /[*?[\]{}]/.test(path);
}

/** Sync path resolution for plain (non-expandable) positionals.
 *  When we don't need the backend, we still have to join a relative
 *  argument with `ctx.cwd`. */
function joinRelative(path: string, cwd: string | null): string | null {
  if (path.startsWith("/")) return path;
  if (cwd === null) return null;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${base}/${path}`;
}

/** Legacy: the sync target resolver, kept because tests bind on
 *  the empty-cwd + relative-positional negative branch. New callers
 *  should route unexpanded tokens through the backend command. */
export function resolveLsTarget(paths: readonly string[], cwd: string | null): string | null {
  const first = paths[0];
  if (first === undefined) return cwd;
  if (needsBackendResolution(first)) return null;
  return joinRelative(first, cwd);
}

// ─── formatter registration ──────────────────────────────────────────────────

function render(ctx: FormatterContext): React.ReactNode | typeof PASS {
  const flags = parseLsArgv(ctx.argv);
  // No cwd + no path → can't probe anything. RAW fallback.
  if (ctx.cwd === null && flags.paths.length === 0) return PASS;
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
