# 19 Sidebar with pinnable widgets — Phase 1

## Goal

Shax grows a new persistent surface: a collapsible **sidebar** on the left of every window that hosts always-on utility widgets. Phase 1 ships five built-in widgets — clock, CPU/memory, network, git branch of the active pane, and caffeinate — plus the sidebar chrome, the collapse-to-icon-rail behaviour, and the focus rules that keep it out of the way of the terminal. This is the first UI axis added since the assistant dock (M7.7a); the two now frame the pane grid — dock on the right, sidebar on the left, statusbar full-width across the bottom.

Phase 1 deliberately ships no runtime, no schema, no sandbox. The widgets are Shax-authored React components living in-repo, wired to native probes we already own (`starship-battery`, `local-ip-address`) plus `sysinfo` for CPU/memory and per-OS SSID probes for the network chip. Phase 2 (deferred, tracked in `12-roadmap-milestones.md` Post-M8 candidates) grows a Web Worker + declarative-schema pattern for community widgets on top of the same visual surface Phase 1 establishes.

## Motivation

Five separate feedbacks converge on the same missing surface:

1. **The statusbar is out of room.** M12.4b added battery and local-IP to the right cluster; the next glanceable signal (CPU% during a build, "did my caffeinate expire?") has nowhere to live without pushing something else out.
2. **Users lose long-running things.** A `caffeinate -di` typed once is invisible after the block scrolls off; users forget it's running, or run a second one on top. A visible toggle turns a per-shell command into a per-window setting.
3. **"Where am I?" belongs to the whole pane, not the header row.** The M12.4 prompt header shows cwd + branch, but only for the pane in view. On a multi-pane window the branch chip in a persistent surface reads as "state," not "prompt echo."
4. **CPU/memory during a build is a real question.** Users switch to Activity Monitor / htop to check if a build is CPU-bound or waiting on IO. A widget in-terminal answers that without an alt-tab.
5. **Discoverability of always-on features.** Weather, kubectl context, caffeinate — these are the kind of "little app in the corner" widgets that make a terminal feel like a workspace, not a shell. The sidebar is the surface that unlocks them; Phase 2 opens it up to the community.

This is a product-shape milestone, not a bug fix: it commits to a new visual axis of the app.

## Locked decisions

Every decision below is my recommendation, called out so you can push back before we sink cost. Change them here in the spec, not later in code.

### D1 — Left column, fixed 280px expanded / 44px icon-rail collapsed

The sidebar is a first-class column that lives left of the pane grid and right of the window edge, above the full-width statusbar. Two states only:

- **Expanded (280px)** — widgets render their full content: clock with date, CPU/memory bars, network chip with SSID + IP + up/down, git-branch row, caffeinate toggle with duration.
- **Collapsed (44px icon rail)** — one glyph per widget stacked vertically; hovering a glyph shows the widget's compact one-line content in a tooltip. Clicking a glyph expands the sidebar and does not otherwise interact with the widget (the click-target is "expand," not "toggle caffeinate").

Fixed widths, no drag-to-resize. **Rejected alternative:** matching the assistant dock's drag-to-resize divider. The dock hosts variable-width content (chat markdown, tool call cards) that benefits from user width control; Phase 1 sidebar widgets are fixed-shape and gain nothing from a resize handle beyond one more hit-target competing with pane splits. Revisit only if Phase 2 grows widgets with genuinely variable content width.

### D2 — Toggle: `⌘B`, default state icon rail visible on first run

`⌘B` swaps between expanded and collapsed. Also togglable from a new palette command **"Sidebar: expand / collapse"** and from an entry in the View menu (M9-window menu). The keybinding is the VS Code / Xcode / Finder default for a sidebar toggle; a grep of current keybinds shows `⌘B` free.

First-run default: **icon rail visible (collapsed)**. New users see the sidebar exists without losing 280px of pane width up-front. Users who explicitly collapse or expand persist that per-window in the existing `Windows` preferences slot.

Nothing hides the sidebar entirely. The rationale: a zero-cost 44px rail is worth the discoverability. If a user genuinely wants the space back for a wide `htop`, block-focus mode (Ctrl+J) already covers the "hide chrome" use case for that pane.

**Rejected alternatives:** (a) chord like `⌥⇧B` — no precedent, harder to hit. (b) allow a third "fully hidden" state — three states of a binary preference means preference-serialisation drift and unclear defaults, for a use case (`⌘⌥` block-focus already handles) that doesn't merit it.

### D3 — Per-window scope; each window persists its own sidebar state

