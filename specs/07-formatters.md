# 07 Formatters

Formatters turn a completed block's output into a rich (tier 1) view. Some are promoted to interactive widgets (tier 2, see `08`). Both obey the two-path model in `02`.

## Registration

A formatter registers against a command matcher:

- `argv[0]` (for example `ls`),
- a name plus subcommand (for example `git` + `status`),
- or a predicate over the context for anything more specific.

## The context a formatter receives

```
FormatterContext {
  argv:        string[]
  cwd:         string
  env:         Record<string,string>   // filtered, no secrets
  exitCode:    number
  durationMs:  number
  stdout:      string
  stderr:      string
  rawAnsi:     string                  // the original bytes, preserved
  paneId:      string
}
```

It returns one of: a rich view, structured data the shell renders, or `pass` (decline, fall back to the next lower tier).

## Three rules baked in from day one

1. **Always keep raw, always toggleable.** Every formatted block has a visible raw toggle. If a formatter throws or its parse looks wrong, fall back to raw silently. A pretty view that hides ground truth is worse than no view.
2. **Probe, do not screen-scrape, when you can.** Parsing column-wrapped text to reconstruct structure is fragile. Prefer a machine-readable source: read the SGR color codes `ls --color` already emits (dircolors encodes file type), or have the formatter do its own side-effect-free probe (a `readdir` plus `stat`). The context exposes enough for the author to choose; for `ls` we lean on the probe, with SGR as fallback.
3. **Sandbox community formatters.** Built-in formatters run trusted. Third-party formatters are arbitrary code, so they run in a worker sandbox with a restricted API and no ambient filesystem or network access. The sandbox is a security boundary, not a convenience.

## Built-in formatters

Trusted, shipped with Shax: `ls`, `cat` (the viewer, see `06`), `git status`, `git diff`, `git log`, `ps`, `df`, `du`, `jq` and JSON output, `find`, and `tree`. `ls`, `git status`, and `git diff` are also the three reference interactive widgets in `08`.

## Promotion to a widget

When a formatter has an interactive counterpart and the promotion gate in `02` is satisfied (non-interactive, bare at a tty prompt, local, flags understood), the block renders as a tier-2 widget instead of a static view. Otherwise it stays tier 1. The formatter author declares whether an interactive form exists and which flags it understands.

## Content-aware `cat` and the three-state lens toggle

`cat` is not really *one* formatter — it is a router. The bytes a `cat` block produces can usefully be viewed three ways depending on what was cat'd, and the FMT/RAW two-state toggle that suffices for `ls` or `git diff` is too narrow for it. For these blocks the toggle grows to **FMT / SRC / RAW**, and the buttons that appear depend on the file type. RAW remains what it has always been (the captured stdout). The other two are lenses that need defining.

### FMT — the rendered lens

The file as the user would normally consume it.

