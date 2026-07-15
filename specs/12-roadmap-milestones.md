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

**Slice status.** Slices already landed under M7: semantic-search infrastructure with a mock embedder (slice 2), real ONNX `all-MiniLM-L6-v2` swap (slice 2b), the search-overlay semantic tier (slice 3), and blank-panes + `clear` soft-wipe + first-cut empty-state hints (slice 4). Remaining M7 polish threads, each broken out as its own sub-milestone below: **M7.5** design landing, **M7.6** terminal window polish, **M7.7** assistant in its own pane. A performance pass and any tail follow-ups from `05` are M7-scoped but not yet slotted.

## M7.5 Design landing

**Goal:** the two visual surfaces the design covers land in the app, at the fidelity the design specifies. **Lead:** frontend.

Bridge slice pair between M7's plumbing work and any further polish. The design bundle exported to `/design/` covers two product surfaces in this milestone (`empty-state.png`, `preferences.png`); a third and fourth image (`terminal-window.png`, `terminal-window-assistant-docked.png`) document the resting terminal state and the assistant-in-a-pane view — both are reference only, out of scope here, and revisited in their own milestone.

Non-negotiables from `13`: every reshape ships with dark **and** light variants; existing behaviour (block anatomy, prompt strip, safety gate, provider lanes) is preserved; the fonts stay the ones the app already ships (`--font-ui` Hanken Grotesk, `--font-mono` JetBrainsMono Nerd Font — see `src/theme/tokens.css`).

Two slices:

1. **M7.5a — Empty pane "Ready" state.** Reshape today's right-column of hints into the centered treatment in `empty-state.png`: a tinted chevron-in-rounded-square icon, a "Ready." heading with a small status dot, a one-sentence explanatory paragraph, and three wide chip-cards for the `⌘F` / `⌘K` / `⌘,` shortcuts. Bundle the icon glyph as an SVG under `src/assets/`. macOS traffic lights the design shows are OS-owned — nothing to render. Statusline / prompt-strip changes visible in the design image are part of the deferred terminal-window reshape; leave them untouched.

2. **M7.5b — Preferences modal reshape.** Keep the current modal — the design's full-window framing is a Claude Design canvas artifact, not the product shape. Take from `preferences.png`: a left-nav list with **two** entries (Appearance, Assistant), the right-side pane restyled to match — radio-in-card lane treatment (selected lane gets an accent-outlined card, unselected lanes are lower-contrast), a keychain-reassurance lock-icon strip under the API-key input, and a bottom status bar with `● all changes saved` on the left and `Esc or ⌘, to close` on the right. The Assistant nav item covers both Claude and Ollama in a single scrollable right pane; today they're two separate top-level sections. The design's Formatters and Keybindings nav entries are illustrative placeholders and are omitted from this slice.

**Exit criteria** (both slices):

- Visual layout matches the corresponding PNG at typical window sizes on both themes.
- No font changes; every new surface consumes `var(--font-ui)` / `var(--font-mono)`.
- Behaviour parity with what shipped in slice 4 (empty state) and today's `SettingsModal` (preferences): existing tests stay green, and no reduction in what the settings surface can do.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm prettier --check`, `cargo test --lib`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` all clean.
- The PR description references the specific PNG under `/design/` and calls out any deliberate departure.

**Deferred, and named here so nobody accidentally scopes them in:**

- `terminal-window.png` — tab-with-cwd labels, statusline restructure, prompt-strip placeholder copy, and the "Ask Shax why this failed" inline button on failed blocks. Lives in **M7.6** below.
- `terminal-window-assistant-docked.png` — the assistant-in-a-pane flow in its entirety. Lives in **M7.7** below.
- `?`-as-prompt-line assistant shortcut. The keystroke handler ships in M7.6; the assistant surface it opens ships in M7.7.
- Formatters / Keybindings preference sub-pages. Waits for those features to have functionality behind them; no milestone slotted yet.

## M7.6 Terminal window polish

**Goal:** the resting terminal window matches `design/terminal-window.png` at the fidelity the design specifies. **Lead:** frontend.

The chrome and block-affordance changes visible in the terminal-window design that were deferred out of M7.5. Small enough to consider one slice; natural split if it needs one is (a) chrome (tabs + statusline + prompt strip) and (b) inline block affordance ("Ask Shax why this failed").

Non-negotiables from `13`: dark + light; fonts stay Hanken Grotesk + JetBrainsMono; existing behaviour (keystroke routing, cwd/branch propagation, block streaming, safety gate) preserved.

Scope:

- **Tab labels carry cwd.** Format: `<shell-name> <compact-cwd>` (e.g. `shax ~/dev/shax`). Compact rules: `$HOME`-prefixed paths shown as `~/…`; long paths shortened at the tail (`~/…/bar`). Truthful — the cwd shown is the pane's latest OSC 133 A cwd.
- **Statusline restructure.** Left: mode chip (`NORMAL` / `INSERT`). Middle: git status compact (`⎇ main +1 ~2`) followed by cwd. Right: assistant shortcut hint (`+ ⌘K Ask Shax`) and `shax •` brand tag. `utf-8 · ln 1, col 1` from the design is viewer-only — omit from the pane's statusline where it has no honest source, or move it into the viewer surface where it does.
- **Prompt-strip placeholder copy.** Change to `type a command, or ? to ask Shax`. Add a keystroke handler that intercepts `?` as the *first character on an empty prompt* and instead opens the assistant (whatever surface M7.7 gives us). If the prompt already has content or the caret isn't at position 0, `?` is a normal character.
- **"Ask Shax why this failed" inline button.** On completed blocks with `exit_code != 0 && !aborted`, render an inline `+ Ask Shax why this failed  ⌘↩` button under the block content. `⌘↩` triggers when the block is selected. Activation emits the explain-on-error flow already sketched in `09` — the button is the affordance, not the flow.

