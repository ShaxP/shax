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

**Slice status.** Slices 3.1–3.6 close M3: basic FTS + overlay, in-pane jump-or-inspect, status / time chips, cwd + branch quick-filters with faceted dropdowns, inline matched-term highlight, the repo-root "this repo" filter, trigram-substring fuzzy matching, and (3.6) the free-form path/glob input on the cwd dropdown.

Polished further in M7:

- **Edit-distance fuzzy** (e.g. `kubctl` → `kubectl`). 3.5's trigram pass catches substring matches but not transposition / missing-letter typos. SQLite's `spellfix1` or a custom Levenshtein function via rusqlite would cover that gap; deferred because it needs a separate index + scoring pass that's distinct from the FTS5 plumbing.

## M4 File viewer and static formatters

**Goal:** rich, fallback-safe rendering of completed output. **Lead:** frontend.

- The CodeMirror viewer with syntax highlight, line numbers, search, and vim keys; markdown and image rendering with sanitization (`06`).
- The formatter registry and worker sandbox, and the built-in static formatters: `ls` (color and icons), `git diff` and `git status` (static), JSON, and the others in `07`.
- The raw and formatted toggle wired to real formatters; silent fallback on error.

**Exit:** completed output renders richly with a working raw toggle; the viewer opens files; a formatter that throws falls back to raw with no visible breakage; the sandbox blocks ambient access.

## M4.5 Formatter polish (between M4 and M5)

**Goal:** finish the formatter story before adding interactive widgets on top. **Lead:** frontend.

Three slices, in this order. None gates the next milestone — but doing them now keeps the formatter machinery fresh in the codebase, and the inline-markdown / inline-image win lands as a daily-driver improvement long before M5 widgets are ready.

1. **Content-aware `cat` with FMT / SRC / RAW lens toggle.** Today the inline cat formatter shows file source in CodeMirror regardless of content; the rendered-markdown / image-view treatment only happens in the modal viewer. Lift the modal's content-aware routing into a shared `ContentView` component so inline cat shows markdown as markdown, images as images, and svg as svg with the same disk-read + DOMPurify + image-fit plumbing the modal already uses. Grow the FMT/RAW pill into a per-block-content lens group: FMT (rendered) / SRC (source — CodeMirror for text, hex dump for binaries) / RAW (captured stdout, unchanged). Specced in `07`. Hex dump is xxd-style, file-signature-highlighted, sticky offset column, virtualised for large files.

2. **INFO lens for binary metadata — phase 1.** Once `ContentView` is shared, add the INFO button on image / binary cat blocks. Phase 1 ships PNG IHDR + JPEG EXIF (camera / lens / time / GPS, with a redaction option) + GIF frame count + loop count — together these cover roughly 99% of image cat blocks. Phases 2 (WebP + SVG warnings) and 3 (anything else) follow as need surfaces and can interleave with M5 work. Per-format parsers are small (sub-200-LOC) and well-documented. The lens reuses `ContentView` so it is structurally a fourth view, not a separate UI. See `07` for the per-format field table.

3. **ANSI / SGR colour rendering inside the viewer.** Slice 4.1 strips ANSI before feeding text to CodeMirror because CM6 doesn't understand SGR codes — viewing `ls --color` / `git log --color` / `cargo build` output through the viewer therefore shows clean text without the colours the bytes carry. The structured formatters (`ls`, `git status`, `git diff`, JSON) paint their own colour from probes / parsing, so the gap only appears for blocks that have ANSI but no registered formatter. Close by parsing SGR runs into CodeMirror range decorations (cleanest, stays vim-navigable) or by adding a generic "ANSI-coloured text" formatter that catches that bucket. Bytes are already preserved end-to-end; this is purely a rendering enhancement. Lowest priority of the three — it's a long-tail polish item.

