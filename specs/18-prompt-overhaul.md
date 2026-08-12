# 18 Prompt overhaul

## Goal

The prompt strip is Shax's most-touched surface after the block list. Today it works — keys go in, the shell echoes back, the mirror renderer paints — but it stops at single-line input, has no syntax awareness, does nothing when the user clicks the empty area, hides all shell-rendered PS1 without owning that ground, and shares the `NORMAL` mode label between two orthogonal focus states. M12 makes the prompt worthy of a daily driver: multi-line editing, focus-on-click, an honest three-mode indicator, a Shax-owned prompt header rich enough to replace what starship / p10k gave up, and per-token syntax highlighting on the input line.

This is a focused UX + shell-integration milestone. No backend architecture changes (the OSC 133 protocol, the block store, the safety gate all stay put); the seams that move are `PromptStrip`, `promptRenderer`, `Statusline`, the pane-root click handler, and the three `shell-integration/shax.{zsh,bash,fish}` shims.

## Motivation

Five items came from the user, clustered by symptom:

1. **No multi-line composition.** Multi-statement or `\`-continued commands paste but can't be authored in-strip. The renderer is single-row by design (`promptRenderer.ts:21-26`).
2. **Dead click zone.** Clicking the pane background, the empty-state hero, or any of the onboarding shortcut chips does nothing — focus stays wherever the browser last put it, which is usually `body`.
3. **PS1 orphaned.** The shell still computes and paints PS1 (starship, p10k, oh-my-zsh themes) into bytes we then throw away because the resting UI hides the xterm grid. The user's shell-side prompt tooling costs CPU on every command for zero visible benefit, and `bindkey -v` / `set -o vi` silently break the strip's emacs-style key bindings.
4. **The mode pill lies.** `NORMAL` / `INSERT` in the statusline is a two-way switch driven by exactly one bit — assistant textarea focus. Block-focus mode does not surface. The prompt itself has no positive label.
5. **No syntax feedback.** The strip is monochrome except for a heuristic that dims `zsh-autosuggestions` ghost text. Users with `zsh-syntax-highlighting` get some coloring; users on bare bash get nothing.

## Locked decisions

Every decision below is my recommendation, called out so you can push back before we sink cost. Change them here in the spec, not later in code.

### D1 — Enter submits; Shift+Enter inserts a newline (multi-line)

Enter behaves as today (writes `\n` to the PTY; the shell interprets it as end-of-line and either executes or drops to PS2). Shift+Enter writes `\` + `\n` — a shell continuation the user can back out of by deleting the trailing backslash. This is the Warp / iTerm2 default and the one that survives round-tripping through the shell's own line editor. **Rejected alternative:** Enter always literal newline, requires user to close quotes / operators manually — surprises users who never enter multi-line commands.

Follow-on: bracketed paste. Multi-line paste today submits each line as it arrives (destructive if a user pastes a script). We wrap multi-line paste in `\e[200~ … \e[201~` when the shell advertises `xterm-256color` (all our supported shells do) and gate very large multi-line pastes (≥ 5 lines OR ≥ 500 bytes) behind a confirmation modal that shows the payload.

### D2 — Suppress the shell's PS1 by default; be assertive about the vi-mode and highlighter conflicts

The shim (`shax.zsh` / `shax.bash` / `shax.fish`) resets `PROMPT` / `PS1` / `fish_prompt` to a bare OSC 133 A + B marker with no visible glyphs. Starship, p10k, oh-my-zsh themes, and any custom `PROMPT` the user has stop rendering. The user gets Shax's own header row instead — richer, faster, honest.

The shim also actively defuses three things known to fight the strip:

- **vi-mode.** `bindkey -e` in zsh; `set -o emacs` in bash. Fish's default is already single-mode. Users who deliberately want vi keys will lose them until an escape hatch is added.
- **`zsh-syntax-highlighting`.** Unloaded when detected — Shax's own tokenizer (D5) owns coloring, and the two fighting for the same characters produces flicker.
- **`zsh-autosuggestions`.** Left in place — the existing SGR heuristic in `promptRenderer.ts` already handles the ghost text correctly, and the feature is genuinely useful. Revisit only if D5's tokenizer conflicts.

Escape hatch: an `appearance.shell_integration` preference with values `"assertive"` (default) and `"cooperative"`. Cooperative disables every override in the previous paragraph and logs a one-line warning to the console when a known conflict is detected. Ships in M12.2 so the switch exists from day one.

**Spec impact:** this violates the letter of `03-blocks-and-osc133.md` §"Shell integration scripts" — "must not clobber a user's existing hooks (chain, do not overwrite)." I'll edit `03` in the same spec PR to carve out these three specific overrides as intentional, gated behind `appearance.shell_integration`. Chaining stays the default for `precmd` / `preexec` / `PROMPT_COMMAND`, the OSC 133 emission itself is still non-destructive, and the ZDOTDIR tempdir plumbing is unchanged. **Rejected alternative:** cooperative-only ("warn, don't act") — leaves the CPU-cost complaint unaddressed and every new install lands on a prompt that either flickers (with `zsh-syntax-highlighting`) or eats keystrokes (with vi-mode). Doing nothing is the wrong default for a terminal that owns the visible prompt.

### D3 — Mode pill goes three-way; names are `COMMAND` / `CHAT` / `BLOCK`

The statusline pill (`Statusline.tsx:19`, driven from `App.tsx:1209`) grows to a three-state indicator:

- **`COMMAND`** — the prompt strip owns focus. This is the resting state of any pane the user is typing into.
- **`CHAT`** — the assistant input owns focus. Replaces today's `INSERT` trigger.
- **`BLOCK`** — block-focus mode is engaged in the active pane (per-pane boolean at `TerminalPane.tsx:293`, entered by Ctrl+J / clicking a block, exited by Esc / clicking outside).

The pill reflects the focused surface, not a vim editor mode. `COMMAND` is not "vim normal mode + press `i` to edit" — it just names the surface the keys are going to.

Modal overlays (search, palette, viewer, safety gate, settings, confirm-close) do not change the pill; they own the keyboard but the pill continues to reflect what will regain focus when they close. The viewer's own CM-vim NORMAL / INSERT / VISUAL pill in its footer is unchanged and remains a separate concept scoped to the viewer.

**Rejected alternatives:** (a) keep the two-way pill and hide block-focus in a separate indicator — loses the "one indicator, honest at a glance" property. (b) go full vim (`NORMAL` / `INSERT` / `VISUAL` at the terminal level, with real modal editing bindings) — a massive scope creep and hostile to the emacs-keys population that's the dominant terminal default.

### D4 — v1 supports zsh and bash; fish out of scope

The shell-integration overrides in D2 are shell-specific. zsh (`add-zsh-hook`, `bindkey -e`, `PROMPT`) and bash (`PROMPT_COMMAND`, `set -o emacs`, `PS1`) share enough shape to ship together. Fish uses different event hooks (`fish_prompt` function, `fish_key_bindings` variable, no `zsh-syntax-highlighting` analog) and is used by a smaller slice of the daily-driver population. Fish keeps today's OSC 133 support unchanged — no PS1 suppression, no vi-mode override, no highlighter unload. A fish user still gets the M12.1 focus/mode fixes, the M12.3 multi-line editing, the M12.4 header row, and the M12.5 tokenizer (all frontend-only), but the M12.2 shell-integration hardening skips fish entirely. Revisit only if a fish user reports a real problem.

### D5 — Client-side syntax highlighting; simplified POSIX tokenizer, not a full grammar

We tokenize the current line in-strip and color runs by role: command / subcommand / flag / operator (`|` `>` `<` `&` `;` `&&` `||`) / string (single, double, backtick) / variable (`$foo`, `${foo}`) / comment. Colors come from theme tokens (`--syntax-command`, `--syntax-flag`, `--syntax-string`, etc., new tokens added under `--syntax-*` alongside the existing `--fg`, `--fg-dim`, `--fg-faint`, `--accent`).

The tokenizer is hand-rolled (~200 LOC), POSIX-shell-flavored, and shell-agnostic in v1 — it does not try to distinguish zsh globs from bash globs, does not evaluate command substitution, and does not verify that `git` is a real binary before painting it as a command. It runs on every keystroke against the mirror renderer's row text; tokenization is O(line length) and the current input is bounded, so the cost is trivial. Errors in the tokenizer fall back silently to monochrome — the fidelity contract in CLAUDE.md §"non-negotiable" applies here too.

**Rejected alternatives:** (a) adopt CodeMirror's bash grammar — pulls a much larger dependency for a single-line editor; the mirror renderer already isn't CM. (b) full grammar with argv-aware coloring (e.g. `git commit -m "…"` colors `-m` as a git-specific flag) — deferred; a POSIX-shell tokenizer is 90% of the visual win at 20% of the cost.

## Slices

Five slices. None gates the next; ship in the order below or reorder if priorities shift.

### M12.1 — Focus-on-click and mode pill three-way

**Scope:** the smallest, purely-frontend slice; ships the mode rework and the click-to-focus fix together because they share the pane-root click handler.

- Extend `StatuslineMode` to `"COMMAND" | "CHAT" | "BLOCK"` (Statusline.tsx:19). Update the pill's inline styles for a third state (color per theme token).
- `App.tsx:1209` computes `mode` from three inputs: `assistantInputFocused` (CHAT) > `activePaneInBlockFocus` (BLOCK) > default (COMMAND). Precedence in that order — CHAT wins when both assistant and block-focus are somehow engaged.
- Publish a `shax:block-focus-changed` window event from `TerminalPane.tsx` on block-focus enter/exit for the active pane; App consumes it.
- Pane-root mousedown (`TerminalPane.tsx:811-846`) — after the existing block-focus intent handling, if the click landed outside a block AND outside the prompt strip AND outside the meta chrome (measure by `data-testid`), call `promptStripRef.current?.focus()`. The empty-state hero (`BlockList.tsx:304-338`) is in this region.
- The three onboarding chips in the empty-state hero become real buttons: `⌘F` dispatches the existing search shortcut, `⌘K` dispatches the assistant toggle, `⌘,` dispatches settings-open. All three route through the same window events the keybindings already fire — no new command paths.

**Exit:** clicking anywhere in the pane background focuses the prompt; the pill reads COMMAND at rest, CHAT while typing to Claude, BLOCK while navigating blocks with Ctrl+J; the three chips are clickable and land on the same behavior as the keystrokes.

### M12.2 — Shell integration hardening

**Scope:** the most consequential shell-side change; ships the D2 overrides and the `appearance.shell_integration` preference in one slice so the escape hatch exists from day one.

- Preferences model gains `appearance.shell_integration: "assertive" | "cooperative"` (default `"assertive"`). Add to `src-tauri/src/preferences.rs`, migrate silently for existing installs (missing field → assertive).
- Shims emit an environment variable (`SHAX_SHELL_INTEGRATION_MODE=assertive|cooperative`) from `pty/mod.rs::build_shell_command` based on the preference.
- `shax.zsh`: in assertive mode, at the end of the shim, run `bindkey -e`, `unfunction _zsh_highlight 2>/dev/null` (if `zsh-syntax-highlighting` is loaded), and reset `PROMPT` to a bare A+B marker (preserving the existing right-side prompt if the user has one — right-side is not the OSC 133 stream carrier). In cooperative mode, do nothing beyond today's chaining but emit a `printf` warning to stderr on first prompt if any of the three conflicts is detected.
- `shax.bash`: in assertive mode, `set -o emacs`, `PS1='\e]133;A\a\e]133;B\a'` (bare markers), and skip any user-defined `PROMPT_COMMAND` entries that rebuild PS1 by wrapping them so their output is discarded (harder — deferred to a follow-up if the naive approach breaks common configs). In cooperative mode, same warning behavior as zsh.
- `shax.fish`: unchanged entirely (per D4 — fish is out of scope for the shell-integration hardening).
- Preferences pane gains a Shell Integration section under Appearance: radio between `Assertive` and `Cooperative`, one-paragraph explanation of what each does.

**Exit:** the default install lands on a bare Shax-owned prompt with no starship / p10k paint; typing on a shell configured for `bindkey -v` behaves like emacs; `zsh-syntax-highlighting` doesn't compete for characters with the strip. Flipping the preference to Cooperative restores today's chained behavior. The user's shell rc is never edited.

### M12.3 — Multi-line prompt input

**Scope:** extend the mirror renderer and the strip DOM to N rows; add the Shift+Enter binding; add paste safety with a confirmation modal; make sure multi-line commands survive OSC transport and render as multi-line in the block header.

- `promptRenderer.ts` grows from a single-row model to a `rows: PromptRow[]` model. Cursor position becomes `(cursorRow, cursorCol)`. Per-cell `styled` + `selected` tracking survives per-row. LF advances the cursor to the next existing row OR appends a fresh empty row if the cursor was already on the last row — the shell's multi-line redraws (which move up + rewrite in place) land in the existing row stack instead of accumulating stale rows.
- The renderer gains `CSI A` (cursor up N), `CSI B` (cursor down N), and `CSI J` (erase in display: 0 = cursor-to-end, 1 = start-to-cursor, 2 = whole buffer, 3 ignored). These are the minimum needed for a shell's bracketed-paste redraw dance to land in-place. Everything else that would require terminal-grid semantics (arbitrary CUP row, scroll, alt-screen) stays out of scope — the strip mirrors what the shell echoes; anything the mirror can't cleanly represent falls through as a no-op.
- `PromptStrip.tsx` renders as a flex column of rows. Row 0 carries the chrome (cwd, branch, `❯`); continuation rows reserve the chrome column via `visibility: hidden` so the input aligns automatically regardless of cwd length. The cursor bar renders only on the row containing `cursorRow`. The placeholder appears only on row 0 and only when no row has text.
- `keyToBytes.ts` gains a Shift+Enter mapping to `\` + LF. Every POSIX shell treats that as line-continuation and drops to PS2 without submitting. Plain Enter continues to send CR (submits). Ctrl+Enter is deliberately unchanged so it keeps its bare-Enter semantics.
- Paste handler:
  - Always wraps in bracketed-paste markers (`\e[200~ … \e[201~`). Every shell we support (zsh, bash 4.4+, fish) has bracketed paste enabled by default; the wrappers tell the shell "these bytes are a paste" so its line editor **inserts** the payload into the buffer as multi-line text instead of treating embedded LFs as command boundaries. That's the safety layer.
  - If the paste is ≥ 5 lines OR ≥ 500 bytes, open a new `ConfirmPasteModal` (register in the modal layer, dismissable with Esc). The modal shows the payload preview, line + byte counts, and Cancel / Paste buttons. **No toggle** — an earlier draft had a "Paste as one command" toggle that `\`-prefixed embedded LFs to fold the payload into one backslash-continued command. That was based on a wrong mental model of `\<LF>` semantics (POSIX collapses the newline to nothing rather than preserving it), so pasted scripts came out as `echo oneecho twoecho three…` with words concatenated. Deleted in favour of the shell's own bracketed-paste behaviour.
  - On modal close (Cancel or Paste), the strip dispatches `shax:refocus-pane` so focus returns to the prompt without a click. Otherwise the user's next Enter lands on `<body>` and nothing happens.
- **OSC 133;C transport is now `cmd=<base64>`.** The `vte` OSC-string state machine silently drops C0 control bytes (0x00-0x06, 0x08-0x17, 0x19, 0x1C-0x1F) inside OSC strings — LF is 0x0A, right in that range. A raw multi-line command emitted as `OSC 133;C;<raw>` would therefore arrive at the backend with its newlines eaten, and a `echo "hello\nworld"` block header would show `echo "helloworld"` (tokens fused, no separator). Fix: all three shims (zsh, bash, fish) now base64-encode the command in a `cmd=<b64>` param — the same encoding already used for `cwd=` and `branch=` on OSC 133 A and D, for the same reason. The backend parser decodes the new form and falls back to the legacy bare-param form for third-party OSC 133 emitters or a corrupted stream.
- **`BlockRow` header renders multi-line commands as multi-line.** Extracted the command render into a `CommandText` component; switched `white-space: nowrap` + `text-overflow: ellipsis` to `white-space: pre-wrap` + `word-break: break-word` so embedded LFs render as newlines and long single-line commands wrap instead of overflowing. Header's `align-items` flipped from `center` to `flex-start` so the spinner / status / duration / actions cluster stays top-anchored when the command grows tall. Commands with more than 8 lines collapse to a first-6-lines view with a `▶ N more lines` toggle; the toggle's click stops propagation so it doesn't also flip the block-header open.

**Exit:** typing `echo "hello` and pressing Enter drops to PS2 with the second row visible in the strip; typing `echo hello` and pressing Shift+Enter puts a visible newline in the strip and drops to PS2; pasting a 6-line snippet opens the confirmation modal, and after Paste the strip shows the payload as a multi-line buffer that executes as separate commands when the user presses Enter; the resulting block header shows the command as multi-line with LFs preserved; large multi-line commands collapse with a toggle-to-expand affordance; no folding, no repetition on redraw, no click-to-refocus after the paste modal.

### M12.4 — Chrome reshape: statusbar and prompt

**Scope:** reshape the chrome hierarchy across the whole window so each surface has a coherent job. **Statusbar = global, invariant across panes. Prompt = pane-specific, moves with the active shell.** No preference toggles; opinionated v1 (same reasoning as `M10.5` on derived ratios).

Today's problem: cwd and branch appear in both the statusbar and the prompt strip. `⌘K Ask Shax` and the `shax •` brand dot in the statusbar duplicate the top-bar affordances (M7.5a / M7.6). `utf-8` is a placeholder with no honest source. The mode pill loses meaning when the prompt is hidden (alt-screen). All of this gets fixed together — the reshape is coupled, splitting into two PRs would land half a design.

#### Statusbar (new shape)

Left cluster (mode indicator):

- Resting state: `[COMMAND]` / `[CHAT]` / `[BLOCK]` — three-way pill from M12.1, unchanged.
- Alt-screen state: `[INTERACTIVE][~/dev/shax]` — two chips. INTERACTIVE takes a distinct cyan tone so it reads as a special state (not amber, which BLOCK already claims). The cwd chip replaces the per-pane context the user lost when the prompt strip got hidden — vim / htop / less users still see where they are. Continues to reflect the active pane's cwd.

Right cluster (global identity + status), in reading order left-to-right:

- `me@laptop` — session identity, computed once at shim source time from `whoami` + `hostname -s`, muted tone.
- `13:37:02` — live clock ticking once per second via a **single** App-level `setInterval` (per-pane interval × pane count is the wrong scaling). Today's date on hover tooltip. Muted tone.
- Chips that already existed and stay: `⚠ N approvals pending` (amber, when count > 0), `+ assistant active` (when the dock is open).

Removed from the statusbar (each with reason):

- `⎇ branch` — per-pane; the prompt owns pane-specific context.
- `cwd` — per-pane; only surfaces in the statusbar during INTERACTIVE (see above).
- `utf-8` — placeholder with no honest source.
- `⌘K Ask Shax` hint — the top-bar assistant affordance already carries this (M7.6).
- `shax •` brand dot — the tab strip already has our icon (M7.5a).

#### Prompt strip (row 0 chrome, new shape)

`~/dev/shax  ⎇ main ↑2 ↓0  <lang-icon> rust  ❯ <input>`

- `cwd` (compact, `~/…` prefix — existing) — always shown.
- `⎇ branch` (existing) — shown when the shim reports one.
- `↑N ↓M` (new) — git ahead/behind vs upstream, muted tone, only rendered when at least one is non-zero. Backend receives via `ahead=N;behind=M` on OSC 133 A.
- `<lang-icon> label` (new) — detected primary language for the cwd, only rendered when detection succeeded. Backend receives via `lang=<label>` on OSC 133 A; frontend maps to Nerd Font DevIcons codepoint + display label.

Continuation rows (M12.3): unchanged — align to the input column via `visibility: hidden` on the chrome column.

#### Language detection (in-shim, cached per-cwd)

The shim runs one `stat` pass per candidate file when the cwd changes (precmd on cd, first prompt) and emits the winning label. Never scans directory contents; never parses project files. Ranked most-specific-first:

| File signature | Label |
|---|---|
| `Cargo.toml` | rust |
| `Package.swift` OR `*.xcodeproj/` OR `*.xcworkspace/` | swift |
| `deno.json` / `deno.jsonc` | deno |
| `tsconfig.json` | typescript |
| `package.json` (fallback when no `tsconfig.json`) | node |
| `pyproject.toml` / `requirements.txt` / `setup.py` | python |
| `go.mod` | go |
| `Gemfile` | ruby |
| `build.gradle.kts` / `settings.gradle.kts` | kotlin |
| `pom.xml` / `build.gradle` | java |
| `*.csproj` OR `global.json` | c# |
| `CMakeLists.txt` / `meson.build` / `configure.ac` | c/c++ |

First hit wins. Bounded to a ~100ms budget total per detection; on timeout (slow network mounts) the shim omits the `lang=` param and the frontend silently renders no icon. C vs C++ not distinguished — one shared `c/c++` chip; distinguishing them requires parsing `CMakeLists.txt`'s `LANGUAGES` clause or scanning file extensions, both disproportionate for the value.

Framework detection (React vs Vue, virtualenv presence, kubectl context, etc.) and runtime versions (`node -v`) are explicit follow-up territory — different mechanism (parsing project files, running probes), different failure surface.

#### Icons: Nerd Font, never emoji

All chrome glyphs (language, battery, plug, ahead/behind arrows, mode-pill icons) are Nerd Font codepoints — DevIcons for languages, Font Awesome for battery/plug. Reasons: monochrome (inherit `currentColor` from theme tokens), consistent width in the mono grid, consistent rendering across macOS / Windows / Linux (bundled fonts ship via `@font-face`), size with `--font-size-terminal` naturally. Emoji fail on all four axes.

Fallback stack for icon spans: `"JetBrainsMono Nerd Font", var(--font-mono), monospace` — Nerd Font tried first for the glyph even when the user's preferred font family lacks the icons.

#### Shim additions

Every OSC 133 A payload now carries these extra params (base64-encoded, same as `cwd=` and `branch=`):

- `ahead=<N>` `behind=<N>` — computed via `git rev-list --left-right --count HEAD...@{u} 2>/dev/null` when in a repo with an upstream. Both zero → params omitted.
- `lang=<label>` — from the file-signature check above.
- `user=<b64>` `host=<b64>` — computed once at shim source time from `whoami` and `hostname -s`, cached in shell variables, included on every A. Simpler than a separate one-shot event.

Backend `parse_kv_params` grows to recognize the five new keys; `VtEvent::PromptStart` and `PtyEvent::PromptReady` gain the fields; frontend `PromptReady` TS type mirrors.

**Exit:** the statusbar shows `[COMMAND]` on the left and `me@laptop · 13:37:02` on the right (plus any of the existing chips). During alt-screen it shows `[INTERACTIVE][~/dev/shax]` on the left. The prompt strip's row 0 shows `~/dev/shax ⎇ main ↑2 <lang-icon> rust ❯` when in a Rust repo two commits ahead of upstream. Time advances live via a single App-level interval. No cwd / branch duplication anywhere.

### M12.4b — Native status probes (battery + local IP)

Follow-up slice for the two statusbar additions that need Tauri commands and per-platform native code, held out of M12.4 so the chrome reshape ships fast.

**Scope:** two more chips on the statusbar right cluster:

- **Battery**: `<battery-icon> 87%` on battery, `<plug> 87%` when charging, `<plug>` alone on desktop machines (no battery). Amber when < 20% and discharging. Same "plug glyph = on wall power" rule across laptop-plugged-in and desktop states — cleanest cross-population rule. Refresh every 30s (battery doesn't change per second).
- **Local IP**: `192.168.1.42` — the IP of the interface carrying the default route. Refresh on network-change event (SCNetworkReachability on macOS, netlink on Linux, WMI on Windows); 30s poll fallback if event subscription fails. Multi-homed systems (VPN + wifi + ethernet) pick the default-route interface — users who want to see all interfaces have `ifconfig`.

**New Tauri commands** (per-platform impl in `src-tauri/src/status.rs`):

- `system_battery() -> BatteryStatus { present: bool, percent: Option<u8>, charging: bool }`
- `system_local_ip() -> Option<String>`

**Icons** (Nerd Font, per M12.4 rules):

- `` … `` — nf-fa-battery_full … battery_empty
- `` — nf-fa-bolt (charging)
- `` — nf-fa-plug

**Exit:** the statusbar shows the battery + local-IP chips populated with real data on all three platforms; they refresh on the documented cadences; desktops render the plug-alone glyph without any percentage.

### M12.5 — Client-side syntax highlighting

**Scope:** ship the tokenizer from D5 and wire it to the mirror renderer.

- New file `src/panes/promptSyntax.ts`. Exports `tokenize(line: string): Token[]` where `Token = { start, end, kind: "command" | "subcommand" | "flag" | "operator" | "string" | "variable" | "comment" | "text" }`. Hand-rolled state machine, no lookahead beyond one character, safe against unbalanced quotes (falls back to `"text"` from the offending character onward).
- New theme tokens `--syntax-command`, `--syntax-flag`, `--syntax-string`, `--syntax-variable`, `--syntax-operator`, `--syntax-comment` added under `src/theme/tokens.css` with values in the Shax Dark / Shax Light presets, and mirrored in every catalog preset (`src/theme/presets/*.json`). Colors chosen for AA contrast against `--pane`.
- `PromptStrip.tsx` renders the input row as a series of `<span style="color: ...">` runs derived from the tokenizer output, overlaying (rather than replacing) the mirror renderer's style bits. Precedence: if the shell painted a run as "styled" (autosuggestion ghost), that wins — dim always beats color, otherwise the ghost text becomes invisible against the input.
- Fall-back: any thrown error inside the tokenizer / span-rendering path drops to today's monochrome view. Fidelity contract — a highlight bug never breaks input.

**Exit:** typing `git commit -m "hello"` colors `git` as command, `commit` as subcommand, `-m` as flag, `"hello"` as string; typing `echo $HOME | grep foo` colors `$HOME` as variable, `|` as operator; unbalanced quote (`echo "hi`) doesn't corrupt the line — the string just runs to end-of-line in string color.

## Non-goals (explicit, not deferred)

- **A local line editor.** M12 keeps the mirror-the-shell model. Building our own readline replacement — with history, completion, kill-ring, incremental search — is a multi-milestone rewrite with heavy compatibility risk. Rejected as a category, not delayed. If the shell's line editor ever becomes the blocker, the conversation is separate.
- **Full shell-grammar tokenization.** D5's simplified tokenizer stays simple; no argv-aware / man-page-aware coloring in v1 or v2.
- **Ligature / font-size / theme changes to the prompt.** Those live in M10's tokens and stay unchanged.
- **Prompt on remote shells (SSH sessions, `docker exec`, nested subshells).** Once the user's typing goes into a shell Shax didn't spawn, that shell paints its own PS1 and we have no OSC 133 there. The prompt strip mirrors whatever bytes come back; the header row keeps showing the local shell's context. Cross-context prompt fidelity is out of scope.
- **Editing the user's dotfiles.** Same rule as today. Everything happens in the ZDOTDIR tempdir shim.

## Testing

Every slice writes tests alongside per CLAUDE.md §"Testing policy".

- **M12.1** — `Statusline.test.tsx` gains cases for all three pill states; new `App.test.tsx` case for the precedence rule; existing pane-root-click test in `TerminalPane.test.tsx` gains a case for empty-region → prompt focus.
- **M12.2** — Rust unit test in `pty/mod.rs::tests` for the shim env-var branching by preference. Shell scripts are covered by a small `shax.zsh` sourceable test file that asserts `bindkey -e` is active and `PROMPT` is bare after sourcing in assertive mode (invoked via `zsh -c 'source shax.zsh && …'` in a CI shell test).
- **M12.3** — `promptRenderer.test.ts` gains multi-row cases (`\n` appends, cursor advances across rows, kill-to-end doesn't cross rows); new `ConfirmPasteModal.test.tsx`; `keyToBytes.test.ts` gains the Shift+Enter case.
- **M12.4** — `PromptStrip.test.tsx` renders the header with mocked cwd / branch / user / host / clock; the App-level clock tick has a fake-timer test.
- **M12.5** — `promptSyntax.test.ts` covers each token kind, unbalanced quote, empty line, `#` comment; `PromptStrip.test.tsx` gains a render-spans-with-colors case and a tokenizer-throws-→-monochrome fallback case.

Playwright end-to-end: one flow per slice under `tests/e2e/prompt-overhaul.spec.ts`, all added in M12.5 as a final integration pass.

## Cross-cutting concerns

- **Honest log (`CLAUDE.md` non-negotiable #3).** Everything the user types in the strip still becomes a visible command that goes to a real PTY and gets captured as a real block. The custom header adds *context* around that (identity, time), not *actions*. No hidden side effects.
- **Fidelity contract (`CLAUDE.md` non-negotiable #2).** The mirror renderer is still the source of truth for what the shell echoed. Multi-line, tokenizer coloring, and header enrichment are lenses over that ground truth; if the mirror shows a byte the tokenizer disagrees with, the mirror wins.
- **Never hijack input-owning programs (`CLAUDE.md` non-negotiable #4).** All M12 work is scoped to the resting prompt state (`no alt-screen active`). vim / less / top / REPLs continue to render into the xterm grid untouched.
- **Safety gate (`CLAUDE.md` non-negotiable #5).** Nothing here goes around the safety gate. Palette-emitted commands, assistant-suggested commands, and the paste modal all still route through `shax:emit-command` → `shax:emit-command-approved`.
- **Local-first (`CLAUDE.md` non-negotiable #6).** No network, no telemetry. Time comes from `Date.now()`, user comes from `whoami`, hostname from `hostname -s`. All local.

## Roadmap slot

Insert as M12 in `12-roadmap-milestones.md`, immediately after the M11 section. Post-M8 candidates "Community theme drop-in" and "Sidebar with pinnable widgets" remain in that list, unchanged.