**Exit:**

- Every affordance in `terminal-window.png` that isn't the illustrative btop panel is visible in the resting app on both themes.
- `?`-first-char handler does not hijack `?` when it isn't the first character.
- The Ask-Shax button routes to the active assistant provider with a well-formed prompt containing the block's command + a bounded slice of its output; the current M6 explain-on-error path works from the button.
- All existing tests stay green; keystroke routing, cwd / branch propagation, and block streaming unchanged.
- Standard gates (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm prettier --check`, `cargo test --lib`, `cargo clippy -D warnings`, `cargo fmt --check`) clean.

## M7.7 Assistant in its own pane

**Goal:** the assistant lives as a docked right-side pane matching `design/terminal-window-assistant-docked.png`, replacing today's overlay. **Lead:** frontend, with safety review from ai.

**Depends on:** M7.6 lands first — M7.7 uses M7.6's `?`-first-char handler as one of its open triggers and the statusline slots M7.6 restructures for the "approval pending" / "assistant active" indicators.

Non-negotiables from `13` and CLAUDE.md: every side effect passes through the safety gate at `10`; every approved action emits a visible command into the pane's scrollback (honest-log contract); provider-appropriate privacy posture is surfaced (`● local — nothing leaves this machine` for Ollama, appropriate variant per Claude lane).

Scope:

- **Docked-pane model.** Assistant becomes a right-side pane instead of a modal overlay. Toggle open/close via ⌘K, `?` on empty prompt, or the header assistant-icon. Persist docked state (open / closed / width) across launches. Resizable by dragging the split boundary — reuse the M2 pane-split infrastructure.
- **Header.** `+ Shax` label with provider badge (`claude` / `ollama`), `+ New` (starts a fresh conversation, replacing the current one — no tabs), close ✕.
- **Message rendering.**
  - Assistant text as plain prose with minimal chrome (existing `ChatMarkdown` treatment).
  - **Suggested read-only actions** as bordered cards: `SUGGESTED — READ ONLY` header with `✓ no side effects` chip, inline command in monospace, `Run` button. Clicking Run emits the command into the active pane's prompt as visible input.
  - **User replies** as accent-outlined chip-bubbles on the right — the shortcut phrasings the assistant offered as follow-ups.
  - **APPROVAL REQUIRED** amber-outlined cards: warning header (`⚠ writes N files · staged`), monospace command list, affected-file preview (`📎 path + stage`), Approve / Decline buttons. The actual approval goes through the safety gate at `10` — the card is the visual, not the gate.
- **Input footer.**
  - Multiline input with placeholder `Ask Shax, or describe a command…`.
  - Bottom row: `⏎ send` hint, `⌘G goal mode` toggle button, right-aligned privacy-reassurance strip (provider-appropriate).
- **Statusline integration.** When the pane is open, right side gains `⚠ N approvals pending` (only when any pending) and `+ assistant active`.
- **Prompt-strip integration.** When the pane is open, the main pane's prompt-strip placeholder becomes `assistant is working beside you`.
- **Mode indicator.** Focus in the assistant input → statusline shows `INSERT`. Focus back in the block list → `NORMAL`.

**Non-goals:**

- Multiple concurrent assistant panes. One at a time; toggling from another pane moves the dock.
- Tabs within the assistant pane. `+ New` replaces, doesn't tab.
- Cross-pane context. The assistant is scoped to the pane it's docked in.

**Exit:**

- Assistant dock / undock / resize / persist works across launches.
- The chat panel renders each message shape from the design (assistant prose, suggested-read-only card, user-reply chip, approval-required card).
- Every action a user takes from the pane (Run on suggestions, Approve on approval-required) goes through the safety gate; every approved side effect emits a visible command into the target pane's scrollback.
- Provider-appropriate privacy reassurance is visible in the input footer for both Claude lanes and Ollama.
- Existing tool-use behaviour continues to work.
- Dark + light.
- Standard gates clean.

## M8 Pane command palette

**Goal:** a `Cmd+K` palette that exposes pane-scoped operations as guided UIs that emit real shell commands. **Lead:** frontend, with safety review from ai.

- The palette framework: registry, matcher-against-`PaneContext`, panel lifecycle, fuzzy filter, overlay-bypass for block-focus, preview-and-submit gesture (`14`).
- Built-in `cd to directory` with a single-pane file browser (breadcrumb header, list body, type-ahead filter, arrow / vim navigation, hidden-files toggle, symlink awareness).
- Built-in git commands: `status` (read-only viewer), `checkout` (branch picker → `git checkout`), `stash` (form → `git stash push`), `commit` (message + body → `git commit`), `rebase` (target picker → `git rebase`). All destructive paths pass through the existing safety gate (`10`).
- Community pane-command sandbox: worker-isolated, declarative panel-schema API (text / multiline / dropdown / list-picker / file-picker / toggle), `buildCommand(values) → string` callback, manifest in `~/.config/shax/commands/`. Mirrors the formatter sandbox model.
- A "Reload commands" entry in the palette for development workflow.

**Exit:** `Cmd+K` opens the palette in any pane; the built-in commands compose and submit real shell commands visible in the user's scrollback; destructive commands prompt twice (palette confirm + safety gate); a sample community command loads from disk, runs sandboxed, and cannot bypass the prompt-emission contract.