**Exit:** inline cat blocks render markdown, images, and svg correctly; the lens toggle shows FMT / SRC / RAW (plus INFO on image / binary blocks); ANSI-coloured output in the viewer renders with its colours intact.

## M5 Interactive widgets

**Goal:** explorable git diff, git status, and ls. **Lead:** frontend, with safety review from ai.

- The promotion gate enforced (`02`, `08`). Build in order: git diff, then git status, then ls.
- The visible-command rule for all actions; the freeze-versus-live model with refresh; restore via re-probe.

**Exit:** the three widgets work behind the gate; pipes, redirects, scripts, and SSH correctly degrade to static or raw; every action emits a visible command; older widgets freeze and refresh correctly.

## M6 Assistant, auth, and the gate (pluggable providers)

**Goal:** AI sprinkled in, safely, with the provider a user choice. **Lead:** ai, with frontend for the dialog.

- The `AssistantProvider` interface (`09`) with capability-based feature gating and a `privacyPosture` label surfaced prominently in settings.
- The permission and approval gate fronting every side effect (`10`), provider-agnostic and shared by widgets and the assistant.
- **Claude** as the first provider — both auth lanes (subscription via the local install, and API key). Full capabilities.
- **Ollama** as the second provider — local, no auth, capability set probed at connect time. Chosen because it stress-tests the graceful-degradation model (no tools, no subagents on many models).
- Natural-language-to-command, explain-on-error, and the optional agentic goal mode — all capability-gated, with a clear "requires tool-calling" hint on providers that lack the capability.
- Tools defined once in Anthropic's tool-use schema; non-Claude providers get a translation layer.

**Exit:** the two first-party providers work end-to-end; feature availability degrades gracefully based on declared capabilities; the assistant is explicit-by-default; no side effect runs without passing the gate; destructive patterns get the stronger confirmation; the "local — nothing leaves your machine" label is visible on Ollama in settings.

**Next-to-implement (M6.5 / M7):** OpenAI (API key), GitHub Copilot (device flow, no long-lived token in Shax), MLX (local, Apple Silicon). Community providers via the sandbox pattern deferred further.

## M7 Semantic search and polish

**Goal:** a 1.0 candidate. **Lead:** all, orchestrated.

- `sqlite-vec` embeddings (local by default) and hybrid literal-plus-semantic search (`05`).
- Performance pass, full dark and light themes, onboarding and empty states, and the assistant-in-its-own-pane flow.

**Exit:** hybrid search answers fuzzy intent queries; the app is fast under large histories; dark and light are both polished; onboarding teaches the keyboard model.

## M8 Pane command palette

**Goal:** a `Cmd+K` palette that exposes pane-scoped operations as guided UIs that emit real shell commands. **Lead:** frontend, with safety review from ai.

- The palette framework: registry, matcher-against-`PaneContext`, panel lifecycle, fuzzy filter, overlay-bypass for block-focus, preview-and-submit gesture (`14`).
- Built-in `cd to directory` with a single-pane file browser (breadcrumb header, list body, type-ahead filter, arrow / vim navigation, hidden-files toggle, symlink awareness).
- Built-in git commands: `status` (read-only viewer), `checkout` (branch picker → `git checkout`), `stash` (form → `git stash push`), `commit` (message + body → `git commit`), `rebase` (target picker → `git rebase`). All destructive paths pass through the existing safety gate (`10`).
- Community pane-command sandbox: worker-isolated, declarative panel-schema API (text / multiline / dropdown / list-picker / file-picker / toggle), `buildCommand(values) → string` callback, manifest in `~/.config/shax/commands/`. Mirrors the formatter sandbox model.
- A "Reload commands" entry in the palette for development workflow.

**Exit:** `Cmd+K` opens the palette in any pane; the built-in commands compose and submit real shell commands visible in the user's scrollback; destructive commands prompt twice (palette confirm + safety gate); a sample community command loads from disk, runs sandboxed, and cannot bypass the prompt-emission contract.
