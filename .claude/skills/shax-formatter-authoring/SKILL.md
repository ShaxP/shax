---
name: shax-formatter-authoring
description: Use when writing a Shax formatter or interactive widget: the registration matcher, the context object, declaring an interactive form, the promotion gate, the visible-command rule for side effects, the freeze-versus-live model, and the sandbox constraints for community formatters. For the frontend engineer at M4 and M5.
---

# Authoring Shax formatters and widgets

A formatter turns a completed block's output into a rich view (tier 1). Some declare an interactive form and get promoted to a widget (tier 2). Read specs `02`, `07`, and `08` first; this is the practical how-to.

## Register against a matcher

- `argv[0]` for a plain command (`ls`),
- name plus subcommand (`git` + `status`),
- or a predicate over the context for anything finer.

## The context you receive

```
FormatterContext {
  argv, cwd, env (filtered, no secrets),
  exitCode, durationMs,
  stdout, stderr, rawAnsi (the original bytes),
  paneId
}
```

Return a rich view, structured data the shell renders, or `pass` to decline and fall to the next lower tier.

## Three rules you must follow

1. **Keep raw available and fall back on error.** Never hide ground truth. If your parse looks wrong or throws, return `pass` or let the error fall back to raw. The raw toggle is always present.
2. **Probe, do not screen-scrape.** Prefer a machine-readable source over parsing wrapped text. Read `ls --color` SGR codes (dircolors encodes type) or run a side-effect-free probe (`readdir` plus `stat`). For git, use porcelain (`git status --porcelain=v2 -z`).
3. **If you are a community formatter, you run sandboxed.** No ambient filesystem or network access. Use only the provided API. The sandbox is a security boundary.

## Declaring an interactive form

Declare that an interactive widget exists and which flags it understands. The shell promotes to your widget only when the gate in `02` passes: non-interactive, bare at a tty prompt, local, no pipe or redirect or script, and the flags are understood. If a flag you do not handle is present, return `pass` so the block degrades gracefully. Never misrepresent.

## Side effects: visible commands only

A widget never mutates state directly. When the user acts, emit a real command into the prompt:

- stage a file -> emit `git add <path>`
- enter a folder -> emit `cd <dir>`

The emitted command runs through the approval gate (`10`) and appears in the log. No hidden mutations, ever.

## Freeze versus live

- Snapshot your state when the next command runs; freeze, and offer a refresh control to re-probe.
- Only the most recent block stays live.
- For session restore, persist the invocation plus light UI state (expanded folders, selection), not a live tree. Re-probe on reopen.

## Keyboard and focus

Reuse the shared vim-style navigation (`j`, `k`, `gg`, `G`, `/`, Enter to act). The prompt owns focus by default; the widget is focused explicitly; Esc returns focus to the prompt.

## Performance

Virtualize long lists. `stat` lazily (visible rows and on expand), never thousands of entries upfront.

## Test

The promotion decision (each gate condition, including the degrade paths), the visible-command emission, the freeze and refresh behavior, and, for community formatters, that the sandbox blocks filesystem and network access.
