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

## M9 Multi-window

**Goal:** native OS windows in addition to tabs and splits — a window is a workspace with its own tabs, panes, palette, and assistant dock, backed by the shared Rust process. **Lead:** frontend, with core for the IPC/session-restore work.

- Window state model: `WindowId`-keyed layout trees, per-window session records, IPC keying (`04`, `15`).
- React state refactor: audit and move app-global state that assumes "one window" into per-window scope; keep genuinely-global state (history, embeddings, safety-gate ledger) global.
- New-window command (`Cmd+N`) via the app menu and a palette entry. Spawn a fresh window with a default tab/pane against the shared backend.
- Per-OS lifecycle: on macOS the process stays alive when the last window closes (menu-bar + dock, `Cmd+Q` quits explicitly); on Windows and Linux, quit on last-window-close.
- Session restore for N windows: persisted list of window records, atomic write, off-screen-bounds snapping, per-window restore-error isolation.

**Exit:** the user can open, close, and switch between multiple windows; each has its own tabs / panes / palette / assistant; global history search returns results across every window; the app lifecycle matches OS conventions on all three platforms; quitting and relaunching restores the exact set of windows with their tabs, panes, and cwds.

**Explicitly out of scope:** pane portability (drag-across-windows), window groups, "warn on quit if a foreground process is running" (orthogonal polish decision).

## M10 Themes and fonts

**Goal:** the daily-driver polish M10 owes users — a real theming system with a curated catalog and a monospace font family / size / ligatures setting that drives both xterm and the code viewer. **Lead:** frontend.

- Preferences model gains an `appearance` block: theme mode (System / Light / Dark), the preset used in each mode, font family + size + ligatures. M7's `theme: {dark|light|system}` migrates in place.
- Built-in preset catalog embedded in the app bundle: Shax Dark / Light (default), Catppuccin (Latte / Frappé / Macchiato / Mocha), Solarized L/D, Dracula, Gruvbox L/D, Nord, Tokyo Night, and Phosphor (Amber / Green / White) as a retro toggle.
- Bundled OFL fonts (JetBrains Mono, Fira Code, Cascadia Code, Iosevka) plus system fonts as fallback. Fonts drive xterm output **and** CodeMirror; chrome (menus / buttons / labels) stays on the OS system UI font.
- Preferences pane Appearance section — mode picker + two preset dropdowns (one for light, one for dark), font family, size slider (10–24 pt), ligatures toggle. Every input is live; no save button.
- OS light / dark mode follow via `matchMedia`, in System mode. Manual pin overrides.

**Exit:** the user can pick any preset in the catalog and see it apply instantly across every surface (terminal, code viewer, chrome, assistant, safety modal); changing font family / size / ligatures reflows xterm correctly (TUIs stay on-grid); System mode reacts live to OS-level appearance changes; preferences persist across launches; existing M7 light/dark choices migrate without user action.

**Explicitly out of scope:** community theme drop-in (`~/.config/shax/themes/`), per-pane font size (zoom), per-window theme override. All three are called out in `16` for a later milestone.

Detail in `16-themes-and-fonts.md`. Sliced M10.1 – M10.4 (model + catalog, live application, fonts, preferences pane), plus a follow-up M10.5 below.

## M10.5 Monospace font-size scaling across secondary surfaces

**Goal:** the `appearance.font_size` preference should scale every monospace surface together, not just xterm and the code viewer. **Lead:** frontend.

M10.3 wired `appearance.font_size` to xterm and CodeMirror only. Nine other monospace-context surfaces (git-diff / git-status / ls formatters, block-list output preview, block metadata line, markdown code fences and inline code in both the file viewer and the assistant dock) carry hard-coded 11 / 12 / 12.5 px sizes. Bumping the terminal to 18 px leaves those "second-tier" mono surfaces stuck at their old size — visibly wrong against the surrounding terminal output.

- Derived scale tokens written by `applyTheme` alongside `--font-size-terminal`:
  - `--font-size-secondary: calc(var(--font-size-terminal) * 0.92)` — replaces 12 / 12.5 px sites.
  - `--font-size-compact: calc(var(--font-size-terminal) * 0.85)` — replaces 11 px sites.
- Nine hard-coded sites swap to these tokens. `em`-relative sizes (`0.9em`, `0.92em`) stay as-is — they already scale off prose.
- Design hierarchy (secondary content sits smaller than the terminal) is preserved because the ratio is fixed, not the pixel value.

**Exit:** bump `font_size` in the preferences pane; every mono surface scales together, and their relative sizes hold.

**Explicitly out of scope:** exposing the two ratios as user knobs. Fixed design values — a user complaining about hierarchy is a design conversation, not a preference.

## M11 PDF viewer

**Goal:** peek a PDF inline instead of shelling out to Preview / a browser. Extends the viewer stack (`06`) with one more content type. **Lead:** frontend.

