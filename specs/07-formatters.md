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

## Authoring

See the `shax-formatter-authoring` skill in `.claude/skills/` for the concrete API, the promotion declaration, the visible-command rule for any side effects, and the sandbox constraints.
