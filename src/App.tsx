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
import { appStateLoad, appStateSave } from "./lib/ipc";

interface PaneMeta {
  cwd: string | null;
  branch: string | null;
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
  return { cwd: null, branch: null, altScreen: false, ptyId: null };
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
        if (current.cwd === action.cwd && current.branch === action.branch) return tab;
        return {
          ...tab,
          panes: {
            ...tab.panes,
            [action.paneId]: { ...current, cwd: action.cwd, branch: action.branch },
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

interface PersistedAppState {
  tabs: PersistedTab[];
  activeId: string;
}

function serialiseState(state: TabsState): string {
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
  };
  return JSON.stringify(persistable);
}

function hydrateFromJson(json: string): TabsState | null {
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
  return { tabs, activeId };
}

export default function App(): React.ReactElement {
  const [state, dispatch] = useReducer(tabsReducer, undefined, initialState);
  const { tabs, activeId } = state;

  // Search overlay. Top-level so the keybindings can open it regardless
  // of which pane currently owns focus.
  const [searchOpen, setSearchOpen] = useState(false);

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

  const handleNew = useCallback((): void => {
    dispatch({ type: "add_tab" });
  }, []);

  const handleCloseTab = useCallback((id: string): void => {
    dispatch({ type: "close_tab", id });
  }, []);

  const handleSwitch = useCallback((id: string): void => {
    dispatch({ type: "switch_tab", id });
  }, []);

  const handlePaneFocus = useCallback((tabId: string, paneId: PaneId): void => {
    dispatch({ type: "focus_pane", tabId, paneId });
  }, []);

  const handlePaneMeta = useCallback(
    (tabId: string, paneId: PaneId, cwd: string | null, branch: string | null): void => {
      dispatch({ type: "update_meta", tabId, paneId, cwd, branch });
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
      dispatch({ type: "hydrate", state: restored });
    });
  }, []);

  // Persist the tab/layout snapshot on change, debounced so a divider drag
  // doesn't hammer SQLite once per frame. We only save *after* the initial
  // hydrate has resolved so we never overwrite a real saved layout with the
  // throwaway initial-state default before we've had a chance to load.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (state.tabs.length === 0) return;
    const handle = setTimeout(() => {
      void appStateSave(serialiseState(state));
    }, 300);
    return () => clearTimeout(handle);
  }, [state]);

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
      if (e.key === "f" || e.key === "F") {
        // ⌘F opens the search overlay. (⌘K stays reserved for the
        // assistant — see `specs/09-ai-assistant-and-auth.md`.) The
        // listener is registered in the *capture* phase below so we
        // see the keystroke before xterm's textarea translates it
        // into `^F` (readline forward-char) and writes a byte to
        // the PTY.
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        dispatch({ type: "close_focused_pane", tabId: activeIdRef.current });
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
  }, []);

  const titleTabs: TabDescriptor[] = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        label: t.label,
        cwd: t.panes[t.focusedPaneId]?.cwd ?? null,
      })),
    [tabs],
  );

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activeFocused = activeTab !== null ? activeTab.panes[activeTab.focusedPaneId] : null;

  return (
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
        data-testid="tab-host"
        style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg)" }}
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
              />
            </div>
          );
        })}
      </main>
      <Statusline cwd={activeFocused?.cwd ?? null} branch={activeFocused?.branch ?? null} />
      {searchOpen && (
        <SearchOverlay
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
            dispatch({ type: "focus_pane", tabId: target.tabId, paneId: target.paneId });
            refocusActivePane();
            // Defer one tick so the tab/pane switch commits before we
            // ask the (now-visible) BlockList to scroll + select. The
            // listeners live in the matching TerminalPane.
            setTimeout(() => {
              if (live !== null) {
                window.dispatchEvent(
                  new CustomEvent("shax:select-block", {
                    detail: { paneId: target.paneId, blockId: hit.block.id },
                  }),
                );
              } else {
                window.dispatchEvent(
                  new CustomEvent("shax:inspect-block", {
                    detail: { paneId: target.paneId, block: hit.block },
                  }),
                );
              }
            }, 0);
          }}
        />
      )}
    </div>
  );
}