- **Markdown** → rendered via `react-markdown` + DOMPurify (see `06`).
- **Image** (png, jpg, gif, webp) → an `<img>` sized to fit the formatter's bounded height with `object-fit: contain`.
- **SVG** → sanitized SVG element (see `06`).
- **Plain source code / json / etc.** → CodeMirror viewer with syntax highlighting (today's behaviour). For these, FMT and SRC are the same view, so the SRC button does not appear.

The cat formatter reads file bytes from disk via the same probe-don't-screen-scrape path the modal already uses for slice-4.2 markdown / image rendering. The PTY's line discipline corrupts binary bytes; the captured `ctx.stdout` is not authoritative for binaries. This makes cat an async formatter (loading state → resolved view), the same shape as `ls` / `git diff`.

### SRC — the source lens (conditional)

A view of the *raw file bytes*, presented in a format that suits the content's nature. The button appears only when SRC adds information FMT does not.

| Content type        | SRC viewer                                       |
| ------------------- | ------------------------------------------------ |
| Markdown            | CodeMirror, markdown syntax highlighting         |
| HTML / XML / SVG    | CodeMirror, the corresponding language grammar   |
| Image / binary      | **Hex dump** — `xxd`-style offset · hex · ASCII  |
| Plain source        | (button hidden — FMT already is the source view) |

For binaries the hex viewer is the universal fallback. The first ~8 bytes (the file signature) are highlighted so signature checks are immediate (`89 50 4E 47` for PNG, `FF D8 FF` for JPEG, `47 49 46 38` for GIF, etc.). Layout is the standard 16-byte-per-line three-column grid; the offset column is sticky. Hex view is bounded by the formatter's height cap with virtualised rows for very large files (32 MiB read cap from `06` still applies).

### RAW — the captured-bytes lens (always available)

What the PTY actually wrote to its screen for this block. For text it is the file content (possibly with shell artifacts like zsh's missing-newline `%` indicator); for binaries it is the PTY-mangled bytes the user saw scroll past. RAW honours the fidelity contract verbatim — it never reaches for the file on disk. If RAW looks like garbage for a binary, that *is* what the user's terminal showed; we do not pretend otherwise.

### INFO — the metadata lens (binaries only, separate)

A fourth lens that shows *structured metadata* parsed out of a binary file. Distinct from the other three: it is not a view of bytes, it is a view of meaning.

| Format | Surfaced fields                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| PNG    | dimensions, colour type, bit depth, interlace, gAMA / cHRM if present, frame count for APNG                 |
| JPEG   | dimensions, EXIF camera / lens / time / GPS, orientation, ICC profile name                                  |
| GIF    | dimensions, frame count, loop count, average frame delay                                                    |
| WebP   | dimensions, animation flag, frame count, ICC profile name                                                   |
| SVG    | dimensions, viewBox, embedded script / foreignObject warnings (security-relevant)                           |
| PDF    | page count, title, author, producer, creation date (later — only if the viewer ever supports PDFs)          |

Each formatter row is a key / value pair; sensitive EXIF (precise GPS) is shown but pre-fuzzed if the user has a "redact location" preference set. The INFO lens is read-only — actions on metadata are out of scope here; M5 widget work can decide if any of these warrant a follow-up command.

INFO needs a per-format parser, so it ships in pieces:

1. **Phase 1** — PNG + GIF + JPEG (the three formats `image image` blocks hit 99% of the time). Parsers are well-documented and small (under 200 LOC each in Rust or TS).
2. **Phase 2** — WebP, SVG warnings.
3. **Phase 3** — anything else as need surfaces.

Phase 1 must ship before INFO becomes a visible toggle button; until then a binary cat block has FMT (image) / SRC (hex) / RAW only.

### Where the toggle button group lives

The four-button group never shows all four at once — it shows the buttons that apply to *this* block's content:

- Plain source: **FMT / RAW** (today's two-state).
- Markdown / HTML / XML / SVG-as-text: **FMT / SRC / RAW**.
- Image / binary (post-phase 1 of INFO): **FMT / SRC / INFO / RAW**.
- Image / binary (pre-phase 1): **FMT / SRC / RAW**.
- Non-cat formatter blocks (`ls`, `git diff`, etc.): **FMT / RAW**, unchanged.

The active lens persists per-block locally — toggling on one block does not affect another. RAW is always last in the group so users learn one consistent escape hatch position.

### Reuse, not divergence

The same `ContentView` component used by the block viewer modal (`06`) renders these lenses. The formatter's bounded height and the modal's panel height both feed the same component via a CSS custom property — one source of truth, no drift between inline and modal experiences. Adding INFO touches the shared component, not two places.

## Sister surface: the pane command palette

The pane command palette (`14`) is the *action* counterpart to the formatter system's *render* role. It uses the same matcher-against-context shape, the same idempotent registry, and the same worker-sandbox trust model for community contributions. A community add-on that wants to render a block uses the formatter API; one that wants to emit a command from the user's prompt uses the command-palette API. The two are deliberately parallel so the authoring story is one mental model.

## Authoring

See the `shax-formatter-authoring` skill in `.claude/skills/` for the concrete API, the promotion declaration, the visible-command rule for any side effects, and the sandbox constraints.
