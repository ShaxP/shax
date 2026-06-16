# 08 Interactive widgets

Interactive widgets are formatters promoted to live, navigable components (tier 2 in `02`). They make `ls`, `git status`, and `git diff` explorable instead of static. They are powerful and risky, so the rules are strict.

## This is not hijacking input-owning programs

The dividing line is not "static versus interactive," it is "does the program own its own input loop or the alternate screen." `vim`, `less`, and `top` do, and are never touched. `ls`, `git status`, and `git diff` do not; they run, emit, and exit. Promoting their formatter to a widget is consistent with the model.

## The promotion gate

A widget renders only when the gate in `02-rendering-two-path.md` passes: non-interactive, invoked bare at the prompt with stdout on a tty, local (not over SSH), inside no pipe or redirect or script, and a widget exists that understands the command and the flags present. Any failure degrades to a static formatter, then to raw. When unsure, do not promote.

## You run a structured probe, not a decoration

Static formatting can decorate the bytes a command already emitted. Interactivity (expand a folder, show file metadata) needs data the text output does not contain, so the widget intercepts the command and runs its own structured source:

- `ls` widget: a side-effect-free `readdir` plus `stat`.
- `git status` widget: `git status --porcelain=v2 -z`, the stable machine-readable form.
- `git diff` widget: a parsed unified diff.

## The load-bearing rule: side effects through visible commands

A widget never mutates state silently. When the user acts, the widget emits a real, visible command into the prompt:

- staging a file emits `git add path/to/file`,
- entering a folder emits `cd that/dir`.

This keeps the scrollback an honest, reproducible log, routes every mutation through the same approval gate as the assistant (`10`), and teaches the user the underlying command. No hidden side channels.

## Frozen versus live

Scrollback is history. A widget five commands back showing a folder tree that no longer exists is a lie. So:

- A widget snapshots its state when the next command runs and freezes, with an explicit refresh control to re-probe.
- Only the most recent block stays live.
- For session restore, persist the invocation plus light UI state (which folders were expanded, the selection), never a live tree, and re-probe on reopen.

## Reference widgets and build order

Build in this order; it proves the freeze model and the visible-command pattern on low-risk widgets before the hard one.

1. **git diff** (first, read-only, zero mutation): syntax-colored, inline or side-by-side hunks, collapsible per file, keyboard navigable.
2. **git status** (introduces actions on safe operations): grouped into staged, unstaged, untracked; each file expandable to its diff; stage and unstage shown as the visible commands they emit.
3. **ls** (last, biggest flag surface and the `cd` side effect): a navigable list, folders expandable in place, a detail panel with size and created and modified dates and permissions, a quick preview, and `cd` on enter as a visible command.

## The flag-parity tax, named honestly

Every widget is a partial reimplementation of a real tool's semantics. Support the common flags; any flag you do not handle falls through to the static or raw path rather than silently misrepresenting. Never guess. For large directories, virtualize the list and `stat` lazily (visible rows and on expand only); do not `stat` 100k entries upfront.

## Keyboard and focus

Use the same vim-style navigation as the viewer and block list (`j`, `k`, `gg`, `G`, `/` to filter, Enter to act). The prompt owns focus by default; a widget is focused explicitly (click or a keybind), and Esc returns focus to the prompt.
