# 15 Multi-window

Native OS windows in addition to tabs and splits. A window is a workspace — its own tabs, panes, palette, and assistant dock. History and the block store stay backend-global so search reaches across everything. Session restore restores N windows, not one.

Grows out of the multiplexing model in `04`; this spec is the shape one level up.

## What a window is (and isn't)

- A **workspace**. Own tabs. Own splits. Own palette. Own assistant dock (per `07-7 assistant docking`). Own foreground focus.
- **Not** a second view onto the same session. Opening a new window creates a fresh tab with a fresh pane; it does not mirror an existing one. Users who want two views of the same output run a split.
- **Not** a separate process. All windows are frontends against the one Rust backend. PTYs, the block store, the search index, the safety-gate ledger, semantic-embedding jobs — all backend-global.

## What the backend owns

The backend already owns pane state, block state, and search (`03`, `05`). Multi-window adds:

- A `WindowId` newtype. Every layout tree, PTY assignment, session-restore record, and IPC channel that used to be implicit-single-window becomes explicitly window-scoped.
- A `windows` registry: `WindowId → WindowState { tabs, focused_tab, focused_pane, ... }`.
- A per-window session-restore record. On graceful quit, the on-disk session file is a list of windows; each window is what today's single-window session record already stores.

Everything else stays global: history, the block store, embeddings, the safety-gate approval flow (a pending gate is per-window because the modal is per-window UI, but the *ledger* of what was approved is global).

## What the frontend owns

Each Tauri `WebviewWindow` runs one React root, scoped to its `WindowId`. React state that today assumes "one window" — pane state, focus state, palette open/closed, assistant dock open/closed — becomes window-scoped. IPC channels the backend already keys by `pane_id` gain a `window_id` in the address.

The React state audit is a real refactor, not a cosmetic rename — anything that lives in a top-level context provider today needs to be reasoned about (per-window or shared?).

## Lifecycle by OS

macOS convention differs from Windows/Linux; we follow each rather than force uniformity.

- **macOS.** Closing the last window does **not** quit. The process stays alive in the dock and menu bar. `Cmd+Q` (or `Shax → Quit` in the app menu) quits explicitly. Reopening from the dock spawns a fresh window (or restores from session if that's the user setting).
- **Windows / Linux.** Closing the last window quits the process. No hidden menu-bar mode.
- **Session-restore hook.** On startup, if a session file exists and either (a) a window is being created because the user launched the app or (b) macOS is reopening from a hidden state, restore the persisted windows. Never restore silently in the middle of a running session.

## Session restore

The on-disk session record becomes a list of window records:

```
Session { windows: [WindowRecord] }
WindowRecord {
  id: WindowId,             // persisted, so refocus after restore is stable
  bounds: WindowBounds,     // position + size
  tabs: [TabRecord],        // per today's format from `04`
  focused_tab: TabId,
  focused_pane: PaneId,
}
```

Panes restore fresh shells in their saved cwds (per `04`). We do not persist live process state. If the restore fails on one window (missing cwd, bounds off-screen), that window opens with a default fresh tab in the user's home; other windows still restore. Never abort the whole session because one window is broken.

## The things that actually bite, in order

1. **State ownership audit.** Any top-level React context that assumes "the app has one focused pane" needs a per-window replacement. Global state (history search, embeddings, safety-gate ledger) stays global. Getting this boundary wrong shows up as one window seeing another window's state.
2. **IPC keying.** Every event today keyed on `pane_id` alone needs `window_id` in the address. Otherwise a resize in window A resizes the pane with the same id in window B (there won't *be* one — pane ids are unique — but the routing needs to know which frontend to deliver events to).
3. **Focus tracking.** "Active pane" is a per-window concept. "The active window" is a new global concept. The palette and the assistant target the active pane in the active window. When a window loses focus, its palette closes and its assistant dock loses keyboard focus (but stays open visually).
4. **Session-restore idempotence.** A user who kills the app during a session-write mid-flight comes back to a valid file or no file — never a half-written one. Write to a temp file then atomic-rename, same rule as any persistence surface.
5. **macOS menu-bar lifecycle.** The state machine for "no windows open but process alive" needs a place to route menu actions (`Cmd+N` opens a new window; `Cmd+Q` quits). The Tauri menu bar owns this; do not fake it with a hidden window.
6. **Session-restore for windows off-screen.** A window persisted at bounds that no longer fit any current display (external monitor unplugged) needs to snap to the primary display, not appear off-screen and orphaned.

## Interaction with existing surfaces

- **Palette (`14`).** Per-window. Opening `Cmd+Shift+P` in window A opens the palette in window A only. Commands target the active pane in that window.
- **Assistant dock (`09`).** Per-window. Each window has its own assistant conversation state. Auth (Claude subscription vs API key) is a global user setting; conversations are per-window.
- **Search (`05`).** Global. Search UI is per-window (each window opens its own search overlay), but the underlying index is shared and results reach across all windows and all history.
- **Safety gate (`10`).** The modal is per-window (it belongs to the window whose command triggered it). The classification policy and the record of approvals are global.
- **Community formatters and commands (`07`, `14`).** Unaffected — they run in Web Workers per-window as needed, but the on-disk sources under `~/.config/shax/` are one source of truth for all windows.

## Explicitly out of scope

- **Pane portability.** Dragging a pane out of window A into a new window B, or from window A into window B directly. Real work — PTY unbind/rebind, block-list ownership, layout-tree splicing across windows. Wait for demand; if it lands it's its own milestone.
- **Window groups / mission-control-style overview.** Nice-to-have for power users; not day-one.
- **"Warn on quit if a foreground process is running in any pane."** Called out in the roadmap candidate as a separate polish decision. Orthogonal to the lifecycle rules above.

## Cross-references

- `04-multiplexing.md` — layout model, PTY-per-pane, session-restore-per-tab. This spec extends that model one level up.
- `09-ai-assistant-and-auth.md` — assistant dock scope; per-window conversation state is a new addition on top of the existing dock model.
- `14-pane-commands.md` — palette is per-window.
- `10-safety-and-permissions.md` — safety-gate scope split (modal per-window, ledger global).
- `12-roadmap-milestones.md` — the M9 milestone entry once this spec lands moves the multi-window candidate into an active-milestone section.
