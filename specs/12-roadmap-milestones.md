# 12 Roadmap and milestones

Build order matches the agreed priorities: terminal, then multiplexing, then search, then viewer and static formatters, then interactive widgets, then the assistant. Early milestones are detailed; later ones are specced at a higher level here and detailed when reached.

Each milestone ends only when its exit criteria hold and the definition of done in CLAUDE.md is met. The orchestrator owns sequencing.

## M0 Foundation

**Goal:** a repo that boots and a green pipeline. **Lead:** orchestrator, with core and frontend.

- Tauri 2 project scaffold: `src-tauri` Rust host, `src` React and TypeScript via Vite.
- Toolchain pinned (`rust-toolchain.toml`, Volta), pnpm workspace, ESLint, Prettier, rustfmt, clippy, Vitest, Playwright configured.
- lefthook with lint-staged; `.github/workflows/ci.yml` running fmt, clippy `-D warnings`, lint, typecheck, and tests on macOS, Windows, and Linux.
- CLAUDE.md, specs, agents, and skills in place. LICENSE and README.

**Exit:** the app opens an empty window on all three platforms; CI is green; a trivial Rust test and a trivial Playwright test pass.

## M1 A working terminal with blocks

**Goal:** run real commands, see real blocks, full raw fidelity. **Lead:** core, with frontend.

- One PTY via `portable-pty`, keystroke round-trip into a single xterm.js pane, output streaming back over a channel, scrollback. Alt-screen detection keeps interactive programs (vim, less, top) in raw passthrough.
- OSC 133 shell integration for zsh, bash, and fish, with a first-run install flow. Command boundaries, exit codes, timing, cwd, and git branch captured into block records (`03`).
- The block UI: command, output, status and exit code, timing and cwd, the streaming and completed states, and the always-available raw toggle (which at this stage just shows the raw stream, since no formatters exist yet).
- SQLite store persists blocks and output (`05`), so history survives restart.

**Exit:** run a session of commands and see correctly bounded blocks with exit codes and timing; vim and less and top work untouched; blocks persist across restart; raw fidelity is exact.

## M1.5 Design alignment

**Goal:** the resting state of a window matches `/design`. **Lead:** frontend.

A small bridge milestone between M1 and M2. M1 proved the data model (blocks, OSC 133, persistence, multiple shells) but rendered the result as `xterm canvas + sidebar`. The design is block-first: the visible scrollback IS the block stack, the xterm canvas is reserved for path-one passthrough, and input lives in a dedicated prompt strip. Doing this realignment before M2 means the multiplexing UI (tabs, splits, statusline) extends real chrome instead of a placeholder.

- Theme tokens in `src/theme/tokens.css` matching the design's CSS variable palette (dark only; light deferred to M7 polish). Inline hex colors removed from components.
- Three-row window chrome: title and tab bar on top, pane area in the middle, statusline on the bottom. Tabs, toolbar icons, and statusline are visual-only at this stage — M2 wires their behaviour.
- Block anatomy redrawn to the design: coloured 3px left edge, inline `FMT`/`RAW` segmented pill (RAW default; FMT inert until M4), hover-revealed action row (copy works; rerun/share/ask-shax inert until M5/M6), status iconography (❯ + check / × / spinner / amber).
- A new `PtyEvent::BlockChunk { block_id, bytes }` event carries output bytes scoped to the currently-running block alongside the existing raw output stream that xterm continues to consume. Running blocks render their output inline; the xterm canvas stays in place as the input surface for now (the prompt strip lands in M1.9).

**Exit:** the resting window matches the design's chrome and block anatomy; running a command shows its output stream into the block; vim and less and top still work untouched; existing M1 behaviour is fully preserved.

## M1.9 Prompt strip owns input

**Goal:** the prompt strip is the visible input surface, with full readline fidelity. **Lead:** frontend.

Split out of M1.5 once that milestone landed only the streaming-output half. M1.5 left the xterm canvas as the input surface so we could ship inline block output without committing to a shell-line-editing model. M1.9 finishes the job:

- A new `PromptStrip` component owns keystrokes between OSC 133 D (or B at session start) and the next C. The strip captures keys, forwards them to the PTY, and renders the shell's echo back to the user.
- A tiny single-line VT renderer inside the strip interprets the relevant escape sequences (cursor left/right, backspace, kill-to-end, kill-to-start, plus printable chars) so history navigation (`↑` / `↓`), Tab completion, `Ctrl-R`, `Ctrl-W`, and `Ctrl-U` all update what the user sees, in lockstep with what the shell is actually editing.
- The xterm canvas is hidden in the resting state and revealed only when the alternate screen activates. The block stack hides itself in alt-screen mode and xterm takes the pane area.
- The strip renders cwd and branch from the latest OSC 133 A so the chrome reflects where the next command will run.

