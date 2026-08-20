/**
 * App — top-level shell that owns the chrome (TitleBar, Statusline) and
 * orchestrates the open tab list, plus each tab's pane layout tree
 * (M2 slice 2.2a).
 *
 * Each tab carries:
 *   - `layout`        — the pane tree (Leaf / Split, see `panes/layout.ts`)
 *   - `focusedPaneId` — which pane in the tree currently owns focus
 *   - `panes`         — per-pane cwd / branch / alt-screen, keyed by paneId
 *
 * Background tabs (and all panes inside them) stay mounted in a hidden
 * wrapper so their PTYs keep running and their state stays in sync with
 * the shells. The TitleBar tab pills show the focused pane's cwd for
 * each tab. The Statusline mirrors the active tab's focused pane.
 *
 * Keyboard shortcuts:
 *   ⌘T              → new tab
 *   ⌘W              → close the focused pane (cascades to closing the
 *                     tab when it's the only pane, and to replacing the
 *                     last tab with a fresh shell so the window is never
 *                     empty)
 *   ⌘1 .. ⌘9        → jump to tab N by position
 *   ⌘⇧] / ⌘⇧[       → next / previous tab
 *   ⌘D              → split the focused pane side-by-side (new pane right)
 *   ⌘⇧D             → split the focused pane stacked (new pane below)
 *   ⌘] / ⌘[         → cycle focus across panes within the active tab
 *                     (⌘ is Cmd on macOS, Ctrl elsewhere)
 *
 * All tab transitions live in a single pure reducer.
 */

import "./App.css";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { TitleBar } from "./panes/TitleBar";
import type { TabDescriptor } from "./panes/TitleBar";
import { Statusline } from "./panes/Statusline";
import { LayoutRender } from "./panes/LayoutRender";
import { SearchOverlay } from "./panes/SearchOverlay";
import { PaletteOverlay } from "./palette/PaletteOverlay";
import "./palette/builtins/echoHello";
import "./palette/builtins/cd";
import "./palette/builtins/git";
import "./palette/builtins/newWindow";
import "./palette/builtins/reload";
import "./palette/builtins/sidebar";
import { registerPaneCommand as _registerPaneCommand } from "./palette/registry";
import { mkdirSandboxCommand } from "./palette/sandbox/samples/mkdir";
import { loadCommunityCommands } from "./palette/sandbox/loader";
_registerPaneCommand(mkdirSandboxCommand);
import { SafetyGate } from "./safetyGate/SafetyGate";
import { Sidebar } from "./sidebar/Sidebar";
import { AssistantDockDivider } from "./assistant/AssistantDockDivider";
import { AssistantOverlay } from "./assistant/AssistantOverlay";
import { SettingsModal } from "./settings/SettingsModal";
import { applyTheme } from "./theme/theme";
import {
  DEFAULT_ASSISTANT_DOCK_WIDTH,
  loadPreferences,
  savePreferences,
} from "./theme/preferences";
import { listThemes, type Theme } from "./lib/ipc";
import { BlockViewerModal } from "./viewer";
import type { BlockSummary, PtyId } from "./lib/ipc";
import type { LayoutNode, PaneId, SplitDirection, SplitPath } from "./panes/layout";
import {
  cycleFocus,
  leaf,
  leafIds,
  neighborAfterClose,
  removeLeaf,
  setRatio,
  splitLeaf,
} from "./panes/layout";
import { AssistantDockProvider } from "./lib/AssistantDockContext";
import { ClockProvider } from "./lib/ClockContext";
import { FocusedPaneProvider, type FocusedPaneMeta } from "./lib/FocusedPaneContext";
import { HomeDirProvider } from "./lib/HomeDirContext";
import { NetworkProvider, type NetworkInfo } from "./lib/NetworkContext";
import { SystemLoadProvider } from "./lib/SystemLoadContext";
import {
  appStateLoad,
  appStateSave,
  closeWindowConfirmed,
  homeDir,
  openNewWindow,
  ptyRunningCommands,
  quitConfirmed,
  systemBattery,
  systemLoadSeries,
  systemLocalIp,
  netInterfaces,
  onSystemLoad,
  type BatteryStatus,
  type NetInterface,
  type SystemLoadSeries,
} from "./lib/ipc";
import { useWindowId } from "./lib/useWindowId";
import { compactCwd } from "./panes/blockFormat";
import { ConfirmCloseModal, type ConfirmCloseVerb } from "./panes/ConfirmCloseModal";
import { loadCommunityFormatters } from "./formatters";

interface PaneMeta {
  cwd: string | null;
  branch: string | null;
  /** Commits ahead of upstream. Populated from OSC 133 A alongside
   *  branch (M12.4). Lifted up to App scope in M13.2 so the sidebar
   *  GitBranchWidget can render `↑n ↓n` — previously stranded in
   *  `TerminalPane.promptMeta`. */
  ahead: number | null;
  /** Commits behind upstream. Same source and same lift as `ahead`. */
  behind: number | null;
  altScreen: boolean;
  /**
   * Backend pty id assigned by `spawnPty`, populated once the spawn
   * resolves. Stays `null` until then and after the shell exits. The
   * search overlay's "jump to pane" path scans this across every tab
   * to map a search hit's `pane_id` back to a live (tab, pane).
   */
  ptyId: string | null;
}

interface TabState {
  id: string;
  label: string;
  layout: LayoutNode;
  focusedPaneId: PaneId;
  panes: Record<PaneId, PaneMeta>;
}

interface TabsState {
  tabs: TabState[];
  activeId: string;
}

type TabsAction =
  | { type: "add_tab" }
  | { type: "close_focused_pane"; tabId: string }
  | { type: "close_tab"; id: string }
  | { type: "switch_tab"; id: string }
  | { type: "switch_tab_by_index"; index: number }
  | { type: "cycle_tab"; direction: 1 | -1 }
  | { type: "split"; tabId: string; direction: SplitDirection }
  | { type: "focus_pane"; tabId: string; paneId: PaneId }
  | { type: "cycle_focus"; tabId: string; direction: 1 | -1 }
  | {
      type: "update_meta";
      tabId: string;
      paneId: PaneId;
      cwd: string | null;
      branch: string | null;
      ahead: number | null;
      behind: number | null;
    }
  | { type: "update_alt_screen"; tabId: string; paneId: PaneId; altScreen: boolean }
  | { type: "update_pty_id"; tabId: string; paneId: PaneId; ptyId: string | null }
  | { type: "set_ratio"; tabId: string; path: SplitPath; ratio: number }
  | { type: "hydrate"; state: TabsState };

function freshId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}

function freshPaneId(): PaneId {
  return freshId("pane-");
}

function freshTabId(): string {
  return freshId("tab-");
}

function freshPaneMeta(): PaneMeta {
  return { cwd: null, branch: null, ahead: null, behind: null, altScreen: false, ptyId: null };
}

/**
 * Scan every tab's pane map for one whose backend ptyId matches the
 * given hit. Returns the addressing pair, or null when no live pane
 * carries that PTY (closed pane, previous session, etc.). Linear in
 * the total pane count but the tab/pane count stays in the dozens —
 * we don't need an index for this.
 */
function findPaneByPtyId(
  tabs: TabState[],
  ptyId: string,
): { tabId: string; paneId: PaneId } | null {
  for (const tab of tabs) {
    for (const [paneId, meta] of Object.entries(tab.panes)) {
      if (meta.ptyId === ptyId) return { tabId: tab.id, paneId };
    }
  }
  return null;
}

function makeTab(): TabState {
  const paneId = freshPaneId();
  return {
    id: freshTabId(),
    label: "shax",
    layout: leaf(paneId),
    focusedPaneId: paneId,
    panes: { [paneId]: freshPaneMeta() },
  };
}

