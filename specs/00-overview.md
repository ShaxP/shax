# 00 Overview

## What Shax is

Shax is a cross-platform desktop terminal emulator for developers. It runs ordinary Linux and Unix commands, but instead of treating the screen as one flat byte stream, it treats each command and its output as a structured block: a unit with the command, its output, an exit status, timing, the directory it ran in, and which pane and session produced it. Those blocks are richly formatted, fully searchable, and occasionally interactive. A Claude-powered assistant is available throughout but stays quiet until invoked.

It is built on Tauri 2: a Rust backend and a React and TypeScript frontend in a native window. It is local-first and privacy-respecting. No account is required to use the terminal.

## The soul

One sentence governs every decision: this is a beautiful daily-driver terminal first, with AI sprinkled in. The detailed principles live in CLAUDE.md and are repeated where they bite in each spec. The short form:

- Calm and fast. The chrome is quiet; the eye lands on output.
- The fidelity contract. Rich views are a lens over the real bytes; raw is always one toggle away.
- The honest log. The scrollback is truthful and reproducible; actions happen through visible commands.
- Keyboard-first, with vim-style navigation and a clear mode indicator.
- Local-first and private.

## Headline features

- **Structured blocks** for every command, with rich, fallback-safe formatting.
- **Searchable history**, the standout feature: a local, queryable record of every command and its output, by text and by meaning, filterable by repo, exit code, time, and pane. The same index is the assistant's memory.
- **Native local multiplexing**: panes, splits, tabs, and layout restore, without becoming a tmux server.
- **A rich file and content viewer**: syntax highlighting, line numbers, search, vim navigation, plus markdown and image rendering.
- **Interactive widgets** for git diff, git status, and ls, promoted from formatters under a strict gate, acting only through visible commands.
- **An understated AI assistant**: natural-language-to-command, explain-on-error, and an optional agentic goal mode, all behind a permission gate, using the user's own Claude auth.

## Who it is for

Developers who live in the terminal and want it to be faster to navigate, easier to search, and occasionally smarter, without giving up the speed, honesty, and control of a real terminal.

## Non-goals

- Not an agent-first IDE. The terminal is the product; the AI assists.
- Not a tmux replacement for remote, detachable sessions. Multiplexing is local; tmux is respected over SSH.
- No rich rendering of remote output over SSH in the first release.
- No cloud account, no required sign-in, no telemetry without opt-in.

## How to read these specs

Read in order. `01` is the architecture. `02` is the rendering model that everything else hangs off. `03` through `10` are the subsystems. `11` is the concrete stack and conventions. `12` is the milestone roadmap and the place to start building.