**Exit:** typing into the prompt strip drives the shell as if the user were typing into a real terminal; history navigation, completion, and the standard readline shortcuts visibly update the strip; xterm stays out of the way until a program demands the alt screen.

## M2 Native multiplexing

**Goal:** panes, splits, tabs, and layout restore. **Lead:** core, with frontend.

- The layout tree, multiple PTYs (one per pane), horizontal and vertical splits, focus, and tabs (`04`).
- Resize and winsize propagation so TUIs reflow correctly. Process-group teardown and reaping on pane close and on shell exit.
- Session and layout restore: reopen into the same tree and cwds.

**Exit:** split and tab freely; resizing reflows vim and htop correctly; closing panes leaves no zombies; reopening restores the layout.

## M3 Search

**Goal:** find anything in history. **Lead:** core (backend), frontend (UI).

- FTS5 literal and fuzzy search over commands and output; metadata filters (exit code, repo, time, pane, branch).
- The search UI: one query field, composable filters, results as compact blocks you can jump to, with empty and populated states.

**Exit:** literal and metadata search across thousands of seeded blocks returns relevant results quickly; results jump back to the source block.

**Slice status & follow-ups.** Slices 3.1–3.5 shipped basic FTS, the overlay, in-pane jump-or-inspect, the status / time chips, cwd + branch quick-filters with their faceted dropdowns, inline matched-term highlight, the repo-root "this repo" filter, and (3.5) trigram-substring fuzzy matching alongside the literal index. Remaining in M3:

- **Free-form cwd / path filter input** (path glob, e.g. `~/project/**`). The cwd dropdown's "Here", "Repo", and history entries cover the daily-driver cases; this covers the spec example "Everything run in `~/project` this week" when the user isn't physically standing in that directory and hasn't visited it recently.

Polished further in M7:

- **Edit-distance fuzzy** (e.g. `kubctl` → `kubectl`). 3.5's trigram pass catches substring matches but not transposition / missing-letter typos. SQLite's `spellfix1` or a custom Levenshtein function via rusqlite would cover that gap; deferred because it needs a separate index + scoring pass that's distinct from the FTS5 plumbing.

## M4 File viewer and static formatters

**Goal:** rich, fallback-safe rendering of completed output. **Lead:** frontend.

- The CodeMirror viewer with syntax highlight, line numbers, search, and vim keys; markdown and image rendering with sanitization (`06`).
- The formatter registry and worker sandbox, and the built-in static formatters: `ls` (color and icons), `git diff` and `git status` (static), JSON, and the others in `07`.
- The raw and formatted toggle wired to real formatters; silent fallback on error.

**Exit:** completed output renders richly with a working raw toggle; the viewer opens files; a formatter that throws falls back to raw with no visible breakage; the sandbox blocks ambient access.

## M5 Interactive widgets

**Goal:** explorable git diff, git status, and ls. **Lead:** frontend, with safety review from ai.

- The promotion gate enforced (`02`, `08`). Build in order: git diff, then git status, then ls.
- The visible-command rule for all actions; the freeze-versus-live model with refresh; restore via re-probe.

**Exit:** the three widgets work behind the gate; pipes, redirects, scripts, and SSH correctly degrade to static or raw; every action emits a visible command; older widgets freeze and refresh correctly.

## M6 Assistant, auth, and the gate

**Goal:** AI sprinkled in, safely. **Lead:** ai, with frontend for the dialog.

- The local Agent SDK integration with constrained tools; the two auth lanes (`09`).
- Natural-language-to-command, explain-on-error, and the optional agentic goal mode.
- The permission and approval gate fronting every side effect (`10`), shared by widgets and the assistant.

**Exit:** both auth lanes work (subscription via local install, and API key) with no credential handling by Shax; the assistant is explicit-by-default; no side effect runs without passing the gate; destructive patterns get the stronger confirmation.

## M7 Semantic search and polish

**Goal:** a 1.0 candidate. **Lead:** all, orchestrated.

- `sqlite-vec` embeddings (local by default) and hybrid literal-plus-semantic search (`05`).
- Performance pass, full dark and light themes, onboarding and empty states, and the assistant-in-its-own-pane flow.

**Exit:** hybrid search answers fuzzy intent queries; the app is fast under large histories; dark and light are both polished; onboarding teaches the keyboard model.