function replaceTab(state: TabsState, id: string, mapper: (t: TabState) => TabState): TabsState {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (t.id !== id) return t;
    const next = mapper(t);
    if (next !== t) changed = true;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

function closeTab(state: TabsState, id: string): TabsState {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return state;
  if (state.tabs.length === 1) {
    // Window never empty: fresh single tab.
    return { tabs: [makeTab()], activeId: "" }; // activeId filled in below
  }
  const tabs = state.tabs.filter((t) => t.id !== id);
  let activeId = state.activeId;
  if (id === state.activeId) {
    const neighborIdx = idx === 0 ? 0 : idx - 1;
    activeId = tabs[neighborIdx]?.id ?? activeId;
  }
  return { tabs, activeId };
}

function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "add_tab": {
      const fresh = makeTab();
      return { tabs: [...state.tabs, fresh], activeId: fresh.id };
    }

    case "close_tab": {
      const next = closeTab(state, action.id);
      // The single-tab branch leaves activeId === "" as a sentinel for us
      // to fill in here with the fresh tab's id.
      if (next.activeId === "" && next.tabs[0] !== undefined) {
        return { ...next, activeId: next.tabs[0].id };
      }
      return next;
    }

    case "close_focused_pane": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (tab === undefined) return state;
      // Single-pane tab → fall through to close_tab semantics.
      if (tab.layout.kind === "leaf") {
        return tabsReducer(state, { type: "close_tab", id: tab.id });
      }
      const nextLayout = removeLeaf(tab.layout, tab.focusedPaneId);
      if (nextLayout === null) {
        // Should be unreachable (kind !== 'leaf' guarantees > 1 leaf).
        return tabsReducer(state, { type: "close_tab", id: tab.id });
      }
      const nextFocus = neighborAfterClose(tab.layout, tab.focusedPaneId);
      if (nextFocus === null) return state;
      const { [tab.focusedPaneId]: _gone, ...remainingPanes } = tab.panes;
      void _gone;
      const nextTab: TabState = {
        ...tab,
        layout: nextLayout,
        focusedPaneId: nextFocus,
        panes: remainingPanes,
      };
      return { ...state, tabs: state.tabs.map((t) => (t.id === tab.id ? nextTab : t)) };
    }

    case "switch_tab": {
      if (action.id === state.activeId) return state;
      if (state.tabs.some((t) => t.id === action.id)) {
        return { ...state, activeId: action.id };
      }
      return state;
    }

    case "switch_tab_by_index": {
      const target = state.tabs[action.index];
      if (target === undefined || target.id === state.activeId) return state;
      return { ...state, activeId: target.id };
    }

    case "cycle_tab": {
      const i = state.tabs.findIndex((t) => t.id === state.activeId);
      if (i === -1 || state.tabs.length === 0) return state;
      const nextIdx = (i + action.direction + state.tabs.length) % state.tabs.length;
      const next = state.tabs[nextIdx];
      if (next === undefined || next.id === state.activeId) return state;
      return { ...state, activeId: next.id };
    }

    case "split": {
      return replaceTab(state, action.tabId, (tab) => {
        const newPaneId = freshPaneId();
        return {
          ...tab,
          layout: splitLeaf(tab.layout, tab.focusedPaneId, newPaneId, action.direction),
          focusedPaneId: newPaneId,
          panes: { ...tab.panes, [newPaneId]: freshPaneMeta() },
        };
      });
    }

    case "focus_pane": {
      return replaceTab(state, action.tabId, (tab) => {
        if (tab.focusedPaneId === action.paneId) return tab;
        // Defensive: only allow focusing a pane that's actually in the tree.
        if (!leafIds(tab.layout).includes(action.paneId)) return tab;
        return { ...tab, focusedPaneId: action.paneId };
      });
    }

    case "cycle_focus": {
      return replaceTab(state, action.tabId, (tab) => {
        const next = cycleFocus(tab.layout, tab.focusedPaneId, action.direction);
        if (next === tab.focusedPaneId) return tab;
        return { ...tab, focusedPaneId: next };
      });
    }

    case "update_meta": {
      return replaceTab(state, action.tabId, (tab) => {
        const current = tab.panes[action.paneId];
        if (current === undefined) return tab;
        if (
          current.cwd === action.cwd &&
          current.branch === action.branch &&
          current.ahead === action.ahead &&
          current.behind === action.behind
        ) {
          return tab;
        }
        return {
          ...tab,
          panes: {
            ...tab.panes,
            [action.paneId]: {
              ...current,
              cwd: action.cwd,
              branch: action.branch,
              ahead: action.ahead,
              behind: action.behind,
            },
          },
        };
      });
    }

    case "update_alt_screen": {
      return replaceTab(state, action.tabId, (tab) => {
        const current = tab.panes[action.paneId];
        if (current === undefined) return tab;
        if (current.altScreen === action.altScreen) return tab;
        return {
          ...tab,
          panes: { ...tab.panes, [action.paneId]: { ...current, altScreen: action.altScreen } },
        };
      });
    }

    case "update_pty_id": {
      return replaceTab(state, action.tabId, (tab) => {
        const current = tab.panes[action.paneId];
        if (current === undefined) return tab;
        if (current.ptyId === action.ptyId) return tab;
        return {
          ...tab,
          panes: { ...tab.panes, [action.paneId]: { ...current, ptyId: action.ptyId } },
        };
      });
    }

    case "set_ratio": {
      return replaceTab(state, action.tabId, (tab) => {
        const layout = setRatio(tab.layout, action.path, action.ratio);
        if (layout === tab.layout) return tab;
        return { ...tab, layout };
      });
    }

    case "hydrate":
      // Replace the entire tab state with a previously-persisted snapshot.
      // Used once on mount when the backend reports a saved app-state JSON.
      return action.state;
  }
}

function initialState(): TabsState {
  const first = makeTab();
  return { tabs: [first], activeId: first.id };
}

// ── Persistence ─────────────────────────────────────────────────────────────
//
// The shape we write to disk is intentionally smaller than `TabsState`:
// `altScreen` is transient (it'll be re-derived from the next OSC 1049
// the shell emits), so we drop it. Layout, focus, cwd, and branch are
// kept so the restored chrome feels continuous.

interface PersistedPane {
  cwd: string | null;
  branch: string | null;
}

interface PersistedTab {
  id: string;
  label: string;
  layout: LayoutNode;
  focusedPaneId: PaneId;
  panes: Record<PaneId, PersistedPane>;
}

/** Per-window sidebar preferences (M13.1, spec §19 D3). Persisted
 *  inside the per-window `tabs_json` blob so each window carries
 *  its own state. Both fields optional in the on-disk shape so
 *  older serialised state (pre-M13) deserialises cleanly with the
 *  first-run defaults. */
interface SidebarPreferences {
  visible: boolean;
}

const DEFAULT_SIDEBAR: SidebarPreferences = {
  visible: false, // First-run default: icon rail (spec §19 D2).
};

interface PersistedAppState {
  tabs: PersistedTab[];
  activeId: string;
  sidebar?: Partial<SidebarPreferences>;
}

function serialiseState(state: TabsState, sidebar: SidebarPreferences): string {
  const persistable: PersistedAppState = {
    tabs: state.tabs.map((t) => ({
      id: t.id,
      label: t.label,
      layout: t.layout,
      focusedPaneId: t.focusedPaneId,
      panes: Object.fromEntries(
        Object.entries(t.panes).map(([id, meta]) => [id, { cwd: meta.cwd, branch: meta.branch }]),
      ),
    })),
    activeId: state.activeId,
    sidebar,
  };
  return JSON.stringify(persistable);
}