- New `<PdfView>` component sitting next to `MarkdownView` / `HexView` in the viewer routing. Renders via **pdf.js** (Mozilla, Apache 2.0, ~1 MB minified) on a canvas per page, lazy-imported so the bundle doesn't take the hit until a user opens a PDF.
- Detection: magic bytes (`%PDF`) in `detectContentType.ts` catches any block whose captured output begins with the header — `cat file.pdf`, `curl -sO ... && cat`, `git show <blob>`. Extension `.pdf` covers the disk-read override path. The `ls` widget's file rows gain "open in viewer" for PDFs.
- v1 features: multi-page navigation (buttons + keyboard), in-content text search (`⌘F`), inline password prompt for encrypted PDFs.
- Modal-only render (same `BlockViewerModal` surface as image / markdown / hex). No inline-in-block preview in v1.

**Exit:** `cat any.pdf` in a pane surfaces a "View as PDF" affordance; opening it renders the PDF with page nav; `⌘F` searches text; encrypted files prompt for a password; the disk-read override handles files larger than the block store's captured-output cap.

**Explicitly out of scope:** zoom controls beyond fit-to-width, copy-text, annotations, form fields, signatures, print UI, `.docx` / `.xlsx` / `.pptx` (Office formats stay OS-delegated per the design note in the deferred candidate below).

Detail in `17-pdf-viewer.md`. Sliced M11.1 – M11.3 (detection + routing, pdf.js render + navigation, text search).

## M12 Prompt overhaul

**Goal:** the prompt strip becomes worthy of a daily driver — multi-line editing, focus-on-click, an honest three-mode indicator, a Shax-owned prompt header rich enough to replace what starship / p10k gave up, per-token syntax highlighting on every command surface, and a caret that carries the keymap and focus state of the pane it lives in. **Lead:** frontend, with core for the shell-integration hardening.

