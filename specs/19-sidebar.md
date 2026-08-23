# 19 Sidebar with pinnable widgets — Phase 1

## Goal

Shax grows a new persistent surface: a collapsible **sidebar** on the left of every window that hosts always-on utility widgets. Phase 1 ships five built-in widgets — clock, CPU/memory, network, git branch of the active pane, and caffeinate — plus the sidebar chrome, the collapse-to-icon-rail behaviour, and the focus rules that keep it out of the way of the terminal. This is the first UI axis added since the assistant dock (M7.7a); the two now frame the pane grid — dock on the right, sidebar on the left, statusbar full-width across the bottom.

Phase 1 deliberately ships no runtime, no schema, no sandbox. The widgets are Shax-authored React components living in-repo, wired to native probes we already own (`starship-battery`, `local-ip-address`) plus `sysinfo` for CPU/memory and per-OS SSID probes for the network chip. Phase 2 (deferred, tracked in `12-roadmap-milestones.md` Post-M8 candidates) grows a Web Worker + declarative-schema pattern for community widgets on top of the same visual surface Phase 1 establishes.

## Motivation

Five separate feedbacks converge on the same missing surface:

1. **The statusbar is out of room.** M12.4b added battery and local-IP to the right cluster; the next glanceable signal (CPU% during a build, "did my caffeinate expire?") has nowhere to live without pushing something else out.
2. **Users lose long-running things.** A `caffeinate -di` typed once is invisible after the block scrolls off; users forget it's running, or run a second one on top — and while it runs it holds the pane hostage. A pinned toggle turns a fire-and-forget command into visible, reversible state.
3. **"Where am I?" belongs to the whole pane, not the header row.** The M12.4 prompt header shows cwd + branch, but only for the pane in view. On a multi-pane window the branch chip in a persistent surface reads as "state," not "prompt echo."
4. **CPU/memory during a build is a real question.** Users switch to Activity Monitor / htop to check if a build is CPU-bound or waiting on IO. A widget in-terminal answers that without an alt-tab.
5. **Discoverability of always-on features.** Weather, kubectl context, caffeinate — these are the kind of "little app in the corner" widgets that make a terminal feel like a workspace, not a shell. The sidebar is the surface that unlocks them; Phase 2 opens it up to the community.

This is a product-shape milestone, not a bug fix: it commits to a new visual axis of the app.

## Locked decisions

Every decision below is my recommendation, called out so you can push back before we sink cost. Change them here in the spec, not later in code.

### D1 — Left column, fixed 280px expanded / 44px icon-rail collapsed

The sidebar is a first-class column that lives left of the pane grid and right of the window edge, above the full-width statusbar. Two states only:

- **Expanded (280px)** — widgets render their full content: clock with date, CPU sparkline + memory donut, the network card for one interface at a time with its pager, git-branch row with working-tree counts, caffeinate toggle with duration.
- **Collapsed (44px icon rail)** — one glyph per widget stacked vertically; hovering a glyph shows the widget's compact one-line content in a tooltip. Clicking a glyph expands the sidebar and does not otherwise interact with the widget (the click-target is "expand," not "toggle caffeinate").

Fixed widths, no drag-to-resize. **Rejected alternative:** matching the assistant dock's drag-to-resize divider. The dock hosts variable-width content (chat markdown, tool call cards) that benefits from user width control; Phase 1 sidebar widgets are fixed-shape and gain nothing from a resize handle beyond one more hit-target competing with pane splits. Revisit only if Phase 2 grows widgets with genuinely variable content width.

### D2 — Toggle: `⌘B`, default state icon rail visible on first run

`⌘B` swaps between expanded and collapsed. Also togglable from a new palette command **"Sidebar: expand / collapse"** and from an entry in the View menu (M9-window menu). The keybinding is the VS Code / Xcode / Finder default for a sidebar toggle; a grep of current keybinds shows `⌘B` free.

First-run default: **icon rail visible (collapsed)**. New users see the sidebar exists without losing 280px of pane width up-front. Users who explicitly collapse or expand persist that per-window in the existing `Windows` preferences slot.

Nothing hides the sidebar entirely. The rationale: a zero-cost 44px rail is worth the discoverability. If a user genuinely wants the space back for a wide `htop`, block-focus mode (Ctrl+J) already covers the "hide chrome" use case for that pane.

**Rejected alternatives:** (a) chord like `⌥⇧B` — no precedent, harder to hit. (b) allow a third "fully hidden" state — three states of a binary preference means preference-serialisation drift and unclear defaults, for a use case (`⌘⌥` block-focus already handles) that doesn't merit it.

### D3 — Per-window scope; each window persists its own sidebar state

