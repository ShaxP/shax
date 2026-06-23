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
 */

import "./App.css";
import { useCallback, useEffect, useMemo, useState } from "react";
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

function newTabId(): string {
  return (
    "tab-" + Math.random().toString(36).slice(2, 8) + "-" + Math.random().toString(36).slice(2, 8)
  );
}

function makeTab(): TabState {
  return { id: newTabId(), label: "shax", cwd: null, branch: null, altScreen: false };
}

export default function App(): React.ReactElement {
  const [tabs, setTabs] = useState<TabState[]>(() => [makeTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]?.id ?? "");

  const updateTab = useCallback((id: string, updates: Partial<TabState>): void => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...updates } : t)));
  }, []);

  const handleNew = useCallback((): void => {
    const fresh = makeTab();
    setTabs((prev) => [...prev, fresh]);
    setActiveId(fresh.id);
  }, []);

  const handleClose = useCallback(
    (id: string): void => {
      setTabs((prev) => {
        if (prev.length === 0) return prev;
        const index = prev.findIndex((t) => t.id === id);
        if (index === -1) return prev;
        // Removing the last tab would leave the window paneless — open a
        // fresh shell instead so there is always somewhere to type.
        if (prev.length === 1) {
          const fresh = makeTab();
          setActiveId(fresh.id);
          return [fresh];
        }
        const next = prev.filter((t) => t.id !== id);
        // If we just closed the active tab, hand focus to a sensible
        // neighbour (the previous one, or the new index-0 if we closed
        // the first tab).
        if (id === activeId) {
          const neighborIndex = index === 0 ? 0 : index - 1;
          const neighbor = next[neighborIndex];
          if (neighbor !== undefined) setActiveId(neighbor.id);
        }
        return next;
      });
    },
    [activeId],
  );

  // Keyboard shortcuts. Listening on the document so the bindings work
  // regardless of which surface within the app has focus (xterm in
  // alt-screen, the prompt strip in resting state, a future search
  // overlay later, etc.).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // ⌘T — new tab.
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        handleNew();
        return;
      }
      // ⌘W — close current tab.
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        handleClose(activeId);
        return;
      }
      // ⌘1..⌘9 — switch to tab N by position.
      if (e.key >= "1" && e.key <= "9") {
        const idx = e.key.charCodeAt(0) - "1".charCodeAt(0);
        const target = tabs[idx];
        if (target !== undefined) {
          e.preventDefault();
          setActiveId(target.id);
        }
        return;
      }
      // ⌘⇧] — next tab. ⌘⇧[ — previous tab.
      if (e.shiftKey && (e.key === "]" || e.key === "}")) {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.id === activeId);
        if (i !== -1) {
          const next = tabs[(i + 1) % tabs.length];
          if (next !== undefined) setActiveId(next.id);
        }
        return;
      }
      if (e.shiftKey && (e.key === "[" || e.key === "{")) {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.id === activeId);
        if (i !== -1) {
          const prev = tabs[(i - 1 + tabs.length) % tabs.length];
          if (prev !== undefined) setActiveId(prev.id);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs, activeId, handleNew, handleClose]);

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
        onSwitch={setActiveId}
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
