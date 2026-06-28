/**
 * Read-only CodeMirror 6 viewer (M4 slice 4.1).
 *
 * A reusable rendering surface — not bound to any specific origin.
 * Pass it `text` and an optional language id; it renders the
 * content with syntax highlight, line numbers, vim navigation,
 * and an in-buffer search panel. Read-only at the editor level so
 * the user can navigate and yank but never accidentally mutate
 * what they're inspecting.
 *
 * The vim mode indicator is rendered as a small footer pill (NORMAL
 * / INSERT / VISUAL / etc.) so the user always knows the current
 * mode. We listen for vim mode changes via the
 * `@replit/codemirror-vim` API.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { vim, Vim } from "@replit/codemirror-vim";

import { languageExtension, type LanguageId } from "./detectLanguage";

/**
 * The viewer is a read-only navigator: a user pressing `i` to enter
 * insert mode in an immutable buffer would only flip the mode pill
 * to `insert` without being able to type anything, which is a worse
 * UX than not having the mode at all. Remap every insert-entering
 * normal-mode command to `<Nop>` so the editor stays in `normal` /
 * `visual` / `replace` modes only.
 *
 * `Vim` is a process-wide singleton (the replit plugin doesn't yet
 * expose per-instance keymaps), so this runs once at module load.
 * The viewer is the only surface that activates vim in this app, so
 * the global remap is fine.
 */
const INSERT_ENTRY_KEYS = [
  "i",
  "I",
  "a",
  "A",
  "o",
  "O",
  "s",
  "S",
  "c",
  "C",
  "r",
  "R",
  // Vim's `gi` and `gI` also enter insert at the last edit point.
  "gi",
  "gI",
];
for (const key of INSERT_ENTRY_KEYS) {
  Vim.noremap(key, "<Nop>", "normal");
}

export interface ViewerProps {
  /** Text to display. Re-creating the editor on every change is fine
   *  for the read-only "open a captured block" use case. */
  text: string;
  /** CodeMirror language extension to apply. Defaults to plaintext. */
  language?: LanguageId;
  /** Inline style for the wrapper. Tests + the modal host set
   *  `height: '100%'` to make the editor fill its parent. */
  style?: CSSProperties;
}

const WRAPPER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  fontFamily: "var(--font-mono)",
  background: "var(--pane)",
};

const EDITOR_HOST_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};

const MODE_BAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 10px",
  background: "var(--pane2)",
  borderTop: "1px solid var(--border)",
  fontFamily: "var(--font-ui)",
  fontSize: 11,
  color: "var(--fg-faint)",
  letterSpacing: 0.4,
  textTransform: "uppercase",
};

const MODE_PILL_STYLE: CSSProperties = {
  padding: "1px 6px",
  borderRadius: 3,
  border: "1px solid var(--border-strong)",
  color: "var(--fg)",
  background: "var(--surface)",
  fontWeight: 600,
};

/**
 * Strip ANSI / CSI / OSC escape sequences so terminal control
 * bytes don't clutter the viewer. The block's raw bytes path
 * keeps the originals; the viewer is a "lens" per the fidelity
 * contract — clean text is the point.
 */
function stripAnsi(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input.charCodeAt(i);
    if (ch !== 0x1b) {
      out += input[i];
      i++;
      continue;
    }
    const next = input.charCodeAt(i + 1);
    if (next === 0x5b /* [ */) {
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (next === 0x5d /* ] */) {
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c === 0x07) {
          j++;
          break;
        }
        if (c === 0x1b && input.charCodeAt(j + 1) === 0x5c /* \ */) {
          j += 2;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    i += 2;
  }
  return out;
}

export function Viewer({ text, language = "plaintext", style }: ViewerProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [mode, setMode] = useState<string>("normal");

  // Mount / re-mount the editor whenever the content or language
  // changes. CodeMirror handles incremental updates internally for
  // mutable views; ours is one-shot per content so the rebuild is
  // cheap and the state stays clean.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const cleanText = stripAnsi(text);
    const extensions: Extension[] = [
      vim(),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      rectangularSelection(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap]),
      oneDark,
      // We want the *document* to be immutable but the *editor* to
      // behave as editable so the vim plugin doesn't refuse to enter
      // insert mode (it bails on `EditorState.readOnly`). A
      // transaction filter that drops any change-bearing transaction
      // gives us both: insert mode opens, the pill flips, but any
      // character typing produces a transaction that's silently
      // discarded before it touches the document.
      EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
      languageExtension(language),
    ];
    const state = EditorState.create({ doc: cleanText, extensions });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    // Focus the editor so vim keys + ⌘F land here instead of body.
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [text, language]);

  // Listen for vim mode changes. `@replit/codemirror-vim` emits a
  // `"vim-mode-change"` event on the CM5-shim `cm` object it
  // attaches to the EditorView. The event payload is
  // `{ mode, subMode? }` where `mode` is one of "normal" /
  // "insert" / "visual" / "replace" and `subMode` (for visual)
  // is "linewise" / "blockwise". We map that to our pill label.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    type VimEvent = { mode: string; subMode?: string };
    type VimCM = {
      on: (event: string, handler: (e: VimEvent) => void) => void;
      off: (event: string, handler: (e: VimEvent) => void) => void;
    };
    const cm = (view as unknown as { cm?: VimCM }).cm;
    if (cm === undefined) return;
    const handler = (e: VimEvent): void => {
      const base = e.mode ?? "normal";
      const next =
        base === "visual"
          ? e.subMode === "linewise"
            ? "visualline"
            : e.subMode === "blockwise"
              ? "visualblock"
              : "visual"
          : base;
      setMode(next);
    };
    cm.on("vim-mode-change", handler);
    return () => cm.off("vim-mode-change", handler);
  }, [text, language]);

  // Stop key events propagating to the window-level keybindings
  // (⌘F, etc.) when the editor has focus — otherwise typing in
  // the in-buffer search field would also re-trigger the global
  // overlay. Capture phase so we intercept before App's handler.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const handler = (e: KeyboardEvent): void => {
      // Esc bubbles up so the modal can close on it from outside
      // the editor. Everything else is internal.
      if (e.key === "Escape") return;
      e.stopPropagation();
    };
    host.addEventListener("keydown", handler);
    return () => host.removeEventListener("keydown", handler);
  }, []);

  return (
    <div style={{ ...WRAPPER_STYLE, ...style }} data-testid="viewer">
      <div ref={hostRef} style={EDITOR_HOST_STYLE} data-testid="viewer-editor-host" />
      <div style={MODE_BAR_STYLE} data-testid="viewer-mode-bar">
        <span style={MODE_PILL_STYLE} data-testid="viewer-vim-mode">
          {formatVimMode(mode)}
        </span>
        <span>{language === "plaintext" ? "plain text" : language}</span>
        <span style={{ marginLeft: "auto", opacity: 0.7 }}>read-only · ctrl-f search</span>
      </div>
    </div>
  );
}

function formatVimMode(mode: string): string {
  // Canonicalise replit-vim's strings — `normal`, `insert`,
  // `visual` (and the variants `visualline`, `visualblock`) —
  // into a short label for the pill.
  switch (mode) {
    case "normal":
      return "normal";
    case "insert":
      return "insert";
    case "visual":
      return "visual";
    case "visualline":
      return "v-line";
    case "visualblock":
      return "v-block";
    case "replace":
      return "replace";
    default:
      return mode;
  }
}

// Re-export the imperative Vim handle so the modal host can map
// extra keybindings (e.g. `Esc` to close from normal mode) when
// the milestone needs them. Not used in 4.1 directly.
export { Vim };
