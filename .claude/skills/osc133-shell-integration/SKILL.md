---
name: osc133-shell-integration
description: Use when writing or parsing OSC 133 semantic-prompt shell integration for Shax, in zsh, bash, or fish, or when assembling command blocks from the markers. Covers the marker sequences, the per-shell hook scripts, carrying cwd and exit code, and the edge cases.
---

# OSC 133 shell integration

Shax bounds each command using OSC 133 semantic-prompt sequences emitted by shell hooks. This is the same mechanism iTerm2, Warp, and Ghostty use. Get this right and the block model, search, and the rendering ladder all work.

## The markers

- `OSC 133 ; A ST` prompt start
- `OSC 133 ; B ST` prompt end, command input begins
- `OSC 133 ; C ST` command output begins (preexec)
- `OSC 133 ; D ; <exit> ST` command finished, with the exit code

`OSC` is `ESC ]` (`\033]`), `ST` is `ESC \` (`\033\\`) or BEL (`\007`). Emit these from the shell so the terminal can see them in the stream.

## Carrying extra data

Report cwd, git branch, and the command line with additional key-value sequences alongside the markers (an `OSC 133 ; A` can carry properties, or use a dedicated `OSC` for cwd such as the `7` cwd convention). Keep payloads small and escape them.

## zsh

Use `precmd` and `preexec`:

- `precmd` emits `A` then `B`, and reports cwd and git branch.
- `preexec` emits `C` and reports the command line.
- emit `D` with `$?` before the next prompt (precmd is a good place to emit the previous command's `D` using the captured status).

## bash

Use `PROMPT_COMMAND` plus a `DEBUG` trap, or `bash-preexec` if available. `PROMPT_COMMAND` handles `A`, `B`, and the previous `D`; the `DEBUG` trap handles `C` and the command line. Capture `$?` first thing in `PROMPT_COMMAND`.

## fish

Use the `fish_prompt`, `fish_preexec`, and `fish_postexec` events. `fish_postexec` has `$status` for `D`.

## Rules for the scripts

- Idempotent and safe to source twice.
- Do not clobber the user's existing hooks; chain onto them, do not overwrite.
- Degrade silently to a plain terminal when Shax is not the host.
- Offer installation on first run; source from the user's shell rc.

## Parsing side (backend)

- Track per-pane state: are we between B and C (input), C and D (output)?
- The output region for the block is the bytes between C and D.
- Read the exit code from D.
- Independently watch `?1049h` and `?1049l` for the alternate screen, regardless of OSC 133 state.

## Edge cases (test these)

- No `D` ever arrives (shell killed): mark the block aborted once the shell dies; never leave it Running.
- A program enters the alternate screen mid-command then exits: stay raw, do not retroactively format.
- Multi-line and chained command lines.
- A user without integration installed: degraded best-effort blocks plus a prompt to install.