Every Shax window has its own sidebar with its own expand/collapse state and its own caffeinate toggle state. Widget content that depends on window context (git branch of the active pane, focused pane's SSID) resolves within that window. Widgets that are host-global (clock, CPU/memory, network default-route IP, host SSID) show the same value across windows but each widget instance owns its own render.

Persistence goes through the existing per-window preferences slot added in M9.1. New shape:

```rust
pub struct SidebarPreferences {
    pub visible: bool,          // false = icon rail, true = expanded
    pub caffeinate_on: bool,    // survives window close, so a still-running caffeinate reflects state on reopen
}
```

**Rejected alternative:** a single global sidebar shared across all windows (only the focused window renders it). Sounds tidier for the "one true clock" fantasy but forces a special-case in a layout system that is otherwise strictly per-window, and misfires on the caffeinate use case (caffeinate is per-shell-process; showing "on" globally when only one window's caffeinate is actually running would lie).

### D4 — Focus stays with the pane; sidebar clicks are click-to-interact only

The sidebar never steals keyboard focus. Clicking a widget fires that widget's action (toggle caffeinate, expand the sidebar from the rail) without moving the DOM focus off the prompt strip / block list. Esc has no sidebar-specific behaviour; it continues to do what it already does in the focused pane.

Phase 1 widgets have no text input surfaces. If Phase 2 grows a widget with a text field (e.g. a stopwatch label, a kubectl-context filter), that widget will need to opt into the focus-return dance — but Phase 1 dodges the whole question.

**Rejected alternative:** conventional app-shell behaviour where clicking the sidebar focuses it and a Tab / Esc returns focus. Breaks the daily-driver non-negotiable ("the terminal is the primary surface") and forces every widget interaction to cost two keys.

### D5 — Five widgets in Phase 1, order pinned

Top-to-bottom, both states:

1. **Clock** — `HH:MM` + weekday + date. Ticks from the same App-level 1s interval that already drives the M12.4 prompt header clock, no new tick.
2. **CPU / Memory** — one row each with a numeric % + a slim bar. Uses `sysinfo` v0.32 (cross-platform, actively maintained, one crate for both signals). Refresh cadence 2s: fast enough to feel live during a build, slow enough that the polling itself doesn't heat the machine. **Deferred out of scope:** per-core breakdown, top-N processes, swap.
3. **Network** — SSID + default-route IP + up/down dot. Local IP reuses the M12.4b `system_local_ip()` command. SSID needs a new `system_ssid()` probe: Linux `iwgetid -r`, Windows `netsh wlan show interfaces`, macOS returns `None` unconditionally. Up/down is presence-of-default-route (already computable from the local-IP probe returning `Some`), no ping — a widget that pings on a poll would be a network chatter source in a "local-first, no telemetry" product. Refresh cadence 30s, matching battery and local-IP.

   **macOS SSID unavailable — deliberate.** The earlier draft of this spec assumed `/System/Library/PrivateFrameworks/Apple80211.framework/Versions/A/Resources/airport -I` would still exist. Apple removed the `airport` binary in macOS 14, and every remaining API path (CoreWLAN, `system_profiler SPAirPortDataType`, `networksetup -getairportnetwork`) returns `<redacted>` unless the app holds the CoreLocation entitlement — which triggers an alarming "Shax wants your location" runtime prompt on first launch. Apple's stance is that SSID is location-adjacent data; Shax respects it rather than asking users to opt in to a location prompt for a chip label. The Network widget hides the SSID line on macOS and renders `📡 Wired · 192.168.1.42` with the up/down dot instead. Linux/Windows still show SSID normally.
4. **Git branch (active pane)** — branch + ahead/behind of the focused pane's cwd. **No new native probe:** the M12.4 prompt-header machinery already knows the focused pane's branch. This widget subscribes to the same signal via a new context slot; it updates on pane focus change and on the pane's next OSC 133 A, never polls. Falls back to hidden when no pane is focused or the focused pane's cwd isn't a git repo.
5. **Caffeinate** — a toggle button. Off state: outline chip with a coffee-cup glyph. On state: filled chip + relative timer ("2m 14s"). Click emits the real command into the focused pane's scrollback per the honest-log non-negotiable — see D6.

Widget order is fixed for Phase 1. Drag-to-reorder is Phase 2 territory (the community-widget schema needs it more than the built-in set does — five widgets rearrange in five seconds via a preferences file if a user really cares).

### D6 — Caffeinate emits a real command into the focused pane, per the honest-log non-negotiable

Clicking the caffeinate widget "on" runs the real OS command in the focused pane's shell, exactly as the user typed it:

- **macOS** — `caffeinate -di`
- **Linux** — `systemd-inhibit --what=idle sleep infinity`
- **Windows** — the widget shows a compact "not available on this platform" state in Phase 1 and the click target does nothing. See "deferred" below.

The command is routed via `shax:emit-command` → the safety gate → `shax:emit-command-approved` → the PTY, identical to how the palette emits commands. That means:

- The command shows up in scrollback as a real block with a real PID.
- The user can `Ctrl+C` it from the pane the same way they'd stop a manual `caffeinate`.
- The widget's "on" state is derived by watching the block's completion signal — when the caffeinate block completes (user Ctrl+C'd it, or shell exited), the widget flips back to "off." No hidden lifecycle.
- If no pane is focused when the widget is clicked, the widget refuses (subtle shake) and prompts to focus a pane — because "which shell owns this caffeinate?" has no other honest answer.

**Deferred: Windows caffeinate.** No first-class shell command exists on Windows. Options are all bad in Phase 1:
- `powercfg /requests` is read-only.
- Third-party `caffeine.exe` is neither bundled nor guaranteed installed.
- A PowerShell one-liner calling Win32 `SetThreadExecutionState` runs in a shell but the block "completes" the moment the script exits, breaking the on/off derivation from block state.
- A Rust-side FFI call to `SetThreadExecutionState` works but violates the honest-log non-negotiable (invisible side effect).

Windows caffeinate lands in a follow-up once the honest-shell-command story is figured out. Options tracked in a Phase 1.5 spec note; not part of this milestone.

**Rejected alternative:** click the widget → the app runs the command "internally" via a Tauri command, no scrollback echo. Rejected because it violates the honest-log principle (#3). Users find their long-running commands by scrolling; a caffeinate that runs invisibly is exactly the class of hidden state the non-negotiable exists to prevent.

## Slices

Four sub-PRs, sized so each is reviewable in one sitting and shippable on its own.

### M13.1 — Sidebar chrome + `⌘B` toggle + focus rules

Scope: everything except the widgets. Establishes the visual axis, the state machine, the persistence path, and the focus contract that Phase 1's remaining slices and Phase 2 both depend on.

- New component `src/sidebar/Sidebar.tsx`. Two-state layout (280px / 44px), collapse animation (150ms width transition, no fade — snappy), placeholder widget slot area that just renders "no widgets yet."
- New keybinding `⌘B` in the App-level keydown handler. Toggles the current window's `sidebar_visible` preference; the change flows back through the standard preferences roundtrip so both windows and future palette entry see the same source of truth.
- New palette command **"Sidebar: expand / collapse"** (per M8 palette conventions).
- New Rust `SidebarPreferences { visible, caffeinate_on }` on the per-window preferences slot from M9.1. `#[serde(default)]` gates every field for backward compatibility with pre-M13 window state on disk.
- Focus contract: sidebar clicks call `preventDefault()` on `mousedown` (same pattern M12.8b landed for the block list) so DOM focus doesn't leave the prompt strip.

**Exit:** open a fresh window — sidebar shows a 44px icon rail (empty of icons for now). `⌘B` expands it to 280px, `⌘B` again collapses. Focus never leaves the prompt strip when clicking in the sidebar area. Close and reopen the window — sidebar state persists.

### M13.2 — Clock + Git-branch widgets (zero new native deps)

Scope: the two widgets that need no new probes. Ships the widget-render contract that M13.3 and M13.4 then extend.

- New `src/sidebar/widgets/ClockWidget.tsx` — subscribes to the App-level 1s tick already driving the M12.4 header clock. Expanded: HH:MM (large), weekday + date (small). Rail: HH glyph or a compact ⏰ icon; hover tooltip shows the full time.
- New `src/sidebar/widgets/GitBranchWidget.tsx` — subscribes to the focused-pane branch signal from `AssistantDockContext`'s neighbour, or a new `FocusedPaneContext` if that seam is cleaner. Expanded: ⎇ branch + ↑n ↓n. Rail: ⎇ glyph; hover tooltip shows the branch. Hidden when no pane focus / non-repo cwd.
- Wires both into the Sidebar widget slot area from M13.1.

**Exit:** sidebar shows a live clock and, when a repo pane is focused, the pane's branch. Switching focus between panes in different repos updates the branch chip. Both widgets render sensibly in both sidebar states.

### M13.3 — CPU/Memory + Network widgets (new native probes)

Scope: the two widgets that need cross-platform native code. Adds one crate (`sysinfo`) and one per-OS shim (`system_ssid`).

- Two new Tauri commands in the existing `src-tauri/src/status.rs` module (consolidated with the M12.4b `system_battery` / `system_local_ip` probes rather than splitting into per-probe files — same graceful-degradation contract, same refresh-cadence-is-a-frontend-concern pattern, so they belong in one place). Module doc updated from "statusbar chips" to "native probes."
  - `system_cpu_and_mem() -> SystemLoad { cpu_percent: f32, mem_used_bytes: u64, mem_total_bytes: u64 }`. Uses `sysinfo` v0.32 with a `Mutex<Option<System>>` static so CPU deltas are meaningful (sysinfo computes usage from successive `refresh_cpu_usage()` calls; a fresh `System::new()` per probe would always return 0). Feature-gated to `["system"]` to avoid pulling in disk / process / network stats we don't sample. Refresh handler is a 2s `setInterval` in App, same shape as the M12.4b battery poll.
  - `system_ssid() -> Option<String>`. Per-OS `#[cfg]` blocks — Linux `iwgetid -r`, Windows `netsh wlan show interfaces` (parse the `SSID :` line, ignore `BSSID :`), macOS returns `None` unconditionally (see D5 item 3 for why). Any failure at any step collapses to `None` and the widget hides the SSID portion silently.
- New `src/sidebar/widgets/CpuMemWidget.tsx` — two stacked bar-and-percent rows. Rail: a single 📊 glyph; hover tooltip shows both percentages. Consumes `useSystemLoad()` from the new `SystemLoadContext`. Renders `null` when `mem_total_bytes == 0` (pre-probe / non-Tauri dev shell) — the "0.0 GB / 0.0 GB" default state would be a lie.
- New `src/sidebar/widgets/NetworkWidget.tsx` — SSID + IP + up/down dot. IP already available from M12.4b `system_local_ip()`. Rail: 📡 glyph + colored dot; hover tooltip shows SSID + IP. When SSID is null but IP is present, renders `Wired` as the label rather than nothing (covers both wired connections and macOS). Consumes `useNetwork()` from the new `NetworkContext`.

**Exit:** CPU and memory percentages tick every 2s and correlate with `top` / `htop`. Network chip shows the current SSID (Linux/Windows on WiFi) or `Wired` (macOS + wired), the default-route IP, and a green dot (or red when the local-IP probe returns `None`). SSID probe failure hides the SSID line silently, per the M12.4b graceful-degradation pattern.

### M13.4 — Caffeinate widget + honest-log routing

Scope: the one widget that touches the pane's command surface. Isolated in its own slice because the honest-log routing crosses three seams (widget UI, `shax:emit-command` bus, block-state subscription).

- New `src/sidebar/widgets/CaffeinateWidget.tsx`. Expanded: outlined chip labelled "Keep awake" (off) or filled chip with running duration "Keep awake · 2m 14s" (on). Rail: ☕ glyph, outlined or filled by state.
- Click-on: emits `shax:emit-command` with the platform-appropriate command (`caffeinate -di` / `systemd-inhibit --what=idle sleep infinity`), routes through the safety gate + focused-pane resolver, gets a block-id back. Widget stores that block-id in the per-window preferences (so a reload picks up state) and subscribes to that block's lifecycle.
- Click-off (while on): sends `Ctrl+C` to the block via the existing pane input path. Widget flips off when the block reports completion.
- Block completes for any other reason (shell exited, user Ctrl+C from the pane, network hiccup): widget flips off, block-id cleared.
- Windows platform: widget renders a disabled state with a compact "Not available on Windows" tooltip. Click does nothing.
- Refuse-if-no-focused-pane: subtle horizontal shake animation + status-bar note, no state change.

**Exit:** on macOS or Linux, clicking the caffeinate widget On emits the real command into the focused pane's scrollback and the widget shows a live duration. Clicking Off Ctrl+Cs the block; widget flips to off. Ctrl+C-ing the block directly from the pane also flips the widget off. Reopening the window with a still-running caffeinate reflects the on state and continues to count.

## Non-goals (explicit, not deferred)

- **Community widget sandbox.** Phase 2. Everything Phase 1 ships is React-authored in-repo. No Web Worker, no schema, no capability gates. Building the sandbox before we've lived with the built-in set is speculative generality.
- **Drag-to-reorder widgets.** Fixed order for Phase 1. If a user asks in the first month of daily-driving, it lands in a follow-up; the community-widget story in Phase 2 needs it more than the built-in set does.
- **Per-widget preferences panel.** The two widgets that could have preferences (network refresh cadence, CPU alert threshold) don't in v1. Add a preferences pane only when a real ask exists.
- **Windows caffeinate.** See D6. Phase 1.5 follow-up.
- **Weather widget.** Punt to Phase 2 — needs an explicit network capability, which needs the sandbox that Phase 1 doesn't build.
- **kubectl context widget.** Same — needs a `kubectl config current-context` shell-out, which is easy, but this is meaningful only to a subset of users, and Phase 2's community widget path is the right home for niche tooling.
- **Sidebar-hosted terminal / editor / block viewer / anything that hosts a pane.** The sidebar is for widgets, not for panes. If a user wants a persistent htop, that's a pinned tab or a pane in the layout, not a sidebar widget. Same rule the parent design note in `12-roadmap-milestones.md` § "Sidebar with pinnable widgets" already established: no in-Shax app runtime.
- **Third state "sidebar fully hidden."** See D2. Rail is always visible.

## Testing

Every slice writes tests alongside per CLAUDE.md § "Testing policy".

- **M13.1** — `Sidebar.test.tsx` covers both states rendering, `⌘B` toggle via `fireEvent.keyDown`, palette command dispatch, focus-never-leaves-pane on mousedown, per-window preferences round-trip. Rust: `preferences.rs` gains a round-trip test for `SidebarPreferences` and a missing-field-defaults-to-false test.
- **M13.2** — `ClockWidget.test.tsx` with a fake `Date.now()`-injecting harness (there's already one in the M12.4 clock tests). `GitBranchWidget.test.tsx` mocks the focused-pane context to cover: repo pane (shows branch), non-repo pane (hidden), no pane focused (hidden), pane focus swap (branch updates).
- **M13.3** — Rust: `sysinfo.rs` and `ssid.rs` each get a smoke test that the probe returns a non-panicking value on the CI's host OS (probing is inherently host-dependent; assert the shape, not a specific value). Frontend: `CpuMemWidget.test.tsx` renders both bars from a mocked probe value; `NetworkWidget.test.tsx` covers online (green dot), offline (red dot), SSID-missing (chip renders IP only).
- **M13.4** — `CaffeinateWidget.test.tsx` mocks `shax:emit-command` and the block-lifecycle bus, covers: off→on emits the correct per-platform command, on→off sends Ctrl+C, block-completed-externally flips widget off, Windows shows disabled state, no-focused-pane triggers the refuse animation.

Playwright end-to-end: one new file `tests/e2e/sidebar.spec.ts`, one flow — open a window, `⌘B` to expand, run a caffeinate from the widget, verify the block appears in the focused pane's scrollback, click off, verify the block completes. Adds no other e2e paths (the widget-level behaviour is covered by component tests).

## Cross-cutting concerns

- **Honest log (`CLAUDE.md` non-negotiable #3).** D6 is the load-bearing test of this principle for M13. Caffeinate emits a real, visible command; every future widget that "does something" follows the same route through `shax:emit-command`. Any widget PR that introduces a hidden side effect is a defect.
- **Daily-driver first (non-negotiable #1).** The default state is icon rail, not expanded — the sidebar earns its width, doesn't take it by default. Widgets never steal focus. `⌘B` is a single-chord toggle. All of this preserves the "as fast and calm as a great native terminal" feel.
- **Never hijack input-owning programs (non-negotiable #4).** Nothing here touches the alt-screen path. Sidebar is chrome; alt-screen apps still render into the xterm grid untouched. `⌘B` still works during vim / htop / ssh — hitting it just toggles a column of chrome, doesn't send keys anywhere.
- **Safety gate (non-negotiable #5).** Caffeinate's emit path routes through `shax:emit-command-approved` — the same gate palette-emitted and assistant-suggested commands pass through. A widget that emits a destructive command (Phase 2 territory) is subject to the same approval flow.
- **Local-first (non-negotiable #6).** Zero network. `sysinfo` reads `/proc` and equivalent, `airport` / `iwgetid` / `netsh` are local, no ping-based reachability check.
- **Fidelity contract (non-negotiable #2).** Widgets are lenses over real state (OS probes, focused-pane branch, block lifecycle). If a probe fails, the widget hides its affected line — never fabricates. Every widget's failure mode is `None → hidden`, not `None → "N/A"`.

## Roadmap slot

Insert as **M13 Sidebar with pinnable widgets (Phase 1)** in `12-roadmap-milestones.md`, immediately after the M12 section. Remove the current "Sidebar with pinnable widgets" bullet from Post-M8 candidates in the same commit; the Phase 2 (community widget sandbox) content stays in the roadmap file as its own "Post-M13" candidate.