Every Shax window has its own sidebar with its own expand/collapse state. Widget content that depends on window context (git branch of the active pane, focused pane's SSID) resolves within that window. Widgets that are host-global (clock, CPU/memory, network default-route IP, host SSID) show the same value across windows but each widget instance owns its own render.

Persistence goes through the existing per-window preferences slot added in M9.1. New shape:

```rust
pub struct SidebarPreferences {
    pub visible: bool,          // false = icon rail, true = expanded
}
```

**Amended (M13.4).** This originally carried a second field, `caffeinate_on`, described as surviving window close "so a still-running caffeinate reflects state on reopen." Both halves fell away when D6 moved caffeinate to an app-level power assertion:

- The assertion is **process-wide, not per-window**. Every window's caffeinate widget reads the same state, and reads it back from the backend on mount rather than from disk — which is what makes a second window show "on" for an assertion the first one started.
- Nothing survives process exit by design. The assertion is released in the `RunEvent::Exit` handler, so persisting "on" across a restart would restore a claim the OS is no longer honouring.

Caffeinate is the one Phase 1 widget whose state is host-global rather than per-window. The sidebar's *chrome* stays strictly per-window, which is what this decision is actually about.

**Rejected alternative:** a single global sidebar shared across all windows (only the focused window renders it). Sounds tidier for the "one true clock" fantasy but forces a special-case in a layout system that is otherwise strictly per-window. (This alternative was originally also rejected on the grounds that caffeinate is per-shell-process — that argument no longer applies after D6, but the layout argument alone still carries the decision.)

### D4 — Focus stays with the pane; sidebar clicks are click-to-interact only

The sidebar never steals keyboard focus. Clicking a widget fires that widget's action (toggle caffeinate, expand the sidebar from the rail) without moving the DOM focus off the prompt strip / block list. Esc has no sidebar-specific behaviour; it continues to do what it already does in the focused pane.

Phase 1 widgets have no text input surfaces. If Phase 2 grows a widget with a text field (e.g. a stopwatch label, a kubectl-context filter), that widget will need to opt into the focus-return dance — but Phase 1 dodges the whole question.

**Rejected alternative:** conventional app-shell behaviour where clicking the sidebar focuses it and a Tab / Esc returns focus. Breaks the daily-driver non-negotiable ("the terminal is the primary surface") and forces every widget interaction to cost two keys.

### D5 — Five widgets in Phase 1, order pinned

Top-to-bottom, both states:

1. **Clock** — `HH:MM` + weekday + date. Ticks from the same App-level 1s interval that already drives the M12.4 prompt header clock, no new tick.
2. **CPU / Memory** — two cards. Memory is a donut + `used / total`. CPU is a header percentage over a 24-bar sparkline of recent samples, with a `load N.NN` / `N cores` footer (load average omitted on Windows, which has none — `sysinfo` returns zeros there rather than failing, and printing `load 0.00` would be a fabricated reading). Each bar is coloured by *its own* load — green below 50, amber below 80, red at or above it — so a red stretch behind a green newest bar says "it spiked and recovered"; recency is carried by opacity, keeping hue and brightness independent. Uses `sysinfo` v0.32 (cross-platform, actively maintained, one crate for all the signals). **Deferred out of scope:** per-core breakdown, top-N processes, swap.

   **The 2s cadence lives in the backend, not the frontend.** One sampler task owns the refresh and the history window and broadcasts `shax:system-load` to every window; windows read once on mount and then follow. This is not a tidiness preference. `sysinfo` derives CPU usage from the delta between successive refreshes, so when each window polled on its own timer, every window's "2-second" reading was really the interval since some *other* window last refreshed — two open windows disagreed, and the readings were noisier than they should have been even with one. CPU is host-global per D3; one sampler is what makes that true rather than merely intended.
3. **Network** — a pager over the machine's interfaces, one card at a time. Header row: `NETWORK`, a type pill (`WI-FI` / `ETHERNET` / `VPN`), and `◀ n ▶`. Body: an identity line, a per-type detail line, then `IP <addr>` with the interface name right-aligned, then `↑`/`↓` rates (green out, cyan in). Reference: `design/network-widget-1.png` … `-3.png`.

   **Host-side VM bridges are excluded on top of the address filter.** `bridge100-102` (Parallels/UTM), `docker0`, `virbr0` and `vEthernet (...)` are up and addressed, so the base filter admits them — but they describe a link to a guest rather than a link to the network, and on a development machine they outnumber the real one three to one. The test is structural rather than a list of vendor names: an interface that is neither a recognised hardware port nor a point-to-point tunnel has no physical device behind it, which is what a virtual bridge *is*. macOS asks `networksetup` (which lists every real port, Thunderbolt Bridge included), Linux checks for a `/sys/class/net/<if>/device` symlink, and Windows falls back to the hypervisor names it puts in the adapter itself.

   **The number between the pager arrows is the current interface's position, not the total.** The arrows already imply a sequence; a fixed total says nothing about where you are in it. The total lives in the tooltip as "interface 2 of 4".

   **Selection is held by interface name, not by index**, and is ephemeral — never persisted, since the set of interfaces can differ entirely across a restart. Within a session a name either still resolves or is honestly gone; an index would slide the card onto a neighbour when something *earlier* in the list disappeared, describing the wrong link with no visible cue. Losing the selected interface falls back to the primary.

   **Only interfaces that are up and hold an address are listed, and that filter is load-bearing.** It is not tidiness. A development Mac carries roughly 28 interfaces — `lo0`, `gif0`, `stf0`, `anpi0-2`, `en0-6`, `bridge0`, `ap1`, `awdl0`, `llw0`, `utun0-7`, `vmenet0`, `bridge100` — of which exactly two hold an IPv4 address. Without the filter the pager would manufacture seven phantom VPN cards out of macOS's own system tunnels, which are up and address-less. With it, VPN detection reduces to a sound rule: point-to-point, has an address, is not a hardware port.

   Per type:

   - **Wi-Fi** — SSID (or `Wi-Fi` when unnamed), signal bars, and `ch N · SECURITY · captive`.
   - **Ethernet** — link name, negotiated speed, and `1000BASE-T · full duplex`.
   - **VPN** — tunnel name, address and rates. Rendered whenever such an interface exists; it carries no protocol or handshake line (see out-of-scope below).

   ### What each value costs

   Measured on macOS 26.3 rather than inferred from documentation. Dumping CoreWLAN with location authorisation *not* granted returns `ssid=None rssi=-39 noise=-90 security=4 channel=36 txrate=1200`, which settles the important question: **only the SSID name is gated.** Signal strength, channel and security need no permission, so a user who declines the prompt still gets the whole detail line minus the name.

   **Captive state needs no network request.** macOS performs the detection itself and publishes the result at `State:/Network/Interface/<iface>/CaptiveNetwork` (`Stage : Unknown` when not behind a portal). Shax reads OS state and generates zero traffic, so the `captive` chip is compatible with non-negotiable #6 as it stands — no exception, no probe of our own to an Apple or Google endpoint. Read via `scutil` rather than a new SystemConfiguration binding, matching the existing `networksetup` shell-out.

   ### Two refresh tiers

   This supersedes the previous "refresh cadence 30s". Rates are deltas and stay on the **2s system sampler** for the same reason CPU moved there — the interval is part of what the number means, and a second independent poller would recreate the multi-window divergence that sampler exists to prevent. Everything descriptive — type, SSID, channel, security, captive stage, link media — refreshes at **30s**, because those values essentially never change and obtaining them means forking `networksetup`, `scutil` and `ifconfig`. Running those every two seconds for every interface would spend real CPU on answers that are already known. The frontend merges the two by interface name.

   ### Out of scope, decided rather than overlooked

   The reference screenshots show three values Shax will not display. Recorded here with reasons so they are not re-proposed as oversights:

   - **Latency (`18 ms`).** No OS state carries a round-trip time; `LinkQuality` is a signal metric, not RTT. Obtaining it means actively pinging on a poll, which this section already forbids and which non-negotiable #6 rules out. Showing it would require reversing that decision, not extending it.
   - **VPN handshake age (`handshake 12s`).** Requires WireGuard's control socket via `wg show`. On macOS WireGuard runs as a NetworkExtension whose socket other processes cannot reach; on Linux it typically needs root. Not portable and not reliably available.
   - **VPN protocol name (`WireGuard`).** `scutil --nc list` enumerates only *configured* VPN services and does not name the tunnelling protocol of an arbitrary `utun`.

   ### History

   The card began as SSID + default-route IP + an up/down dot, then gained throughput lines, then had its `Wired` label corrected. Two of those decisions are worth keeping visible:

   **Throughput is scoped to one interface, never summed.** Summing counts VPN and Docker adapters, so a `docker pull` would report roughly double what crossed the wire. Both directions render together or not at all — one arrow alone reads as "the other direction is idle" rather than "unmeasured".

   **The macOS SSID needs location access, and asking for it is the honest option.** M13.3 declined the entitlement and returned `None`, and the card rendered that absence as `Wired` — turning the absence of one fact into a positive claim of a different one, and telling every Wi-Fi Mac it was on Ethernet. A test asserted the behaviour, so it codified the defect rather than catching it. The fix was twofold: **medium is probed independently** and needs no permission anywhere (`networksetup` hardware ports, `/sys/class/net/<iface>/wireless`, `netsh wlan`), reporting `unknown` rather than guessing `wired`; and **macOS asks** via `NSLocationWhenInUseUsageDescription` and `CLLocationManager.requestWhenInUseAuthorization`, because every unauthorised path is redacted — on macOS 26.3 `networksetup -getairportnetwork` goes as far as claiming you are not associated with any network. Shax never reads, stores, or transmits a location; the authorisation exists solely so the OS will name the network you are already on.

   **The prompt is offered, never forced.** A permission dialog at launch, before the user has asked for anything, is the intrusion non-negotiable #1 rules out. The card offers it only where it would change something — wireless, online, prompt unanswered — and declining costs the name and nothing else, because the medium came from a separate probe.

4. **Git branch (active pane)** — branch + working-tree state + ahead/behind of the focused pane's cwd. Header row is `REPO` + `⎇ branch`; the row beneath carries `+n` staged (green), `~n` modified-unstaged (amber), `?n` untracked (faint) on the left and `↑n` / `↓n` right-aligned. Zero counts are omitted rather than printed as `+0`, and the row disappears entirely on a clean, in-sync tree.

   **Branch and ahead/behind need no probe** — the M12.4 prompt-header machinery already knows them, and this widget subscribes to the same signal via a context slot. The working-tree counts do need `git status`, and reuse the existing `git_status_porcelain` command and the M4 `parseGitStatus` parser; no new backend, no second parser for the same format.

   **Refresh policy, extending D5's "never polls":** the counts refresh on focus change, on the focused pane's cwd or branch changing, and when a command *completes* in that pane — which in a terminal is what changes a working tree. There is no timer. A file changed by an editor outside Shax is not reflected until the next command completes in that pane; that is the deliberate trade for not shelling out to `git` on a loop for every open window. A failed probe drops the counts rather than leaving stale numbers claiming to describe the current tree.

   A file that is staged and then edited again counts in *both* `+n` and `~n`. It is genuinely in both states, and dropping it from either half would misreport the tree. Falls back to hidden when no pane is focused or the focused pane's cwd isn't a git repo.
5. **Caffeinate** — a card with a coffee-cup glyph, a title, and a pill switch. Off state: dim subtitle explaining what it does. On state: green switch + relative timer ("2m 14s") in place of the subtitle. Clicking it holds an OS-level power assertion — see D6. Live on all three platforms.

Widget order is fixed for Phase 1. Drag-to-reorder is Phase 2 territory (the community-widget schema needs it more than the built-in set does — five widgets rearrange in five seconds via a preferences file if a user really cares).

### D6 — Caffeinate holds an OS power assertion; the honest-log path is for shell state, not app state

**This decision was reversed during M13.4. The original is preserved at the end of this section, because the reasoning that overturned it applies to every widget Phase 2 will let the community write.**

Clicking the caffeinate widget "on" asks the operating system to suppress idle sleep, through a Tauri command backed by `src-tauri/src/power.rs`. No pane is involved:

- **macOS** — a child `/usr/bin/caffeinate -di -w <shax pid>`, parented to Shax rather than to any pane's shell. `-w` makes the OS reap it if Shax dies without releasing cleanly.
- **Linux** — a child `systemd-inhibit --what=idle --who=Shax --why=… sleep infinity`, launched with `PR_SET_PDEATHSIG` so it dies with Shax (Linux has no `-w` equivalent, and without this a `SIGKILL`ed Shax leaves the lock held until logout). `--who` / `--why` make the assertion attributable in `systemd-inhibit --list`. **`idle` only, not `idle:sleep`**: vetoing an explicit user-initiated suspend is the wrong behaviour, and block-mode sleep inhibitors are polkit-gated, so asking for one fails on machines where plain idle inhibition would have worked.
- Both use absolute paths where the location is stable, rather than a bare `PATH` lookup — the app's inherited `PATH` is not ours to trust, and a lookup runs whatever resolves first under that name. Linux falls back to a `PATH` lookup because install locations vary more there.
- **Windows** — `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)`, held on a dedicated thread because the flags are per-thread and die with the thread that set them.

Properties this design commits to:

- **The OS is the source of truth.** `power::set` returns the state that actually holds, and a failed acquire leaves the assertion *off* — "errored but holding" is unrepresentable, not merely avoided. The widget adopts what it is told, so a refused assertion shows as off rather than as a toggle that lies.
- **State is verified on every read, not assumed.** `power::state` asks whether the helper is still alive and clears the record if it is not. This is load-bearing on Linux: `systemd-inhibit` exists on any systemd distro but fails when there is no logind session (headless, plain SSH, containers, WSL without systemd), and it fails by *exiting* rather than by refusing to spawn. That is invisible at spawn time — the child has not been scheduled yet — so a spawn-time check cannot catch it and an earlier draft of this slice reported a cheerfully ticking toggle on a machine that then slept. Verifying on read also covers every later death: a killed helper, a revoked lock.
- **Failures name the thing that failed.** A missing helper reports which binary and what it means, not a bare `errno`. The card shows a short label with the full message in its tooltip, because a 280px nowrap line truncates anything useful.
- **The assertion is process-wide, and every window follows it live.** Setting it broadcasts `shax:keep-awake-changed` app-globally, and each widget also reads the state back on mount. Mount-read alone is not enough: a window that didn't issue the toggle would otherwise sit showing the state it read when it opened — an "off" switch on a machine that is genuinely being kept awake.
- **The backend owns the start time**, stamped at acquire and returned with the state, so every window renders the *same* duration — including one opened long after the assertion began, which has no other way of knowing when that was. A redundant acquire keeps the original stamp rather than restamping, which would silently reset every window's duration to zero.
- **It is released on exit** (`RunEvent::Exit`), and never persisted. A restart starts off.
- **The promise is platform-honest.** macOS `-di` prevents display sleep *and* idle system sleep. Linux `--what=idle` prevents idle system sleep only — screen blanking belongs to the screensaver (`org.freedesktop.ScreenSaver`), which Phase 1 deliberately does not touch. The Linux tooltip says so rather than promising more than it delivers.
- **Duration is never invented.** It is computed from the backend's stamp against the shared clock tick, never from the widget's own first sight of the assertion — the fidelity contract applied to a reading rather than to output.

#### Why the original decision was reversed

The original design emitted `caffeinate -di` into the focused pane's scrollback. It shipped as far as review before the flaw surfaced: **a foreground `caffeinate` blocks the pane it lands in.** The pane accepts no further commands until the user Ctrl+Cs it, so a convenience toggle costs them a shell and a new tab. No amount of polish fixes that; it is inherent in running a never-exiting foreground process in a pane the user is working in.

Two alternatives were weighed and rejected:

- **Background it (`caffeinate -di &`).** Frees the pane and stays inside the honest-log path. Rejected because the elegant "the block IS the widget state" derivation dies with it — the block completes instantly — leaving PID tracking by parsing the shell's job-control output, which is fragile and shell-specific. It also leaves Windows permanently unsupported.
- **Give it a dedicated pane.** Keeps every mechanism intact but spends a permanently visible pane on a background utility.

#### The line this draws, and why it is not a weakening of non-negotiable #3

Non-negotiable #3 exists so the scrollback is a truthful, reproducible history of **what happened to the user's shell, filesystem, and repository**. Its target is the widget that quietly runs `git reset` and leaves no trace. An OS power assertion held by the Shax process touches none of those: it is app state, in the same family as sidebar visibility, font size, and theme — none of which emit commands, and none of which anyone expects to.

**The rule, stated for Phase 2 to inherit:** an action that changes the user's shell, filesystem, or repository goes through `shax:emit-command` and the safety gate, always. An action that changes only Shax's own state, or asks the OS for something on Shax's behalf, does not. When a widget author cannot tell which side an action falls on, it goes through the emit path — the default is disclosure.

The "hidden state" objection is answered by the widget itself: it is pinned in the sidebar and legible whenever it is on. That is a permanent readout, not a side effect that leaves no trace. A power assertion with no visible indicator anywhere in the UI *would* violate the principle.

#### Windows is no longer deferred

The original deferral was not really about Windows. It was about Windows having no shell command that could satisfy a *requirement to be a shell command*:

- `powercfg /requests` is read-only.
- Third-party `caffeine.exe` is neither bundled nor guaranteed installed.
- A PowerShell one-liner calling `SetThreadExecutionState` returns immediately, so the block completes at once and the on/off derivation breaks.

Drop the requirement and the platform answers cleanly: `SetThreadExecutionState` is the documented Win32 mechanism. Windows ships in M13.4 with macOS and Linux, and the Phase 1.5 follow-up is cancelled.

<details>
<summary><strong>Superseded:</strong> the original D6 (caffeinate emits a real command into the focused pane)</summary>

> Clicking the caffeinate widget "on" runs the real OS command in the focused pane's shell, exactly as the user typed it: `caffeinate -di` on macOS, `systemd-inhibit --what=idle sleep infinity` on Linux, "not available on this platform" on Windows.
>
> The command is routed via `shax:emit-command` → the safety gate → `shax:emit-command-approved` → the PTY, identical to how the palette emits commands. The command shows up in scrollback as a real block with a real PID; the user can `Ctrl+C` it from the pane; the widget's "on" state is derived by watching the block's completion signal; and if no pane is focused when the widget is clicked, the widget refuses (subtle shake).
>
> **Rejected alternative:** click the widget → the app runs the command "internally" via a Tauri command, no scrollback echo. Rejected because it violates the honest-log principle (#3). Users find their long-running commands by scrolling; a caffeinate that runs invisibly is exactly the class of hidden state the non-negotiable exists to prevent.

</details>

## Slices

Four sub-PRs, sized so each is reviewable in one sitting and shippable on its own.

### M13.1 — Sidebar chrome + `⌘B` toggle + focus rules

Scope: everything except the widgets. Establishes the visual axis, the state machine, the persistence path, and the focus contract that Phase 1's remaining slices and Phase 2 both depend on.

- New component `src/sidebar/Sidebar.tsx`. Two-state layout (280px / 44px), collapse animation (150ms width transition, no fade — snappy), placeholder widget slot area that just renders "no widgets yet."
- New keybinding `⌘B` in the App-level keydown handler. Toggles the current window's `sidebar_visible` preference; the change flows back through the standard preferences roundtrip so both windows and future palette entry see the same source of truth.
- New palette command **"Sidebar: expand / collapse"** (per M8 palette conventions).
- New `SidebarPreferences { visible }` on the per-window preferences slot from M9.1. Every field optional in the on-disk shape for backward compatibility with pre-M13 window state. (M13.4 amendment: this originally also carried `caffeinate_on`; see D3 for why the reversal in D6 removed it.)
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

### M13.4 — Caffeinate widget + OS power assertion

Scope: the one widget that changes machine state rather than reporting it. Isolated in its own slice because it crosses the frontend/backend boundary and is the milestone's test of where the honest-log path begins and ends (D6).

- New `src-tauri/src/power.rs` — one process-wide assertion behind `power_keep_awake(enable) -> bool` and `power_keep_awake_state() -> bool`. Per-OS mechanism per D6. Released in the `RunEvent::Exit` arm. The invariant the module guarantees, and tests: a failed acquire leaves the assertion off, never "errored but holding."
- `windows-sys` under `[target.'cfg(windows)'.dependencies]` for `SetThreadExecutionState`. Already in the tree via Tauri, so nothing new is downloaded. macOS and Linux need no crate — they spawn the OS's own helper.
- New `src/sidebar/widgets/CaffeinateWidget.tsx` + `.css`. Expanded: `CARD` with a ☕ glyph, a bold "Caffeinate" title, and a pill switch. The line under the title carries whichever state is live — a failure, the running duration, or the resting explanation. Rail: ☕ glyph, greyscaled when off, display-only per D1.
- Every transition reconciles against the backend's answer rather than the request. On mount the widget reads `power_keep_awake_state()`, and it stays subscribed to `shax:keep-awake-changed` for the lifetime of the widget so a toggle in any window moves the switch in all of them.
- `power_keep_awake_state()` returns `{ held, since_ms }`. The backend stamps `since_ms` at acquire, so every window computes the same duration off the shared clock tick.
- No pane involvement anywhere: no `shax:emit-command`, no focused-pane resolver, no block subscription.

**Exit:** on macOS, Linux, **and Windows**, clicking the caffeinate widget On stops the machine idle-sleeping and the widget shows a live duration; clicking Off releases it. A refused assertion leaves the widget off and says why. Toggling it in one window moves the switch in every other open window, and all of them show the same duration. Opening a new window shows the assertion as on. Quitting Shax releases it. No pane is blocked, and no pane's scrollback changes.

## Non-goals (explicit, not deferred)

- **Community widget sandbox.** Phase 2. Everything Phase 1 ships is React-authored in-repo. No Web Worker, no schema, no capability gates. Building the sandbox before we've lived with the built-in set is speculative generality.
- **Drag-to-reorder widgets.** Fixed order for Phase 1. If a user asks in the first month of daily-driving, it lands in a follow-up; the community-widget story in Phase 2 needs it more than the built-in set does.
- **Per-widget preferences panel.** The two widgets that could have preferences (network refresh cadence, CPU alert threshold) don't in v1. Add a preferences pane only when a real ask exists.
- ~~**Windows caffeinate.** See D6. Phase 1.5 follow-up.~~ **Shipped in M13.4** — the D6 reversal removed the shell-command requirement that was blocking it. No Phase 1.5 follow-up needed.
- **Weather widget.** Punt to Phase 2 — needs an explicit network capability, which needs the sandbox that Phase 1 doesn't build.
- **kubectl context widget.** Same — needs a `kubectl config current-context` shell-out, which is easy, but this is meaningful only to a subset of users, and Phase 2's community widget path is the right home for niche tooling.
- **Sidebar-hosted terminal / editor / block viewer / anything that hosts a pane.** The sidebar is for widgets, not for panes. If a user wants a persistent htop, that's a pinned tab or a pane in the layout, not a sidebar widget. Same rule the parent design note in `12-roadmap-milestones.md` § "Sidebar with pinnable widgets" already established: no in-Shax app runtime.
- **Third state "sidebar fully hidden."** See D2. Rail is always visible.

## Testing

Every slice writes tests alongside per CLAUDE.md § "Testing policy".

- **M13.1** — `Sidebar.test.tsx` covers both states rendering, `⌘B` toggle via `fireEvent.keyDown`, palette command dispatch, focus-never-leaves-pane on mousedown, per-window preferences round-trip. Rust: `preferences.rs` gains a round-trip test for `SidebarPreferences` and a missing-field-defaults-to-false test.
- **M13.2** — `ClockWidget.test.tsx` with a fake `Date.now()`-injecting harness (there's already one in the M12.4 clock tests). `GitBranchWidget.test.tsx` mocks the focused-pane context to cover: repo pane (shows branch), non-repo pane (hidden), no pane focused (hidden), pane focus swap (branch updates).
- **M13.3** — Rust: `sysinfo.rs` and `ssid.rs` each get a smoke test that the probe returns a non-panicking value on the CI's host OS (probing is inherently host-dependent; assert the shape, not a specific value). Frontend: `CpuMemWidget.test.tsx` renders both bars from a mocked probe value; `NetworkWidget.test.tsx` covers online (green dot), offline (red dot), SSID-missing (chip renders IP only).
- **M13.4** — Rust: `power.rs` tests the state machine rather than the host's willingness to grant an assertion (CI runners are headless and a Linux container may have no logind session, so asserting a successful acquire would test the runner image, not this module). Covers: release is always safe and idempotent, a failed acquire never leaves the assertion held, acquiring twice holds exactly one and keeps the original start stamp, a start time is reported exactly when held, and — the regression that motivated verify-on-read — **a helper that dies under us reads back as off and clears its slot**, driven with a helper that exits on its own because `set(true)` cannot reproduce a death that is invisible at spawn time. Frontend: `CaffeinateWidget.test.tsx` mocks the IPC surface and covers off→on adopts the granted state, a backend granting nothing leaves the widget off, a rejected request reports why and stays off, a new window adopts an already-held assertion and dates it from the backend's stamp, a change made in another window reaches this one in both directions, the duration matches across windows, the subscription is released on unmount, the duration reads from the shared clock tick, a failure keeps its full text in the tooltip behind a short card label, the Linux tooltip carries the screen-blanking caveat and macOS does not, and the rail is display-only.

Playwright end-to-end: one new file `e2e/sidebar.spec.ts` — rail-by-default, chevron expand/collapse, the caffeinate card rendering, and the widget staying off when the backend grants nothing. Note the harness runs against the bare Vite dev server with **no Tauri host**, so whether the OS actually grants an assertion is not observable at this layer; that belongs to `power.rs`'s tests. What the backendless harness proves well is the reconciliation contract: nothing granted, nothing claimed.

## Cross-cutting concerns

- **Honest log (`CLAUDE.md` non-negotiable #3).** D6 is the load-bearing test of this principle for M13, and its reversal is where the principle's *scope* got settled. The rule Phase 2 inherits: an action that changes the user's shell, filesystem, or repository goes through `shax:emit-command` and the safety gate, always; an action that changes only Shax's own state, or asks the OS for something on Shax's behalf, does not. Where an author cannot tell which side an action falls on, it goes through the emit path — the default is disclosure. App state still needs a visible readout: the caffeinate widget is pinned and legible whenever it is on, and a power assertion with no indicator anywhere would violate the principle.
- **Daily-driver first (non-negotiable #1).** The default state is icon rail, not expanded — the sidebar earns its width, doesn't take it by default. Widgets never steal focus. `⌘B` is a single-chord toggle. All of this preserves the "as fast and calm as a great native terminal" feel.
- **Never hijack input-owning programs (non-negotiable #4).** Sidebar is chrome; alt-screen apps still render into the xterm grid untouched, and `⌘B` during vim / htop / ssh just toggles a column of chrome. M13.4 additionally found and closed a **pre-existing hole**: `shax:emit-command-approved` wrote to the PTY regardless of whether an alt-screen program owned it, so a widget, the assistant, or the palette could type a command line into a running vim. The guard now sits at that shared chokepoint in `TerminalPane`, covering every caller at once. It outlived the D6 reversal — caffeinate no longer emits anything, but git-status, ls, the assistant, and the palette all still do.
- **Safety gate (non-negotiable #5).** Caffeinate no longer emits a command, so it no longer passes the gate — its assertion is neither destructive nor state-changing for the user's shell, and it is reversible by the same click that set it. Every widget that *does* emit still routes through `shax:emit-command-approved`, the same gate palette-emitted and assistant-suggested commands pass through, and a Phase 2 widget emitting a destructive command is subject to the same approval flow.
- **Local-first (non-negotiable #6).** Zero network traffic of our own. `sysinfo` reads `/proc` and equivalent; `networksetup`, `iwgetid`, `netsh`, `scutil` and `ifconfig` are local reads; CoreWLAN is in-process. No ping-based reachability check and no latency probe — see D5 item 3's out-of-scope list. Captive-portal state is read from the OS's own detection rather than by requesting a known endpoint ourselves, which is what keeps that chip inside this principle.
- **Fidelity contract (non-negotiable #2).** Widgets are lenses over real state (OS probes, focused-pane branch, block lifecycle). If a probe fails, the widget hides its affected line — never fabricates. Every widget's failure mode is `None → hidden`, not `None → "N/A"`.

## Roadmap slot

Insert as **M13 Sidebar with pinnable widgets (Phase 1)** in `12-roadmap-milestones.md`, immediately after the M12 section. Remove the current "Sidebar with pinnable widgets" bullet from Post-M8 candidates in the same commit; the Phase 2 (community widget sandbox) content stays in the roadmap file as its own "Post-M13" candidate.

---

# Phase 1 extensions (M13.5)

Reference mockups: `design/sidebar-extended.png` (expanded), `design/sidebar-collapsed.png` (rail), `design/disk-widget-1.png` through `design/disk-widget-4.png` (Disk pager states). These supersede the M13-era `design/widget-sidebar.png`, which is deleted in the same commit as this spec — one canonical mockup per state, no fossils to argue with.

## What this milestone adds

Three new widgets (Calendar, Battery, Disk), three reshapes of shipped widgets (Clock, Memory, Repo), and a full remodel of the collapsed rail. Same Phase 1 charter as M13 — no runtime, no schema, no sandbox — and every widget stays Shax-authored React sitting in-repo. The extension is scoped to what daily use of the M13 sidebar surfaced as missing, plus the collapsed-rail rework that has to ship alongside because its mini-cards can only be laid out once the full extended widget set is present.

## Locked decisions (extending D1–D6)

Every decision below is my recommendation, called out so you can push back before we sink cost — same rule as the original D-block.

### D7 — Uptime lives inside the Clock widget, not as a standalone widget

The mockup shows `up 6d 04h · CEST` on the third line of the Clock card. Uptime is treated as a peer to timezone rather than as its own tile:

- Both answer variants of the same question — "wall time on this machine" — and both belong in the same visual frame.
- A standalone "uptime + boot time + load average" widget would compete with the CPU card for the same slot in the reader's eye without carrying meaningfully different content.
- The Clock card's third line is already the "at-a-glance context for what's shown above" slot; timezone establishes when, uptime establishes how long.

Requires one new probe (`system_uptime_seconds() -> u64`) added to the existing `status.rs` — `sysinfo::System::uptime()` covers all three OSes.

**Rejected alternative:** a dedicated "System" widget carrying uptime + boot time + `load N.NN`. Splits the answer to one question across two widgets (CPU already carries load) and adds a fourth thing competing for glance-height. Uptime in Clock is one line of dim text; the split loses the compactness.

### D8 — Calendar is a hollow month grid; no event data, no permissions

The Calendar widget renders the current month as a M-T-W-T-F-S-S grid with today highlighted in an accent circle, plus prev/next chevrons for month navigation. Days from the previous and next month fill out the edge weeks in a dim colour so every week row is complete.

Explicitly not:

- **EventKit / macOS Calendar integration.** Reading real events needs an entitlement plus a permission prompt — the exact shape of the CoreLocation dance that turned verification-backlog entry 1 into a two-round debug session — plus a Windows / Linux equivalent story that does not exist. The benefit real events would carry does not justify a permission prompt to render a datepicker.
- **CalDAV / iCloud / Google Calendar sync.** Auth + network, and Phase 1 explicitly ships no networked widgets.
- **A `.ics` file reader.** A file picker + `.ics` parser is a small feature that mainly serves users who already have a first-class calendar app open elsewhere.

The card exists so a user glancing at the sidebar can answer "what day of the month is it, and how far into the week?" without leaving the terminal. That is the whole scope. Real events belong in Phase 2 as a networked / entitled widget, if a real ask arises.

Navigation is client-only — no probes, no persistence. Prev/next chevrons walk months; the "today" reference is preserved on return.

### D9 — Battery gains a sidebar card; the statusbar chip is not removed in this milestone

The statusbar carries a battery chip today (M12.4b). The sidebar's Battery card is richer: `82% · 4h 20m` labels with a full-width horizontal bar underneath, coloured by state (green when discharging comfortably, amber when low, blue when charging).

Both surfaces stay for M13.5. Consolidation is a separate conversation, held after the sidebar version has landed and been lived with. Time and IP already have the same overlap — both live in the sidebar and the statusbar today — and the right time to settle "what does the statusbar carry now that the sidebar exists?" is once, across every duplicated signal at the same time, not per-widget in the milestone that first duplicates it.

The card hides itself entirely when no battery is present. Desktops with no battery see no gap and no placeholder — same graceful-degradation rule the M13 widgets follow.

### D10 — Disk is a pager over volumes; the Network pattern applies exactly

Reference: `design/disk-widget-1.png` (system volume, comfortable), `-2.png` (a paired data volume), `-3.png` (an external drive at 91% used — bar heat-mapped red), `-4.png` (a scratch volume with a non-APFS filesystem).

The card renders one volume at a time with header `DISK ◀ n ▶`, mirroring Network's pager visual. Each card:

- Volume name (bold, left) and free space (right, in the same slot Network uses for signal bars).
- Mount point (dim, second line).
- Horizontal usage bar, heat-mapped by percent used: teal below 70%, amber 70–90%, red at or above 90%. Same colour-carries-state principle as the CPU sparkline.
- Bottom line: `NN% used of X TB · FILESYSTEM` — filesystem type (`APFS` / `exFAT` / `NTFS` / `ext4`) right-aligned so it lines up across volumes.

Volume enumeration and filtering, per OS:

- **macOS:** `getmntinfo(3)` (or `libc::statfs` walk). Filter out any mount whose flags carry `MNT_SNAPSHOT`, whose filesystem type is `devfs` / `autofs` / `nullfs`, or whose mount point sits under `/System/Volumes/Preboot`, `/System/Volumes/VM`, `/System/Volumes/Update`. Keep `Macintosh HD` (the read-only system snapshot) and `Data` (the user data volume) — both are addressable and meaningful.
- **Linux:** `/proc/mounts` + `statvfs`. Filter out `tmpfs`, `sysfs`, `proc`, `cgroup*`, `devpts`, `overlay`, and any mount under `/proc`, `/sys`, `/dev`, `/run` (unless the user has explicitly mounted a real volume there).
- **Windows:** `GetLogicalDriveStrings` + `GetDiskFreeSpaceEx`. Keep `DRIVE_FIXED` and `DRIVE_REMOVABLE`; exclude `DRIVE_UNKNOWN`, `DRIVE_NO_ROOT_DIR`, and `DRIVE_CDROM` when no media is present.

Selection is by **mount point**, not by index — same reason Network's selection is by interface name. An index would slide the card onto a neighbour when a volume unmounts. Ephemeral, not persisted.

Two refresh tiers, same shape as Network:

- **Enumeration + filesystem type + total capacity** on the descriptive 30s tier — volumes come and go from user action, not from data change.
- **Free space** on the same 30s tier — it is not a delta and forking `statvfs` every 2 seconds is wasted.

**Rejected alternative:** a summed "total free across all volumes" chip. Sums a Backup drive's free space against a system disk that is nearly full into one meaningless number; the reader still has to page volumes to know which one is the concerning one.

### D11 — Collapsed rail remodel: dense mini-cards, not one glyph per widget

Reference: `design/sidebar-collapsed.png`.

The M13.1 rail was "one glyph per widget at 44px." With nine widgets in the extended set the glyph rail runs out of information density — a coffee cup and a plug do not answer "what is my machine actually doing right now?" The remodel replaces the glyph rail with **compact data cards**, one per widget:

- **Clock** — `HH` above `MM` as a two-line stack (mockup shows `07` above `22`).
- **Calendar** — three-letter month above the day-of-month in an accent circle (`AUG` / `23`).
- **Network** — signal bars only; no SSID, no IP.
- **CPU** — mini sparkline over the percent, matching the extended card's bar treatment at reduced width.
- **Memory** — miniature donut with `%` inside, same language as the extended card.
- **Disk** — free-GB figure as a bare number, no bar (bar is the width the rail doesn't have).
- **Network throughput** — `↑1.2` / `↓240` on two lines (unit implied by context).
- **Battery** — mini bar (colour-coded) above the percent.
- **Repo** — `⎇` glyph above `+n ~n` on two lines when non-zero; empty when clean.
- **Caffeinate** — coffee glyph, opacity-carried on/off state.
- **Expand chevron** — pinned to the bottom, unchanged.

Rail width may grow modestly from the M13.1 44px to accommodate two-digit figures at a legible weight. Cap at 56px — beyond that we are approaching "small expanded state" and the reader has already asked for the expanded state at 280px. Final width lands during implementation once type metrics are known.

**The rail is never a mode.** Every rail card is display-only, and clicking any rail card expands the sidebar rather than invoking the widget's action. This is D1's "clicking a glyph is 'expand,' not 'toggle caffeinate'" rule, kept intact — the substitution is content-density, not interaction-model.

**Rejected alternative:** a "third state" that is dense-cards-with-full-labels between the current rail and the expanded state. Three states of a binary preference — same reason D2 rejected a "fully hidden" state. Two states is enough; density substitution inside the collapsed state is not a third state.

### D12 — No "local metrics only" footer on the sidebar

The mockup carried a `● local metrics only` footer chip at the bottom of the expanded sidebar. Not shipped, on the reasoning that:

- Phase 2 will let community widgets request network access via a capability gate (per `12-roadmap-milestones.md` Post-M13 candidate). At that point the footer either becomes a lie or has to grow into a per-widget indicator. Building it now to sunset it in Phase 2 is churn.
- The local-first pledge is already carried in the README (M13.4 amendment extended it), the Preferences → Assistant privacy row, and the empty-state hero — the surfaces where a user asking the question would go looking. A sidebar footer preaches to the choir.
- A per-widget capability indicator (a small globe / lock in each card's header) is the shape Phase 2 will need anyway. The footer would compete with it and lose.

The pledge stays true — no M13.5 widget makes any network call — but the assurance lives where it earns its space, not as ambient sidebar chrome.

## Widget set at M13.5

Building on D5 (M13's five widgets), the extended set is **nine**, top-to-bottom in the order pinned by `design/sidebar-extended.png`:

1. **Clock** — reshaped per D7 + mockup. Big `HH:MM` (mono, primary), accent-coloured seconds `SS` (small, right of the minutes). Second line: full weekday + day + month (`Sunday 23 August`). Third line: `up Nd NNh · TZABBR`. No change to tick source.
2. **Calendar** — NEW per D8. Client-side render only.
3. **Network** — unchanged from the M13 refinement pass (multi-interface pager).
4. **CPU** — unchanged. Extended CPU card format from the M13 refinement (heat-mapped sparkline + `load N.NN · N cores`).
5. **Memory** — donut + `used / total GB` unchanged; **adds a `swap N.N GB` line** below the primary readout. `sysinfo::System::used_swap()` supplies the number cross-platform; the line reads swap actually in use, not swap allocated (an idle Mac with `SwapTotal ≠ 0` should read `swap 0.0 GB`, not `swap 8.0 GB`). Hide the swap line entirely when `total_swap == 0`.
6. **Disk** — NEW per D10.
7. **Battery** — NEW per D9. Consumes the existing M12.4b `system_battery` probe — no new backend.
8. **Repo** — extended: **the `?n` untracked count is added** to the working-tree summary line, in a dim colour (weaker than `+n` staged green and `~n` unstaged amber, but present). Reuses the existing `git_status_porcelain` output, which already carries untracked entries; the current widget just doesn't count them. Zero counts continue to be omitted rather than printed as `?0`.
9. **Caffeinate** — unchanged.

Widget order is fixed for M13.5 — drag-to-reorder remains Phase 2 territory per D5.

## Slices

Five sub-PRs after this spec.

### M13.5.1 — This spec + mockup housekeeping

Scope: land this section, wire the mockup references, delete the superseded `design/widget-sidebar.png`. No code, no widget changes.

**Exit:** spec merged; canonical mockups are only the new ones.

### M13.5.2 — In-place reshapes

Scope: everything that changes an existing widget without adding a new one, plus the one new native probe the reshapes need.

- **Clock:** format per mockup, add the third line (uptime + timezone).
- **Memory:** add the swap line.
- **Repo:** add the `?n` untracked count.
- **Rust:** `system_uptime_seconds()` in `status.rs`, via `sysinfo::System::uptime()`.
- **Frontend:** timezone read from `Intl.DateTimeFormat().resolvedOptions().timeZone`, resolved to a short abbreviation via `Intl.DateTimeFormat(..., { timeZoneName: 'short' })`. No probe — JS reads the OS timezone directly.

**Exit:** Clock card matches mockup. Memory card shows a swap line on machines with active swap, hides it cleanly on machines without. Repo card carries `?n` when there are untracked files, omits when there are none.

### M13.5.3 — Calendar + Battery in sidebar

Scope: two new widgets, no new native probes.

- New `src/sidebar/widgets/CalendarWidget.tsx` — month grid, today highlighted, prev/next chevrons. Pure client render.
- New `src/sidebar/widgets/BatteryWidget.tsx` — consumes existing M12.4b `system_battery` probe.
- Both wired into the sidebar's widget slot in the order pinned above.

**Exit:** Calendar renders the current month with today accented; navigating other months does not lose the "today" reference on return. Battery card renders when a battery is present; silently omitted when not.

### M13.5.4 — Disk widget + volume pager

Scope: the milestone's biggest slice.

- New volume-enumeration surface in `status.rs` (or a dedicated `disk.rs`, at the implementer's call): macOS `getmntinfo`, Linux `/proc/mounts` + `statvfs`, Windows `GetLogicalDriveStrings` + `GetDiskFreeSpaceEx`, all behind one `disk_volumes() -> Vec<VolumeInfo>` command. Filtering per D10.
- New `src/sidebar/widgets/DiskWidget.tsx` — pager over volumes, mirrors `NetworkWidget`'s structure (selection by mount point, on-mount fresh probe, 30s refresh).

**Exit:** Disk card shows every mounted volume the D10 filter admits, one at a time; paging arrows walk through them; the bar heat-maps to used-percent; filesystem type shows for each; a volume that unmounts drops from the pager on the next refresh without shifting the selection off the currently-viewed volume onto a neighbour.

### M13.5.5 — Collapsed rail remodel

Scope: replace the M13.1 glyph rail with the D11 mini-card rail, once the extended widget set is complete.

- Each widget grows a `Rail` render alongside its expanded render — the existing pattern from M13, extended across all nine widgets.
- Rail width bumped from 44px to whatever the mockup's cards land at (probably 52–56px, decided during implementation).
- The click-to-expand contract (D1) is preserved.

**Exit:** collapsed sidebar matches `design/sidebar-collapsed.png` at typical DPI; every rail card is display-only; clicking any card expands the sidebar rather than firing the card's action.

## Non-goals for M13.5 (explicit, not deferred)

- **Weather widget** — same reason as M13. Phase 2 with the capability gate.
- **Uptime as a standalone widget** — folded into Clock per D7. If a user ever asks "why is uptime hiding in a Clock", we split it out; nobody has yet.
- **Calendar with real events** — per D8. Not "eventually", not "with a flag" — Phase 2 with a networked or entitled capability, if at all.
- **Statusbar consolidation** — per D9. Separate follow-up conversation, not a slice of this milestone.
- **`● local metrics only` footer** — per D12.
- **Drag-to-reorder** — still Phase 2 (D5).
- **Per-widget preferences** — still deferred; the widgets that could earn one (Calendar first-day-of-week, Disk hide-external-drives) don't in v1.

## Testing (extension)

Per the CLAUDE.md testing policy, each slice writes tests alongside.

- **M13.5.2** — `ClockWidget.test.tsx` grows cases for the uptime line format (`up 6d 04h`, singular/plural boundary, `up NNm` when uptime is minutes only), the timezone abbreviation, and the three-line mockup layout. `MemoryWidget.test.tsx` grows a swap-line-present case, a swap-line-hidden-when-`total_swap == 0` case, and a swap-line-reads-0.0-when-idle-but-swap-configured case. `GitBranchWidget.test.tsx` grows an untracked-count-visible case and an untracked-zero-omitted case. Rust: `status.rs` gets a smoke test that `system_uptime_seconds()` returns a plausible non-zero number on the CI host.
- **M13.5.3** — `CalendarWidget.test.tsx` covers month rendering (current month, prev-month days greyed, today accented), prev/next chevron navigation with today-preservation, and the "widget makes zero backend calls" guarantee. `BatteryWidget.test.tsx` covers charging vs discharging colour, the estimate rendering, and the "no battery → widget hidden" case.
- **M13.5.4** — `DiskWidget.test.tsx` covers pager navigation, heat-mapped bar at three utilisations (below 70%, 70–90%, ≥90%), the `used-of-total · filesystem` bottom line, and — the invariant Network also tests — selection sticks to mount point when a volume earlier in the pager unmounts. Rust: `disk_volumes()` gets a smoke test that it returns a non-panicking non-empty list on the CI host, plus a unit test on the filter logic against synthetic mount lists that exercises each of the "should be excluded" cases (tmpfs, sysfs, snapshot, autofs, etc.).
- **M13.5.5** — `Sidebar.test.tsx` grows cases for the new rail rendering (each widget renders its Rail variant when `visible=false`), and the click-to-expand contract (clicking any rail card fires the sidebar-expand handler, not the widget's own action).

Playwright: `e2e/sidebar.spec.ts` grows one case per new widget (renders in the extended state), and one for the rail remodel (renders in the collapsed state). Backend-dependent behaviour (disk enumeration, uptime) stays in the Rust tests where a real host is available; the Playwright harness runs against the bare Vite dev server without a Tauri host per M13's existing note.

## Cross-cutting concerns (extension)

The M13 spec's cross-cutting concerns still apply. Three updates:

- **Local-first (non-negotiable #6).** Every M13.5 widget continues the zero-network-traffic-of-our-own rule. Disk shells out to `statvfs` / `GetDiskFreeSpaceEx`; Calendar uses no data source at all; Battery reuses the existing local probe; the Clock's timezone reads from the OS's own zone via `Intl`, in-process JS with no external lookup. **No** IP-geolocation for a Weather widget that isn't being built.
- **Daily-driver first (non-negotiable #1).** Nine widgets is more than five; the collapsed rail remodel exists so users who don't want to give up 280px of pane width still get glanceable value out of the sidebar. The 44px → ~56px growth is a real cost, paid deliberately to make the compact state useful rather than merely present.
- **Fidelity contract (non-negotiable #2).** Every new widget's failure mode is `None → hidden`, not `None → placeholder`: Memory hides the swap line when `total_swap == 0`, Battery hides itself when there's no battery, Calendar has no failure mode (no probes to fail), Repo's `?n` count omits when zero. Same pattern the M13 widgets already follow.