/** Extract `{paneId: {cwd, branch}}` from a tab's pane state.
 *  Passed to LayoutRender → PaneLeaf → TerminalPane so restored
 *  panes:
 *    - respawn their shell in the persisted cwd (via SpawnOpts.cwd)
 *    - render the persisted branch label in the prompt strip
 *      from the very first paint, not after the first `git`
 *      command or OSC 133 A round-trip.
 *
 *  Only the first mount per pane reads either value — subsequent
 *  updates are ignored by TerminalPane and excluded from
 *  `paneLeafEqual` in LayoutRender. */
function panePaneMeta(
  tab: TabState,
): Record<PaneId, { cwd: string | null; branch: string | null }> {
  return Object.fromEntries(
    Object.entries(tab.panes).map(([id, meta]) => [id, { cwd: meta.cwd, branch: meta.branch }]),
  );
}

interface HydratedState {
  state: TabsState;
  sidebar: SidebarPreferences;
}

function hydrateFromJson(json: string): HydratedState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<PersistedAppState>;
  if (!Array.isArray(candidate.tabs) || candidate.tabs.length === 0) return null;
  const tabs: TabState[] = [];
  for (const t of candidate.tabs) {
    if (
      typeof t !== "object" ||
      t === null ||
      typeof t.id !== "string" ||
      typeof t.focusedPaneId !== "string" ||
      typeof t.label !== "string" ||
      typeof t.layout !== "object" ||
      t.layout === null ||
      typeof t.panes !== "object" ||
      t.panes === null
    ) {
      return null;
    }
    const panes: Record<PaneId, PaneMeta> = {};
    for (const [paneId, meta] of Object.entries(t.panes)) {
      panes[paneId] = {
        cwd: meta?.cwd ?? null,
        branch: meta?.branch ?? null,
        // ahead / behind are transient — the first OSC 133 A after
        // the shell restarts repopulates them. Never persisted.
        ahead: null,
        behind: null,
        altScreen: false,
        // ptyId only becomes known after spawn resolves; restored panes
        // get fresh shells, so leave this null until then.
        ptyId: null,
      };
    }
    tabs.push({
      id: t.id,
      label: t.label,
      layout: t.layout,
      focusedPaneId: t.focusedPaneId,
      panes,
    });
  }
  const activeId =
    typeof candidate.activeId === "string" && tabs.some((t) => t.id === candidate.activeId)
      ? candidate.activeId
      : (tabs[0]?.id ?? "");
  // Sidebar prefs are optional on the wire; missing fields fall back
  // to DEFAULT_SIDEBAR so pre-M13 blobs deserialise cleanly.
  const sidebar: SidebarPreferences = {
    visible: candidate.sidebar?.visible ?? DEFAULT_SIDEBAR.visible,
  };
  return { state: { tabs, activeId }, sidebar };
}