- Focus-on-click and mode-pill three-way (`COMMAND` for prompt focus, `CHAT` for assistant focus, `BLOCK` for block-focus mode); onboarding shortcut chips become real buttons.
- Shell integration hardening: shim resets PS1 / `PROMPT` to a bare OSC 133 A+B marker, forces `bindkey -e` / `set -o emacs`, and unloads `zsh-syntax-highlighting` in the new `appearance.shell_integration = "assertive"` default. Cooperative mode is the escape hatch (restores today's chain-only behavior). Fish is out of scope for the hardening.
- Multi-line prompt input: `\n` grows a row in the mirror renderer, `Shift+Enter` sends `\` + `\n` for shell PS2 continuation, bracketed-paste always on, large-paste (`≥ 5 lines OR ≥ 500 bytes`) gated behind a confirmation modal.
- Custom prompt header: `user@host · cwd · ⎇ branch ↑n ↓n` on the left, live `HH:MM:SS` on the right, ticking from a single App-level interval. Native battery + local-IP chips join the statusbar right cluster in M12.4b.
- Client-side syntax highlighting on the input line via a hand-rolled POSIX tokenizer (command / subcommand / flag / operator / string / variable / comment); colors from new `--syntax-*` theme tokens. Extended in M12.6 to every command-rendering surface (block headers, search snippets, palette command-recall, assistant chat shell fences).
- Cursor personality (M12.8): shape follows the line-editing keymap (line for Emacs / vi INSERT, block for vi NORMAL); focus state follows the strip (filled focused, hollow-block outlined blurred, line hidden on blur); optional 1 Hz blink under a new `appearance.cursor_blink` preference. A new **Prompt** settings-modal section houses the blink toggle and the Emacs / Vi line-editing radios.

**Exit:** clicking anywhere in the pane background focuses the prompt; the pill accurately reflects one of three surfaces; a default install lands on a bare Shax-owned prompt with no starship / p10k paint; `Shift+Enter` composes multi-line commands; the header renders enriched content that ticks; the statusbar carries battery + local-IP chips on all three platforms; commands color as you type and stay coloured across every surface that shows them; the caret's shape follows the keymap and its focus state follows the pane; every path has a cooperative-mode / fallback escape hatch.

**Explicitly out of scope:** a local line editor (history / completion / kill-ring in-strip — we keep mirroring the shell), full-grammar argv-aware tokenization, prompt fidelity inside SSH / `docker exec` / nested subshells, per-cluster header preferences, editing the user's dotfiles.

Detail in `18-prompt-overhaul.md`. Sliced M12.1 – M12.8 (focus + mode pill, shell integration hardening, multi-line input, custom header + native status probes, syntax highlighting on the input line, extending highlighting to every surface, cursor personality).

## M13 Sidebar with pinnable widgets (Phase 1)

**Goal:** grow a new persistent left-column surface — a collapsible sidebar that hosts always-on utility widgets. Phase 1 ships the sidebar chrome and five Shax-authored built-in widgets (clock, CPU/memory, network, git branch of the active pane, caffeinate); no runtime, no schema, no sandbox — those come in Phase 2. **Lead:** frontend, with core for the new native probes (`sysinfo`, per-OS SSID lookup).

- Sidebar chrome: 280px expanded / 44px icon-rail collapsed, `⌘B` toggle, per-window scope, first-run default icon rail. Focus never leaves the active pane on sidebar interaction.
- Clock widget: `HH:MM` + date, tick-shares with the M12.4 header clock.
- CPU/Memory widget: cross-platform via `sysinfo` v0.32, 2s refresh.
- Network widget: a pager over every interface that is up and holds an address, showing type, identity, per-type detail, IP and throughput. Per-OS probes — macOS CoreWLAN + `networksetup` + `scutil`, Linux `iwgetid` + `/sys/class/net`, Windows `netsh wlan`. The macOS SSID needs location authorisation and is requested only when the user asks; declining costs the name, not the medium. No ping, no latency (local-first, no telemetry). Detail in `19-sidebar.md` D5 item 3.
- Git-branch-of-active-pane widget: subscribes to the M12.4 prompt-header branch signal, updates on focus change + OSC 133 A, no additional polling.
- Caffeinate widget: click holds an OS-level power assertion (child `caffeinate -di` / `systemd-inhibit` on macOS / Linux, `SetThreadExecutionState` on Windows). State reconciles against what the OS grants, and is released on app exit. All three platforms ship — see `19-sidebar.md` D6, which reversed the original emit-into-the-pane design after a foreground `caffeinate` proved to block the pane it landed in, and settled where the honest-log path begins and ends.

**Exit:** every window has a sidebar with an icon rail visible by default; `⌘B` expands and collapses; the five widgets render live data on macOS and Linux; the caffeinate widget stops the machine idle-sleeping on all three platforms without blocking a pane, and shows off when the OS refuses; focus stays with the terminal at all times.

**Explicitly out of scope:** community widget sandbox (Phase 2), drag-to-reorder widgets, per-widget preferences panel, weather / kubectl widgets, sidebar-hosted panes / editors, a third "fully hidden" sidebar state. (Windows caffeinate *was* out of scope; the D6 reversal brought it in.)

Detail in `19-sidebar.md`. Sliced M13.1 – M13.4 (sidebar chrome + toggle, clock + git-branch, CPU/memory + network, caffeinate).

## Post-M8 candidates

Not-yet-sequenced work captured from a roadmap brainstorm. Each entry is a milestone-shaped chunk with its design calls already pinned; the sequencing into M14+ depends on which product lens gets prioritised — shipping to real users (installers + cross-platform), the AI-daily-driver story, filling out the terminal surface, or hardening what's already there. Move an entry into a numbered milestone once that decision is made.

### PDF viewer follow-ups

Deferred from M11: zoom controls (in / out / fit-width toggle) for small-print PDFs, PDF text copy (pdf.js's `getTextContent` already extracts it for search — wiring copy is small), Office-format viewers (`.docx` / `.xlsx` / `.pptx` explicitly stay OS-delegated — the OSS library landscape doesn't hit the quality bar and reimplementing at low fidelity is the wrong move for a terminal).

### Community theme drop-in

Follows M10. Users drop a `~/.config/shax/themes/<id>/theme.json` for any theme outside the built-in catalog. Same schema as the embedded catalog, plus a per-theme reload trigger in the palette. Pure data, no sandbox needed. Held for a follow-up milestone so M10 can ship without carrying schema-versioning and filesystem-watch UX.

### Sidebar Phase 2 — community widget sandbox

Follows M13. The Web Worker + declarative schema pattern already used for formatters and commands, extended for widget-specific needs (persistent state, timer ticks, richer rendering). Capability gates: theme yes, keyboard yes, timer yes; network only via an explicit user-granted permission at install time (`wttr.in` for weather, etc.); shell only through the safety gate, same rule as community commands. A per-widget max tick rate and a total widget-budget cap so twelve pinned widgets can't turn the app into a heater. Also picks up the drag-to-reorder story that Phase 1 deferred. (The Windows caffeinate follow-up this used to carry is cancelled — M13.4 shipped it.)

### No in-Shax app runtime — a standing non-goal

A full "in-Shax app runtime" is explicitly out of scope, not deferred: no Shax-native editor (users bring vim / Neovim / Helix / Zed in a pane), no cooler top-clone (btop and htop exist), no first-class pane-occupying apps. Every "app runtime" proposal that arises should be rerouted into either a widget in the sidebar or a real command running in a pane. The daily-driver non-negotiable is what draws the line here — Shax stays *a great terminal*, not an IDE-shaped dashboard.
