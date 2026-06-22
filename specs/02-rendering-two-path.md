# 02 Rendering: the two-path model

This is the model everything else hangs off. Read it carefully.

## The problem

A terminal is a byte stream with ANSI escapes that a terminal engine turns into a character grid. Rich features (icons, syntax color, widgets) are not in that stream. So we cannot reformat the live stream without breaking the programs that depend on it being a real terminal. The solution is two distinct paths.

## Path one: raw passthrough (live and interactive)

Whenever a program switches to the alternate screen buffer (detected from `?1049h` and cleared on `?1049l`), or whenever shell integration is absent so the backend cannot bound commands, the pane is pure xterm.js passthrough. No formatting, no icons, no exceptions. This covers vim, less, top, ssh sessions, REPLs, and anything else that owns its own input loop or the alternate screen. This is non-negotiable: breaking it breaks interactivity.

## Path two: the completed block (rich)

A shell-integrated, non-alt-screen command is bounded by OSC 133 C and D. Its output bytes are still raw — no formatting runs while it is running — but they stream into the block, not into xterm. The visible scrollback in the resting state is the block stack; the xterm canvas is hidden until path one applies. When the command finishes, the block carries its full byte stream and can be promoted up the ladder below.

When a non-interactive command finishes, the backend has its captured stdout and stderr plus the argv, cwd, exit code, and timing from OSC 133. That, and only that, is where formatting runs.

## The three-tier ladder

A completed block is rendered at the highest tier it qualifies for, and always degrades cleanly:

- **Tier 0, raw.** The real bytes. Used for interactive programs, pipes, redirects, non-tty output, SSH, and any time a formatter is absent, disabled, or throws.
- **Tier 1, static formatter.** Icons, color, syntax highlighting, structured rendering of a completed block. See `07-formatters.md`.
- **Tier 2, interactive widget.** A live, navigable component. See `08-interactive-widgets.md`.

Every tier-1 and tier-2 block carries an always-available toggle back to raw. A formatter that errors falls back to raw silently. This is the fidelity contract.

## The promotion gate

A command is promoted up the ladder only when each condition holds. Failing a condition degrades it to a safer tier.

1. **Non-interactive program?** It must not own its own input loop or the alternate screen. If it does (vim, less, top), stay at raw.
2. **Bare at the prompt, on a tty, local?** It must be invoked directly at the interactive prompt, with stdout attached to a tty, not inside a pipe, a redirect, or a script, and not over SSH. If not, render raw (or static after exit) but never interactive.
3. **Is there a formatter or widget that understands this command and its flags?** If a registered widget handles the command and the flags present, promote to tier 2. If only a static formatter applies, use tier 1. If neither, raw.

The OSC 133 capture and the shell integration give the backend what it needs to evaluate conditions 1 and 2. Condition 3 is the formatter registry's job.

## Why this matters

This model is what lets Shax be both a real terminal and a rich one. Keep the boundary sharp: when in doubt about whether something is interactive, treat it as interactive and stay raw. A missed formatting opportunity is invisible; a broken vim session is not.