export default function App(): React.ReactElement {
  const [state, dispatch] = useReducer(tabsReducer, undefined, initialState);
  const { tabs, activeId } = state;

  // Whether this React root is running in the primary Shax window
  // (label `"main"`) or a spawned one (label `"w-<uuid>"`). Some
  // preferences (assistant dock open/width) live on the "main"
  // window only — spawned windows default to closed and don't
  // overwrite the persisted state. See specs/15-multi-window.md.
  const windowLabel = useWindowId();
  const isMainWindow = windowLabel === "main";
  // Ref for use inside the once-only event-listener useEffect
  // below — the label is stable across renders, but capturing
  // the string value directly in the effect closure means an
  // eslint-plugin-react-hooks exhaustive-deps complaint, and
  // adding it to deps re-registers listeners needlessly.
  const windowLabelRef = useRef(windowLabel);
  windowLabelRef.current = windowLabel;

  // Search overlay. Top-level so the keybindings can open it regardless
  // of which pane currently owns focus.
  const [searchOpen, setSearchOpen] = useState(false);
  // Command palette (M8.1). ⌘⇧P toggles. Chrome, not per-pane —
  // one open at a time, same lifecycle rules as the search overlay.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Block viewer modal target (M4 slice 4.1). Driven by a window-level
  // `shax:open-viewer` event so BlockRow doesn't need a deep prop chain.
  // `pty` is null when the block originated in a pane that's no longer
  // alive — the modal then fetches by block id from the store.
  const [viewerTarget, setViewerTarget] = useState<{
    pty: PtyId | null;
    block: BlockSummary;
  } | null>(null);

  // Settings modal open state (Cmd/Ctrl + `,` toggles). One
  // instance mounted at the App root when open; closes via
  // Escape, backdrop click, or the close button.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Sidebar visibility (M13.1, spec §19). `false` renders the 44px
  // icon rail (first-run default per spec §D2); `true` renders the
  // 280px expanded state. Per-window — each window carries its own
  // value inside the `tabs_json` blob (see PersistedAppState.sidebar).
  const [sidebarVisible, setSidebarVisible] = useState(DEFAULT_SIDEBAR.visible);

  // Assistant chat overlay (M6 slice 4). Cmd/Ctrl + K toggles;
  // Escape or the close button dismisses. A seeded prompt
  // arrives via `shax:assistant-ask` from the explain-on-error
  // button on failed blocks.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantSeed, setAssistantSeed] = useState<string | null>(null);

  // M7.7a: the assistant panel now lives as a docked right-side column
  // inside `<main>` instead of a fixed overlay. `assistantWidth` is the
  // column's pixel width; persisted via preferences.json across launches.
  // Ref-mirrored so a mid-drag `onResize` writes without cascading
  // renders through the whole tab tree — we snap the DOM width via
  // style inline and only setState on drag commit.
  const [assistantWidth, setAssistantWidth] = useState<number>(DEFAULT_ASSISTANT_DOCK_WIDTH);
  const tabHostRef = useRef<HTMLElement>(null);
  // M7.7b: count of assistant tool calls pending user approval,
  // published by SafetyGate on every open / close. Drives the
  // "⚠ N approval pending" indicator in the statusline.
  const [approvalsPending, setApprovalsPending] = useState(0);
  useEffect(() => {
    const onPending = (e: Event): void => {
      const detail = (e as CustomEvent<{ count?: number }>).detail;
      setApprovalsPending(detail?.count ?? 0);
    };
    window.addEventListener("shax:approvals-pending", onPending);
    return () => window.removeEventListener("shax:approvals-pending", onPending);
  }, []);

  // M9.6: close-confirmation modal. Non-null when a close action
  // needs the user to confirm because it would kill a running
  // foreground command. See ConfirmCloseModal + the
  // `confirmThenClose*` helpers below.
  const [pendingClose, setPendingClose] = useState<{
    verb: ConfirmCloseVerb;
    count: number;
    onConfirm: () => void;
  } | null>(null);

  // Live tabs-state ref so the async confirmThenClose* helpers
  // read the current tab set without capturing stale closures.
  const tabsStateRef = useRef(state);
  tabsStateRef.current = state;

  /** M9.6: close the focused pane, showing the warning modal if
   *  it would kill a running non-alt-screen command. All ⌘W /
   *  close-pane call sites go through here so behaviour stays
   *  consistent regardless of trigger. */
  const confirmThenClosePane = useCallback(async (tabId: string): Promise<void> => {
    const tab = tabsStateRef.current.tabs.find((t) => t.id === tabId);
    const doClose = (): void => {
      dispatch({ type: "close_focused_pane", tabId });
    };
    const ptyId = tab?.panes[tab.focusedPaneId]?.ptyId ?? null;
    if (ptyId === null) {
      doClose();
      return;
    }
    const running = await ptyRunningCommands();
    if (!running.includes(ptyId)) {
      doClose();
      return;
    }
    setPendingClose({ verb: "pane", count: 1, onConfirm: doClose });
  }, []);

  /** M9.6: close a whole tab, showing the warning modal for the
   *  aggregate count of running commands across all its panes. */
  const confirmThenCloseTab = useCallback(async (tabId: string): Promise<void> => {
    const tab = tabsStateRef.current.tabs.find((t) => t.id === tabId);
    const doClose = (): void => {
      dispatch({ type: "close_tab", id: tabId });
    };
    if (tab === undefined) {
      doClose();
      return;
    }
    const paneIds: string[] = Object.values(tab.panes)
      .map((p) => p.ptyId)
      .filter((id): id is string => id !== null);
    if (paneIds.length === 0) {
      doClose();
      return;
    }
    const running = await ptyRunningCommands();
    const runningHere = paneIds.filter((id) => running.includes(id)).length;
    if (runningHere === 0) {
      doClose();
      return;
    }
    setPendingClose({ verb: "tab", count: runningHere, onConfirm: doClose });
  }, []);

  // M9.4: macOS app menu items whose action lives on the frontend
  // side arrive as Tauri events (backend → this webview). Bridge
  // them to the same reducer / setter paths the ⌘T / ⌘W / ⌘,
  // keydown handlers already use. On non-macOS builds no menu is
  // attached so these listeners never fire, but the setup is
  // cheap and harmless. See src-tauri/src/menu.rs::EVENT_MENU_*.
  //
  // Skipped entirely outside a Tauri context — `listen()` calls
  // into `__TAURI_INTERNALS__` which doesn't exist in jsdom.
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      unlisteners.push(
        await listen("shax:menu-new-tab", () => {
          dispatch({ type: "add_tab" });
        }),
        await listen("shax:menu-close-tab", () => {
          void confirmThenClosePane(activeIdRef.current);
        }),
        await listen("shax:menu-open-preferences", () => {
          setSettingsOpen((prev) => !prev);
        }),
        // M9.6: backend intercepted a window close because this
        // window owns panes with running commands. Show the
        // modal; on confirm, call closeWindowConfirmed which
        // sets the bypass flag and re-invokes the close.
        //
        // `target` is critical here — without it, `listen()`
        // subscribes to events targeted at ANY listener, and the
        // backend's `emit_to(EventTarget::WebviewWindow{label})`
        // still lands in every window's handler. Scoping the
        // subscription by label matches the emit target and keeps
        // the modal in the one closing/quitting window.
        await listen<{ count: number }>(
          "shax:confirm-close-window",
          (event) => {
            const count = event.payload.count ?? 0;
            setPendingClose({
              verb: "window",
              count,
              onConfirm: () => {
                void closeWindowConfirmed(windowLabelRef.current);
              },
            });
          },
          { target: { kind: "WebviewWindow", label: windowLabelRef.current } },
        ),
        // M9.6: backend intercepted an app quit for the same
        // reason. Same flow, different scope + IPC.
        await listen<{ count: number }>(
          "shax:confirm-quit",
          (event) => {
            const count = event.payload.count ?? 0;
            setPendingClose({
              verb: "app",
              count,
              onConfirm: () => {
                void quitConfirmed();
              },
            });
          },
          { target: { kind: "WebviewWindow", label: windowLabelRef.current } },
        ),
      );
    })();
    return () => {
      cancelled = true;
      for (const off of unlisteners) off();
    };
    // confirmThenClosePane is a stable useCallback ([]) so
    // including it here doesn't cause the effect to re-register;
    // the dep silences react-hooks/exhaustive-deps.
  }, [confirmThenClosePane]);
  // M12.1: statusline modal indicator. Three surfaces feed the pill:
  //
  //   - `CHAT` — the assistant textarea owns focus. AssistantOverlay
  //     publishes `shax:assistant-input-focus` on focus / blur.
  //   - `BLOCK` — the active pane is in block-focus mode.
  //     TerminalPane publishes `shax:block-focus-changed` whenever
  //     the active pane's block-focus toggles or it becomes active.
  //   - `COMMAND` — default. The prompt strip owns focus.
  //
  // Precedence: CHAT > BLOCK > COMMAND. Typing to the assistant
  // always wins over block-focus (which is orthogonal — you can be
  // in block-focus in the pane behind the assistant dock).
  const [assistantInputFocused, setAssistantInputFocused] = useState(false);
  const [activePaneInBlockFocus, setActivePaneInBlockFocus] = useState(false);
  // M12.2: the active pane's vi keymap (viins / vicmd / visual /
  // main / emacs). Non-null only when the user picked Vi and the
  // shim has emitted at least one OSC 133;M. Drives the pill's
  // sub-chip alongside COMMAND.
  const [activePaneViKeymap, setActivePaneViKeymap] = useState<string | null>(null);
  // M12.4: the active pane's session identity, fed by the shim's
  // OSC 133 A `user=` / `host=` params. Session-constant locally so
  // this rarely changes, but pane-scoped for the future
  // SSH-through-Shax case where a remote OSC 133 emitter might
  // surface a different identity per pane.
  const [activePaneIdentity, setActivePaneIdentity] = useState<{
    user: string | null;
    host: string | null;
  }>({ user: null, host: null });
  useEffect(() => {
    const onFocus = (e: Event): void => {
      const detail = (e as CustomEvent<{ focused?: boolean }>).detail;
      setAssistantInputFocused(detail?.focused === true);
    };
    const onBlockFocus = (e: Event): void => {
      const detail = (e as CustomEvent<{ blockFocus?: boolean }>).detail;
      setActivePaneInBlockFocus(detail?.blockFocus === true);
    };
    const onViKeymap = (e: Event): void => {
      const detail = (e as CustomEvent<{ keymap?: string | null }>).detail;
      setActivePaneViKeymap(detail?.keymap ?? null);
    };
    const onIdentity = (e: Event): void => {
      const detail = (e as CustomEvent<{ user?: string | null; host?: string | null }>).detail;
      setActivePaneIdentity({
        user: detail?.user ?? null,
        host: detail?.host ?? null,
      });
    };
    window.addEventListener("shax:assistant-input-focus", onFocus);
    window.addEventListener("shax:block-focus-changed", onBlockFocus);
    window.addEventListener("shax:vi-keymap-changed", onViKeymap);
    window.addEventListener("shax:prompt-identity-changed", onIdentity);
    return () => {
      window.removeEventListener("shax:assistant-input-focus", onFocus);
      window.removeEventListener("shax:block-focus-changed", onBlockFocus);
      window.removeEventListener("shax:vi-keymap-changed", onViKeymap);
      window.removeEventListener("shax:prompt-identity-changed", onIdentity);
    };
  }, []);
  // Closing the dock unmounts the textarea; the browser usually
  // fires blur on unmount but we clamp here so a race can't leave
  // the pill stuck on CHAT after the panel is gone.
  useEffect(() => {
    if (!assistantOpen) setAssistantInputFocused(false);
  }, [assistantOpen]);

  // M12.4: single App-level 1s clock tick for the statusline. Per-pane
  // intervals would multiply by pane count — the clock reads the same
  // time everywhere, so one interval at the app root is the right
  // scaling. Updates a `Date` in state; the two derived strings
  // (`HH:MM:SS` and the tooltip date) get formatted at render time so
  // a locale change would be picked up on the next tick without
  // needing to re-derive here.
  const [clockNow, setClockNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const handle = window.setInterval(() => setClockNow(new Date()), 1000);
    return () => window.clearInterval(handle);
  }, []);
  const clockLabel = useMemo(
    () =>
      clockNow.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
    [clockNow],
  );
  const clockTooltip = useMemo(
    () =>
      clockNow.toLocaleDateString([], {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    [clockNow],
  );

  // M12.4b: statusbar native probes (battery + local IP). Polled at
  // 30s per the spec — both values change slowly (battery percentage
  // ticks minutes at a time; IP only changes on network transitions),
  // so per-second polling would be waste. Both probes fail-soft: a
  // failing battery probe returns the desktop sentinel, a failing IP
  // probe returns null; the statusbar handles both cases gracefully.
  const [batteryStatus, setBatteryStatus] = useState<BatteryStatus>({
    present: false,
    percent: null,
    on_ac_power: false,
    charging: false,
  });
  const [localIp, setLocalIp] = useState<string | null>(null);
  // M13 refinement: the whole addressed-interface list, refreshed on
  // the slow tier. Descriptive fields only — throughput is a delta
  // and rides the 2s sampler instead (spec §19 D5 item 3).
  const [interfaces, setInterfaces] = useState<NetInterface[]>([]);
  useEffect(() => {
    let cancelled = false;
    // Fire an immediate probe on mount so the chips populate within
    // milliseconds instead of waiting 30s for the first tick. M13.3
    // folds the SSID probe into this same 30s interval — same cadence
    // as the other network / battery signals.
    const poll = (): void => {
      void systemBattery().then((b) => {
        if (!cancelled) setBatteryStatus(b);
      });
      void systemLocalIp().then((ip) => {
        if (!cancelled) setLocalIp(ip);
      });
      void netInterfaces().then((list) => {
        if (!cancelled) setInterfaces(list);
      });
    };
    poll();
    const handle = window.setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);
  // M13.3 CPU + memory, reworked in the M13 refinement pass. There is
  // deliberately no interval here: the backend samples on one fixed
  // cadence and broadcasts, because CPU usage is a delta between
  // refreshes and per-window polling made each window's reading
  // depend on when the *others* last refreshed. Read once on mount
  // for a window joining mid-stream, then follow the broadcast.
  const [systemLoad, setSystemLoad] = useState<SystemLoadSeries>({
    current: {
      cpu_percent: 0,
      mem_used_bytes: 0,
      mem_total_bytes: 0,
      load_average_one: null,
      core_count: null,
    },
    net_rates: [],
    history: [],
  });
  useEffect(() => {
    let cancelled = false;
    void systemLoadSeries().then((series) => {
      if (!cancelled) setSystemLoad(series);
    });
    const unsubscribe = onSystemLoad(setSystemLoad);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  // Guard so the persistence effect doesn't overwrite stored prefs with
  // the default state during App's first render (before loadPreferences
  // resolves). Flipped inside the boot loader below.
  const prefsLoadedRef = useRef(false);

  // User's home directory, fetched once at boot. Used by
  // `compactCwd()` to display `~/dev/shax` instead of
  // `/Users/ada/dev/shax` in the tab chip, prompt strip, and
  // statusline (M7.6). `null` until the boot probe resolves —
  // during that window the full path is rendered.
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    void homeDir().then((h) => setHome(h));
  }, []);
  useEffect(() => {
    const onAsk = (e: Event): void => {
      const detail = (e as CustomEvent<{ prompt: string }>).detail;
      if (detail === null || detail === undefined) return;
      setAssistantSeed(detail.prompt);
      setAssistantOpen(true);
    };
    // `shax:assistant-open` — used by the M7.6 `?`-first-char handler
    // in PromptStrip and the M12.1 onboarding chip. Just toggles the
    // overlay open without a seeded prompt; the user then types their
    // question.
    const onOpen = (): void => {
      setAssistantOpen(true);
    };
    // M12.1: `shax:search-open` / `shax:settings-open` — click event
    // buses so surfaces like the empty-state onboarding chips can
    // trigger the same effect as ⌘F / ⌘,. The keybindings above
    // handle the keyboard path; these handlers route the mouse path
    // to the same state without duplicating the toggle logic.
    const onOpenSearch = (): void => {
      setSearchOpen(true);
    };
    const onOpenSettings = (): void => {
      setSettingsOpen(true);
    };
    // M13.1: `shax:toggle-sidebar` — dispatched by the palette
    // command "Sidebar: expand / collapse". Same effect as ⌘B and
    // the sidebar's chevron button.
    const onToggleSidebar = (): void => {
      setSidebarVisible((prev) => !prev);
    };
    window.addEventListener("shax:assistant-ask", onAsk);
    window.addEventListener("shax:assistant-open", onOpen);
    window.addEventListener("shax:search-open", onOpenSearch);
    window.addEventListener("shax:settings-open", onOpenSettings);
    window.addEventListener("shax:toggle-sidebar", onToggleSidebar);
    return () => {
      window.removeEventListener("shax:assistant-ask", onAsk);
      window.removeEventListener("shax:assistant-open", onOpen);
      window.removeEventListener("shax:search-open", onOpenSearch);
      window.removeEventListener("shax:settings-open", onOpenSettings);
      window.removeEventListener("shax:toggle-sidebar", onToggleSidebar);
    };
  }, []);

  // Apply the persisted theme preference on mount. M10.2:
  // `applyTheme` now takes the full preferences plus the
  // theme catalog so it can resolve the active preset and
  // write its palette as CSS custom properties. The
  // `data-theme` attribute stays set for legacy selectors.
  // A `shax:preference-changed` event lets the settings
  // modal notify the App when anything appearance-related
  // flips; the handler re-loads preferences and re-applies.
  useEffect(() => {
    // Load both in parallel — the catalog is cached for the
    // session after the first call. Ordering doesn't matter;
    // we need both before applyTheme can resolve a preset.
    void Promise.all([loadPreferences(), listThemes()]).then(
      ([prefs, catalog]: [Awaited<ReturnType<typeof loadPreferences>>, Theme[]]) => {
        applyTheme(prefs, catalog);
        // M7.7a: restore the docked state from the last save so the user
        // lands back in whatever configuration they had. Both fields
        // default to safe values in preferences.ts, so a fresh install
        // opens with the dock closed and default width.
        //
        // M9.3 refinement: only the "main" window hydrates the dock
        // open/closed state from global preferences. Spawned windows
        // always start with the dock closed, matching the user's
        // expectation that new windows are a fresh workspace and don't
        // inherit the sibling window's runtime state (spec §15). The
        // width still hydrates from the global default so the first
        // time the user opens the dock in a spawned window it matches
        // their preferred size.
        if (isMainWindow) {
          setAssistantOpen(prefs.assistant_docked);
        }
        setAssistantWidth(prefs.assistant_dock_width);
        prefsLoadedRef.current = true;
        // M10.5: notify every consumer that reads preferences
        // (TerminalPane, Viewer, AssistantOverlay) so they
        // pick up the persisted appearance on cold boot too —
        // otherwise xterm keeps its default 13 px font after a
        // restart even though the user's saved size is 18. On
        // subsequent preference changes the SettingsModal
        // fires this same event.
        window.dispatchEvent(
          new CustomEvent("shax:preference-changed", { detail: { appearance: prefs.appearance } }),
        );
      },
    );
    // Re-apply on any preference change — reads fresh
    // preferences so a theme flip, a preset swap, or a
    // font tweak (M10.3) all funnel through the same path.
    // `listThemes` is cached, so this is one IPC call max
    // (the preferences read).
    const onChanged = (): void => {
      void Promise.all([loadPreferences(), listThemes()]).then(([prefs, catalog]) => {
        applyTheme(prefs, catalog);
      });
    };
    window.addEventListener("shax:preference-changed", onChanged);
    return () => window.removeEventListener("shax:preference-changed", onChanged);
  }, [isMainWindow]);

  // M7.7a: persist docked open/closed state + width whenever they
  // change. `savePreferences` accepts a partial and merges with the
  // stored value, so we don't have to carry the theme along here —
  // the settings modal owns that field and writes it independently.
  // No debounce needed: `assistantOpen` flips on user click,
  // `assistantWidth` only updates on drag commit (mid-drag re-renders
  // update DOM style but not this state).
  //
  // M9.3 refinement: only the "main" window persists these fields.
  // If a spawned window wrote here, it would clobber the main
  // window's saved state on every dock toggle (last-writer-wins
  // race). Spawned-window dock changes are session-only until we
  // grow per-window persistence in a follow-up (window_state blob
  // gains a dockState field).
  useEffect(() => {
    // Skip until the boot loader has resolved — otherwise we'd
    // overwrite stored prefs with the initial defaults.
    if (!prefsLoadedRef.current) return;
    if (!isMainWindow) return;
    void savePreferences({
      assistant_docked: assistantOpen,
      assistant_dock_width: assistantWidth,
    });
  }, [assistantOpen, assistantWidth, isMainWindow]);

  // When an overlay (search, viewer) closes, the focus that briefly
  // landed in its input / button is gone — nothing else is focused, so
  // the user can't type into their shell again until they click the
  // pane. Fire a window-level event the active TerminalPane listens
  // for to re-claim focus on its prompt strip (or xterm under
  // alt-screen). Using an event keeps this a one-shot — no per-pane
  // prop drilling for transient chrome state.
  const refocusActivePane = useCallback((): void => {
    window.dispatchEvent(new CustomEvent("shax:refocus-pane"));
  }, []);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // Ref so the capture-phase keydown handler can read the latest
  // viewer-open state without re-registering on every render. The
  // handler skips ⌘F when the viewer is open so the editor's own
  // in-buffer search keymap (from @codemirror/search) handles it.
  const viewerOpenRef = useRef(false);
  viewerOpenRef.current = viewerTarget !== null;
  // Mirror assistant open + input-focus state so the capture-phase
  // ⌘K handler (registered with [] deps for stability) can read the
  // latest values (M7.7c).
  const assistantOpenRef = useRef(assistantOpen);
  assistantOpenRef.current = assistantOpen;
  const assistantInputFocusedRef = useRef(assistantInputFocused);
  assistantInputFocusedRef.current = assistantInputFocused;

  const handleNew = useCallback((): void => {
    dispatch({ type: "add_tab" });
  }, []);

  const handleCloseTab = useCallback(
    (id: string): void => {
      void confirmThenCloseTab(id);
    },
    // confirmThenCloseTab is declared earlier and stable
    // (useCallback with []), so this dep never fires re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleSwitch = useCallback((id: string): void => {
    dispatch({ type: "switch_tab", id });
  }, []);

  const handlePaneFocus = useCallback((tabId: string, paneId: PaneId): void => {
    dispatch({ type: "focus_pane", tabId, paneId });
  }, []);

  const handlePaneMeta = useCallback(
    (
      tabId: string,
      paneId: PaneId,
      cwd: string | null,
      branch: string | null,
      ahead: number | null,
      behind: number | null,
    ): void => {
      dispatch({ type: "update_meta", tabId, paneId, cwd, branch, ahead, behind });
    },
    [],
  );

  const handleSetRatio = useCallback((tabId: string, path: SplitPath, ratio: number): void => {
    dispatch({ type: "set_ratio", tabId, path, ratio });
  }, []);

  const handlePaneAltScreen = useCallback(
    (tabId: string, paneId: PaneId, altScreen: boolean): void => {
      dispatch({ type: "update_alt_screen", tabId, paneId, altScreen });
    },
    [],
  );

  const handlePanePtyId = useCallback(
    (tabId: string, paneId: PaneId, ptyId: string | null): void => {
      dispatch({ type: "update_pty_id", tabId, paneId, ptyId });
    },
    [],
  );

  // Hydrate the tab state from the persisted snapshot on first mount.
  // Outside a Tauri context (jsdom tests / browser preview) `appStateLoad`
  // returns null synchronously-after-await and the initial fresh tab from
  // `initialState()` stays in place; tests don't need to know this happened.
  // Inside Tauri, a saved layout fires a `hydrate` dispatch — the throwaway
  // tab created by `initialState` is unmounted (its PTY killed by the
  // existing spawn race-guard in TerminalPane) before any user input lands.
  const hydratedRef = useRef(false);
  useEffect(() => {
    void appStateLoad().then((json) => {
      hydratedRef.current = true;
      if (json === null) return;
      const restored = hydrateFromJson(json);
      if (restored === null) return;
      dispatch({ type: "hydrate", state: restored.state });
      setSidebarVisible(restored.sidebar.visible);
    });
  }, []);

  // Discover and register disk-loaded community formatters from
  // `~/.config/shax/formatters/`. Done on mount (not as a
  // module-side-effect import) so tests that touch the formatter
  // subsystem don't have to mock the `listCommunityFormatters`
  // IPC surface — only App tests do, and they already mock IPC.
  useEffect(() => {
    void loadCommunityFormatters();
    void loadCommunityCommands();
  }, []);

  // Persist the tab/layout snapshot on change, debounced so a divider drag
  // doesn't hammer SQLite once per frame. We only save *after* the initial
  // hydrate has resolved so we never overwrite a real saved layout with the
  // throwaway initial-state default before we've had a chance to load.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (state.tabs.length === 0) return;
    const handle = setTimeout(() => {
      void appStateSave(serialiseState(state, { visible: sidebarVisible }));
    }, 300);
    return () => clearTimeout(handle);
  }, [state, sidebarVisible]);

  // Keyboard shortcuts. Listening on the window so the bindings work
  // regardless of which surface currently owns focus.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        dispatch({ type: "add_tab" });
        return;
      }
      if (e.key === "n" || e.key === "N") {
        // ⌘N opens a new Shax window (M9.3, spec §15). Sibling
        // of ⌘T for tabs and ⌘D for splits — the muscle-memory
        // hierarchy is window > tab > split.
        e.preventDefault();
        void openNewWindow();
        return;
      }
      if (e.key === ",") {
        // Cmd/Ctrl+, opens the settings modal — standard
        // shortcut on both macOS and Linux/Windows. Toggles
        // if already open.
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
        return;
      }
      if (e.key === "b" || e.key === "B") {
        // M13.1 (spec §19 D2): ⌘B toggles the sidebar between
        // the icon rail and the expanded view. The VS Code /
        // Xcode / Finder default for a sidebar toggle. The
        // palette command "Sidebar: expand / collapse" and the
        // on-screen chevron button dispatch through the same
        // setter.
        e.preventDefault();
        setSidebarVisible((prev) => !prev);
        return;
      }
      if (e.key === "k" || e.key === "K") {
        // Cmd/Ctrl+K bounces focus toward the assistant. Spec §09
        // reserves this shortcut for the assistant. Behaviour:
        //   - closed → open (mount effect auto-focuses the textarea)
        //   - open + textarea NOT focused → focus the textarea
        //   - open + textarea IS focused → close
        // Symmetric to Escape, which bounces the other way.
        e.preventDefault();
        if (!assistantOpenRef.current) {
          setAssistantOpen(true);
        } else if (assistantInputFocusedRef.current) {
          setAssistantOpen(false);
          // M12 focus close-out: without this dispatch, closing
          // the assistant via ⌘K leaves focus floating on `<body>`
          // (the textarea is about to unmount, and no other
          // element auto-claims focus). The mode chip flips to
          // COMMAND because assistant-input-focused becomes false,
          // but typing hits `<body>` and does nothing. The
          // shax:refocus-pane bus makes the active pane claim
          // focus for its prompt strip immediately, matching what
          // Escape-close and click-outside close already do.
          window.dispatchEvent(new CustomEvent("shax:refocus-pane"));
        } else {
          window.dispatchEvent(new CustomEvent("shax:assistant-focus-input"));
        }
        return;
      }
      if (e.key === "f" || e.key === "F") {
        // ⌘F opens the search overlay. (⌘K stays reserved for the
        // assistant — see `specs/09-ai-assistant-and-auth.md`.) The
        // listener is registered in the *capture* phase below so we
        // see the keystroke before xterm's textarea translates it
        // into `^F` (readline forward-char) and writes a byte to
        // the PTY.
        //
        // *Except* when the block viewer modal is open: the user is
        // inside CodeMirror, which has its own ⌘F bound to the
        // in-buffer search panel via `searchKeymap`. Skip our
        // handler so the editor's wins.
        if (viewerOpenRef.current) return;
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      // ⌘⇧P toggles the pane command palette (M8.1, spec §14).
      // The Shift is deliberate — plain ⌘P is a common browser
      // shortcut we don't want to hijack, and ⌘⇧P matches VS
      // Code muscle memory. Key.toLowerCase because `shift`
      // gives us the uppercase form on macOS.
      if (e.shiftKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        void confirmThenClosePane(activeIdRef.current);
        return;
      }
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        const direction: SplitDirection = e.shiftKey ? "column" : "row";
        dispatch({ type: "split", tabId: activeIdRef.current, direction });
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        dispatch({ type: "switch_tab_by_index", index: e.key.charCodeAt(0) - "1".charCodeAt(0) });
        return;
      }
      if (e.key === "]" || e.key === "}") {
        e.preventDefault();
        if (e.shiftKey) {
          dispatch({ type: "cycle_tab", direction: 1 });
        } else {
          dispatch({ type: "cycle_focus", tabId: activeIdRef.current, direction: 1 });
        }
        return;
      }
      if (e.key === "[" || e.key === "{") {
        e.preventDefault();
        if (e.shiftKey) {
          dispatch({ type: "cycle_tab", direction: -1 });
        } else {
          dispatch({ type: "cycle_focus", tabId: activeIdRef.current, direction: -1 });
        }
        return;
      }
    };
    // Capture-phase so this handler runs before the focused xterm
    // textarea's own keydown listener — needed for ⌘F, which xterm
    // would otherwise translate to a `^F` byte and write to the PTY
    // before we get a chance to `preventDefault`. The other bindings
    // (⌘T, ⌘W, ⌘D, …) don't strictly need capture phase but ride
    // along for symmetry.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // Same stable-useCallback note as the listener effect above.
  }, [confirmThenClosePane]);

  // Block viewer open event. BlockRow's "view" icon dispatches a
  // `shax:open-viewer` CustomEvent with `{ pty, block }`; we store
  // it as the viewer target and render the modal below.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const detail = (e as CustomEvent<{ pty: PtyId | null; block: BlockSummary }>).detail;
      if (detail?.block === undefined) return;
      setViewerTarget(detail);
    };
    window.addEventListener("shax:open-viewer", onOpen);
    return () => window.removeEventListener("shax:open-viewer", onOpen);
  }, []);

  const titleTabs: TabDescriptor[] = useMemo(
    () =>
      tabs.map((t) => {
        const focusedCwd = t.panes[t.focusedPaneId]?.cwd ?? null;
        // Compact for display (`~/dev/shax` over `/Users/ada/dev/shax`).
        // `home` is `null` until the boot probe resolves; during that
        // window the raw path is rendered.
        return {
          id: t.id,
          label: t.label,
          cwd: focusedCwd === null ? null : compactCwd(focusedCwd, home),
        };
      }),
    [tabs, home],
  );

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activeFocused = activeTab !== null ? activeTab.panes[activeTab.focusedPaneId] : null;

  // FocusedPaneContext value (M13.2). Narrowed to the fields sidebar
  // widgets need — `altScreen` stays App-private. Memoised on the
  // PRIMITIVE fields, not on `activeFocused` itself — `activeFocused`
  // is re-derived every render from `state.tabs.find(…).panes[…]`
  // and so is a fresh object reference each time, which would defeat
  // the memo. eslint-plugin-react-hooks can't tell the difference,
  // hence the disable with justification.
  //
  // The primitive-field deps ensure subscribers only re-render when
  // an actual value changes (e.g. a new OSC 133 A arrives with a new
  // branch), not on every parent render (which would tick every 1s
  // because the clock lives in the same component).
  const focusedPaneMeta: FocusedPaneMeta | null = useMemo(() => {
    if (activeFocused == null) return null;
    return {
      ptyId: activeFocused.ptyId,
      cwd: activeFocused.cwd,
      branch: activeFocused.branch,
      ahead: activeFocused.ahead,
      behind: activeFocused.behind,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeFocused?.ptyId,
    activeFocused?.cwd,
    activeFocused?.branch,
    activeFocused?.ahead,
    activeFocused?.behind,
  ]);

  // NetworkContext value (M13.3). Memoised so the network widget
  // doesn't re-render on the 1s clock tick / 2s CPU tick just because
  // App re-rendered — only when ssid or localIp actually change.
  const networkInfo: NetworkInfo = useMemo(() => ({ interfaces }), [interfaces]);

  return (
    <HomeDirProvider value={home}>
      <ClockProvider value={clockNow}>
        <FocusedPaneProvider value={focusedPaneMeta}>
          <SystemLoadProvider value={systemLoad}>
            <NetworkProvider value={networkInfo}>
              <AssistantDockProvider value={assistantOpen}>
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    background: "var(--bg)",
                    color: "var(--fg)",
                    fontFamily: "var(--font-ui)",
                  }}
                >
                  <TitleBar
                    tabs={titleTabs}
                    activeId={activeId}
                    onSwitch={handleSwitch}
                    onNew={handleNew}
                    onClose={handleCloseTab}
                    onSearch={() => setSearchOpen(true)}
                  />
                  <main
                    ref={tabHostRef}
                    data-testid="tab-host"
                    style={{
                      flex: 1,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "row",
                      background: "var(--bg)",
                    }}
                  >
                    {/* Left column: the sidebar (M13.1, spec §19). Fixed-width
              first sibling of the tab area — 44px icon rail or 280px
              expanded — with its own persistence and ⌘B toggle. */}
                    <Sidebar
                      visible={sidebarVisible}
                      onToggle={() => setSidebarVisible((prev) => !prev)}
                    />
                    {/* Middle column: the tab area. Was the whole of `<main>` before
              M7.7a; the assistant now sits to its right in the same row
              when docked. `position: relative` here so the absolutely-
              positioned per-tab wrappers layout against this column
              (they used to hang off `<main>` itself). */}
                    <div
                      data-testid="tab-area"
                      style={{ flex: 1, minWidth: 0, position: "relative" }}
                    >
                      {tabs.map((tab) => {
                        const isActiveTab = tab.id === activeId;
                        return (
                          <div
                            key={tab.id}
                            data-testid="tab-pane-wrapper"
                            data-tab-id={tab.id}
                            data-active={isActiveTab ? "true" : "false"}
                            style={{
                              position: "absolute",
                              inset: 0,
                              visibility: isActiveTab ? "visible" : "hidden",
                              pointerEvents: isActiveTab ? "auto" : "none",
                              display: "flex",
                              flexDirection: "column",
                            }}
                          >
                            <LayoutRender
                              tabId={tab.id}
                              node={tab.layout}
                              focusedPaneId={tab.focusedPaneId}
                              tabActive={isActiveTab}
                              // The callbacks are kept reference-stable (useCallback
                              // with `[]`) so LayoutRender can hand stable handlers
                              // to every PaneLeaf — re-renders during a divider drag
                              // no longer cascade into the TerminalPane subtree.
                              onPaneFocus={handlePaneFocus}
                              onPaneMeta={handlePaneMeta}
                              onPaneAltScreen={handlePaneAltScreen}
                              onPanePtyId={handlePanePtyId}
                              onSetRatio={handleSetRatio}
                              // Persisted per-pane cwd + branch surface at
                              // first mount so restored panes spawn back
                              // into their saved directory (cwd via
                              // SpawnOpts) and render the correct branch
                              // label in the prompt strip immediately (no
                              // wait for the first OSC 133 A). Deliberately
                              // excluded from `paneLeafEqual`, so the
                              // mostly-pointless updates as the shell
                              // cds / git-checkouts around don't cascade
                              // into the pane subtree.
                              initialPaneMeta={panePaneMeta(tab)}
                            />
                          </div>
                        );
                      })}
                    </div>
                    {/* Right column: the docked assistant. Sibling of the tab
              area in the same flex row so opening the dock shrinks
              the tab area rather than covering it. Rendered inside
              `<main>` (not as a floating overlay) so it participates
              in normal layout (M7.7a). */}
                    {assistantOpen && (
                      <>
                        <AssistantDockDivider
                          width={assistantWidth}
                          hostRef={tabHostRef}
                          onResize={setAssistantWidth}
                          onCommit={setAssistantWidth}
                        />
                        <div
                          data-testid="assistant-dock"
                          style={{ width: assistantWidth, flexShrink: 0, display: "flex" }}
                        >
                          <AssistantOverlay
                            seededPrompt={assistantSeed}
                            onSeedConsumed={() => setAssistantSeed(null)}
                            onClose={() => {
                              setAssistantOpen(false);
                              setAssistantSeed(null);
                              refocusActivePane();
                            }}
                            onOpenSettings={() => setSettingsOpen(true)}
                            targetPtyId={activeFocused?.ptyId ?? null}
                          />
                        </div>
                      </>
                    )}
                  </main>
                  <Statusline
                    mode={
                      // Precedence: CHAT > INTERACTIVE > BLOCK > COMMAND. CHAT
                      // wins because it names where the keys ARE going (the
                      // assistant textarea); INTERACTIVE ranks above BLOCK
                      // because when an alt-screen program (vim / less / top)
                      // owns the pane, the block list is hidden and block-focus
                      // can't be entered anyway. See spec §18 M12.4.
                      assistantInputFocused
                        ? "CHAT"
                        : activeFocused?.altScreen
                          ? "INTERACTIVE"
                          : activePaneInBlockFocus
                            ? "BLOCK"
                            : "COMMAND"
                    }
                    interactiveCwd={
                      activeFocused?.altScreen && activeFocused.cwd
                        ? compactCwd(activeFocused.cwd, home)
                        : null
                    }
                    viKeymap={activePaneViKeymap}
                    user={activePaneIdentity.user}
                    host={activePaneIdentity.host}
                    clock={clockLabel}
                    clockTooltip={clockTooltip}
                    battery={batteryStatus}
                    localIp={localIp}
                    assistantActive={assistantOpen}
                    approvalsPending={approvalsPending}
                  />
                  {searchOpen && (
                    <SearchOverlay
                      currentCwd={activeFocused?.cwd ?? null}
                      currentBranch={activeFocused?.branch ?? null}
                      onClose={() => {
                        setSearchOpen(false);
                        refocusActivePane();
                      }}
                      onSelect={(hit) => {
                        // Search hand-off rule (slice 3.2 polish):
                        //
                        //   1. Live pane exists for this block (its PTY is still in
                        //      this session) → switch tabs + focus that pane, then
                        //      tell it to select the matching block row.
                        //   2. No live pane (block from a previous session, or its
                        //      pane was closed) → surface the block in the *current
                        //      active* pane via the `inspect_block` reducer action,
                        //      tagged "from history". Same selection treatment.
                        //
                        // Either way the user lands in a pane with the matched
                        // block visible and selected — no separate viewer modal.
                        setSearchOpen(false);
                        const live = findPaneByPtyId(state.tabs, hit.pane_id);
                        const target =
                          live ??
                          (() => {
                            const tab = state.tabs.find((t) => t.id === state.activeId);
                            if (tab === undefined) return null;
                            return { tabId: tab.id, paneId: tab.focusedPaneId };
                          })();
                        if (target === null) return;
                        if (target.tabId !== state.activeId) {
                          dispatch({ type: "switch_tab", id: target.tabId });
                        }
                        dispatch({
                          type: "focus_pane",
                          tabId: target.tabId,
                          paneId: target.paneId,
                        });
                        refocusActivePane();
                        // Defer one tick so the tab/pane switch commits before we
                        // ask the (now-visible) BlockList to scroll + select. The
                        // listeners live in the matching TerminalPane.
                        setTimeout(() => {
                          // `focus: true` opts the target pane into block-focus
                          // mode along with the selection. Search jumps are an
                          // explicit "I want to interact with this block" signal,
                          // so the keymap (j/k/Enter/Esc/…) should be live the
                          // moment the user lands. Click-to-select on a row
                          // omits the flag and only updates the highlight.
                          if (live !== null) {
                            window.dispatchEvent(
                              new CustomEvent("shax:select-block", {
                                detail: {
                                  paneId: target.paneId,
                                  blockId: hit.block.id,
                                  focus: true,
                                },
                              }),
                            );
                          } else {
                            window.dispatchEvent(
                              new CustomEvent("shax:inspect-block", {
                                detail: { paneId: target.paneId, block: hit.block, focus: true },
                              }),
                            );
                          }
                        }, 0);
                      }}
                    />
                  )}
                  {viewerTarget !== null && (
                    <BlockViewerModal
                      block={viewerTarget.block}
                      pty={viewerTarget.pty}
                      onClose={() => {
                        setViewerTarget(null);
                        refocusActivePane();
                      }}
                    />
                  )}
                  {paletteOpen && activeFocused?.ptyId != null && (
                    <PaletteOverlay
                      ctx={{
                        ptyId: activeFocused.ptyId,
                        cwd: activeFocused.cwd,
                        branch: activeFocused.branch,
                        gitRoot: null,
                      }}
                      onClose={() => {
                        setPaletteOpen(false);
                        refocusActivePane();
                      }}
                    />
                  )}
                  {/* One safety-gate instance for the whole app. Every
                   *  `shax:emit-command` from a widget, the assistant, or
                   *  the pane palette passes through this before it
                   *  reaches TerminalPane's PTY writer (spec §10). */}
                  <SafetyGate />
                  {settingsOpen && (
                    <SettingsModal
                      onClose={() => {
                        setSettingsOpen(false);
                        refocusActivePane();
                      }}
                    />
                  )}
                  {/* M9.6: close-confirmation modal. Rendered at App level
            so it can appear for any of the four close scopes
            (pane / tab / window / app quit). onConfirm runs the
            captured close action (dispatch or IPC); onCancel
            just clears the pending state. */}
                  {pendingClose && (
                    <ConfirmCloseModal
                      count={pendingClose.count}
                      verb={pendingClose.verb}
                      onConfirm={() => {
                        const cb = pendingClose.onConfirm;
                        setPendingClose(null);
                        cb();
                      }}
                      onCancel={() => setPendingClose(null)}
                    />
                  )}
                  {/* AssistantOverlay lives inside <main> as a docked column (see
            above) as of M7.7a — no longer a fixed overlay here. */}
                </div>
              </AssistantDockProvider>
            </NetworkProvider>
          </SystemLoadProvider>
        </FocusedPaneProvider>
      </ClockProvider>
    </HomeDirProvider>
  );
}
