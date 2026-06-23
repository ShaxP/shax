/**
 * App — top-level shell that owns the chrome (TitleBar, Statusline) and
 * orchestrates the open tab list.
 *
 * Each tab carries one `TerminalPane`. Tabs that aren't the active one
 * stay mounted in a hidden wrapper so their PTYs keep running and their
 * block / prompt state stays in sync with the shell. Per-tab metadata
 * (cwd, branch, alt-screen) bubbles up from the panes via callbacks so
 * the TitleBar tab pills and the Statusline mirror the live state.
 *
 * Keyboard shortcuts:
 *   ⌘T              → new tab
 *   ⌘W              → close the active tab (or replace it with a fresh
 *                     one if it's the last tab — so the window never
 *                     ends up paneless)
 *   ⌘1 .. ⌘9        → jump to tab N by position (1-indexed)
 *   ⌘⇧]  / ⌘⇧[      → next / previous tab
 *
 * The `⌘` modifier here means Cmd on macOS and Ctrl elsewhere; we listen
 * for either `metaKey` or `ctrlKey` so the same shortcuts work on Linux
 * and Windows builds without a platform-aware keymap.
 *
 * All tab transitions live in a single pure reducer. That way the tabs
 * array and the active id update atomically — no setState-inside-setState
 * impurity that StrictMode's double-render would otherwise expose as the
 * "active id no longer matches any tab after the second ⌘W" bug.
 */

import "./App.css";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { TerminalPane } from "./panes/TerminalPane";
import { TitleBar } from "./panes/TitleBar";
import type { TabDescriptor } from "./panes/TitleBar";
import { Statusline } from "./panes/Statusline";

interface TabState {
  id: string;
  label: string;
  cwd: string | null;
  branch: string | null;
  altScreen: boolean;
}

interface TabsState {
  tabs: TabState[];
  activeId: string;
}

type TabsAction =
  | { type: "add" }
  | { type: "close"; id: string }
  | { type: "switch"; id: string }
  | { type: "switch_by_index"; index: number }
  | { type: "cycle"; direction: 1 | -1 }
  | { type: "update"; id: string; updates: Partial<TabState> };

function newTabId(): string {
  return (
    "tab-" + Math.random().toString(36).slice(2, 8) + "-" + Math.random().toString(36).slice(2, 8)
  );
}

function makeTab(): TabState {
  return { id: newTabId(), label: "shax", cwd: null, branch: null, altScreen: false };
}

function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "add": {
      const fresh = makeTab();
      return { tabs: [...state.tabs, fresh], activeId: fresh.id };
    }
    case "close": {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      if (idx === -1) return state;
      if (state.tabs.length === 1) {
        // Last tab → replace with a fresh shell so the window is never
        // paneless. The new tab becomes the active one in the same
        // atomic transition.
        const fresh = makeTab();
        return { tabs: [fresh], activeId: fresh.id };
      }
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      let activeId = state.activeId;
      if (action.id === state.activeId) {
        // Closed the active tab: hand focus to the previous neighbour
        // (or to index 0 when closing the first tab).
        const neighborIdx = idx === 0 ? 0 : idx - 1;
        activeId = tabs[neighborIdx]?.id ?? activeId;
      }
      return { tabs, activeId };
    }
    case "switch": {
      if (action.id === state.activeId) return state;
      if (state.tabs.some((t) => t.id === action.id)) {
        return { ...state, activeId: action.id };
      }
      return state;
    }
    case "switch_by_index": {
      const target = state.tabs[action.index];
      if (target === undefined || target.id === state.activeId) return state;
      return { ...state, activeId: target.id };
    }
    case "cycle": {
      const i = state.tabs.findIndex((t) => t.id === state.activeId);
      if (i === -1 || state.tabs.length === 0) return state;
      const nextIdx = (i + action.direction + state.tabs.length) % state.tabs.length;
      const next = state.tabs[nextIdx];
      if (next === undefined || next.id === state.activeId) return state;
      return { ...state, activeId: next.id };
    }
    case "update": {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      if (idx === -1) return state;
      const current = state.tabs[idx];
      if (current === undefined) return state;
      // Skip the update if nothing actually changed — avoids re-render
      // churn from inline-arrow callbacks that fire the same values on
      // every parent render.
      let same = true;
      for (const key of Object.keys(action.updates) as (keyof TabState)[]) {
        if (current[key] !== action.updates[key]) {
          same = false;
          break;
        }
      }
      if (same) return state;
      const tabs = state.tabs.slice();
      tabs[idx] = { ...current, ...action.updates };
      return { ...state, tabs };
    }
  }
}

function initialState(): TabsState {
  const fresh = makeTab();
  return { tabs: [fresh], activeId: fresh.id };
}

export default function App(): React.ReactElement {
  const [state, dispatch] = useReducer(tabsReducer, undefined, initialState);
  const { tabs, activeId } = state;

  // Keep a ref to the current activeId so the keydown handler effect
  // doesn't need to re-register on every switch.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const handleNew = useCallback((): void => {
    dispatch({ type: "add" });
  }, []);

  const handleClose = useCallback((id: string): void => {
    dispatch({ type: "close", id });
  }, []);

  const handleSwitch = useCallback((id: string): void => {
    dispatch({ type: "switch", id });
  }, []);

  const updateTab = useCallback((id: string, updates: Partial<TabState>): void => {
    dispatch({ type: "update", id, updates });
  }, []);

  // Keyboard shortcuts. Listening on the window so the bindings work
  // regardless of which surface within the app has focus (xterm under
  // alt-screen, the prompt strip in resting state).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        dispatch({ type: "add" });
        return;
      }
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        dispatch({ type: "close", id: activeIdRef.current });
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        dispatch({ type: "switch_by_index", index: e.key.charCodeAt(0) - "1".charCodeAt(0) });
        return;
      }
      if (e.shiftKey && (e.key === "]" || e.key === "}")) {
        e.preventDefault();
        dispatch({ type: "cycle", direction: 1 });
        return;
      }
      if (e.shiftKey && (e.key === "[" || e.key === "{")) {
        e.preventDefault();
        dispatch({ type: "cycle", direction: -1 });
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const titleTabs: TabDescriptor[] = useMemo(
    () => tabs.map((t) => ({ id: t.id, label: t.label, cwd: t.cwd })),
    [tabs],
  );

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

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
        onClose={handleClose}
      />
      <main
        data-testid="tab-host"
        style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg)" }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <div
              key={tab.id}
              data-testid="tab-pane-wrapper"
              data-tab-id={tab.id}
              data-active={isActive ? "true" : "false"}
              style={{
                position: "absolute",
                inset: 0,
                visibility: isActive ? "visible" : "hidden",
                pointerEvents: isActive ? "auto" : "none",
              }}
            >
              <TerminalPane
                active={isActive}
                onMetaChange={(cwd, branch) => updateTab(tab.id, { cwd, branch })}
                onAltScreenChange={(altScreen) => updateTab(tab.id, { altScreen })}
              />
            </div>
          );
        })}
      </main>
      <Statusline cwd={activeTab?.cwd ?? null} branch={activeTab?.branch ?? null} />
    </div>
  );
}
