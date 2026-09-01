/**
 * Preferences modal (M7.5b reshape).
 *
 * Three-region layout: a header with the title + "changes apply
 * instantly" hint + close, a body that pairs a left-nav column with a
 * right content pane, and a bottom status bar. The nav has two entries
 * — Appearance and Assistant — and Assistant covers both Claude and
 * Ollama in one scrollable pane.
 *
 * The modal stays a modal. The design's window-framing (traffic lights,
 * full-window chrome) is a Claude Design canvas artifact and belongs to
 * the OS, not the product.
 *
 * Opens on Cmd/Ctrl + `,`. Closes on Escape / backdrop / the close
 * button. Persists on every change — no explicit save.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isTopmostModalLayer, useModalLayer } from "../lib/modalLayer";
import {
  deleteClaudeApiKey,
  hasClaudeApiKey,
  setClaudeApiKey,
} from "../assistant/providers/claude/apiKey";
import { probeClaudeCli } from "../assistant/providers/claude/subscription";
import {
  DEFAULT_APPEARANCE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  loadPreferences,
  savePreferences,
  type AppearancePreferences,
} from "../theme/preferences";
import type { ThemePreference } from "../theme/theme";
import { currentPlatform } from "../lib/platform";
import { BUNDLED_FONTS } from "../theme/fonts";
import { listThemes, type Theme } from "../lib/ipc";
import {
  probeOllama,
  probeOllamaModel,
  type OllamaProbeResult,
} from "../assistant/providers/ollama/ollama";
import {
  getAssistantConfig,
  setAssistantConfig,
  type AssistantConfig,
  type ClaudeLane,
} from "./config";

// ── Layout constants ────────────────────────────────────────────────────

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // Above the pane focus ring (zIndex 100 in LayoutRender) so a
  // multi-pane window doesn't leak its active-pane border through the
  // modal. Below the block viewer (1500). Sibling with the search
  // overlay backdrop (1000) — both are user-invoked, only one open at
  // a time.
  zIndex: 1200,
};

const PANEL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "min(880px, 92vw)",
  height: "min(560px, 84vh)",
  background: "var(--pane)",
  border: "1px solid var(--border-strong)",
  borderRadius: 10,
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  color: "var(--fg)",
  outline: "none",
  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.5)",
  overflow: "hidden",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 18px",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const HEADER_TITLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: 0.1,
};

const HEADER_RIGHT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const HEADER_HINT: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-faint)",
};

const CLOSE_BUTTON: CSSProperties = {
  padding: 4,
  width: 24,
  height: 24,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  border: "none",
  background: "transparent",
  color: "var(--fg-faint)",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};

const BODY: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const NAV_COLUMN: CSSProperties = {
  width: 200,
  padding: "12px 10px",
  borderRight: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  flexShrink: 0,
};

const NAV_ITEM: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  borderRadius: 6,
  fontSize: 13,
  color: "var(--fg-dim)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "var(--font-ui)",
};

const NAV_ITEM_ACTIVE: CSSProperties = {
  ...NAV_ITEM,
  background: "var(--accent-soft)",
  color: "var(--accent)",
  fontWeight: 500,
};

const NAV_FOOTER: CSSProperties = {
  marginTop: "auto",
  padding: "8px 12px",
  fontSize: 10.5,
  color: "var(--fg-faint)",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const RIGHT_PANE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "20px 24px",
  overflowY: "auto",
};

/*
 * The scrolled contents get their own opaque fill, and that is load-
 * bearing on Linux — not decoration.
 *
 * WebKit2GTK only promotes an `overflow: auto` box to a composited
 * scrolling layer once it *actually* overflows. Crossing that threshold
 * (expanding the API-key lane is enough) moves every glyph in the pane
 * into the new layer, and WebKit drops subpixel antialiasing for a
 * layer whose scrolled contents it can't prove opaque — so all the text
 * in the pane re-rasterises grayscale and visibly gains weight, then
 * snaps back when the lane collapses. Painting an opaque background on
 * the contents keeps the layer opaque, so the text renders identically
 * whether or not the pane scrolls.
 *
 * The colour matches PANEL's, so this is invisible on every platform;
 * `background` on RIGHT_PANE itself does *not* work — that paints into
 * the scroll container's layer, not the scrolled contents'.
 */
const RIGHT_PANE_CONTENTS: CSSProperties = {
  background: "var(--pane)",
};

const FOOTER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 18px",
  borderTop: "1px solid var(--border)",
  fontSize: 11,
  color: "var(--fg-faint)",
  flexShrink: 0,
};

const FOOTER_DOT: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  marginRight: 8,
  verticalAlign: "middle",
};

const SECTION_TITLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 6,
};

const SECTION_DESCRIPTION: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-dim)",
  marginBottom: 12,
};

const SUB_DIVIDER: CSSProperties = {
  margin: "20px 0",
  border: "none",
  borderTop: "1px solid var(--border)",
};

// ── M10.4: Appearance row layout ────────────────────────

const APPEARANCE_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  margin: "10px 0",
};

const APPEARANCE_LABEL: CSSProperties = {
  minWidth: 72,
  fontSize: 12,
  color: "var(--fg-dim)",
};

const SELECT_STYLE: CSSProperties = {
  flex: 1,
  padding: "6px 28px 6px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--pane2)",
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 12.5,
  // Turn off the native form-control theme so WebKit / Blink /
  // WebKit2GTK use OUR css instead of the OS palette. On Linux
  // WebKit2GTK in particular the native GTK theme would otherwise
  // paint the closed box in the system-light palette even inside a
  // dark-mode dialog — the "white dropdown, light text, unreadable"
  // bug reported on Ubuntu.
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  // With `appearance: none` the platform chevron disappears; add a
  // themed one via an inline SVG data URI positioned in the right
  // padding. `--fg-dim` is close enough to visible on both light
  // and dark palettes that a single fixed colour survives theme
  // switches without a per-theme swap.
  backgroundImage:
    "url(\"data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%238b909c' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 10px center",
  backgroundSize: "12px 12px",
};

const LANE_LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const LANE_ROW: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "12px 14px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "transparent",
  cursor: "pointer",
  transition: "border-color 120ms, background 120ms",
};

const LANE_ROW_ACTIVE: CSSProperties = {
  ...LANE_ROW,
  borderColor: "var(--accent)",
  background: "color-mix(in srgb, var(--accent) 8%, transparent)",
};

const RADIO_OUTER: CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: "50%",
  border: "1.5px solid var(--fg-faint)",
  flexShrink: 0,
  marginTop: 2,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const RADIO_OUTER_ACTIVE: CSSProperties = {
  ...RADIO_OUTER,
  borderColor: "var(--accent)",
};

const RADIO_INNER: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "var(--accent)",
};

const LANE_TITLE: CSSProperties = {
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const LANE_META: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-dim)",
  marginTop: 2,
};

const LANE_STATUS: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-dim)",
  marginTop: 8,
  display: "flex",
  alignItems: "center",
  gap: 6,
};

// Multi-line prose inside a lane's reveal area (e.g. the Ollama
// capabilities disclaimer). Deliberately NOT flex — inline `<em>` /
// `<code>` in the middle of the paragraph would otherwise be treated as
// separate flex items and fragment the text into columns.
const LANE_NOTE: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-faint)",
  marginTop: 8,
  lineHeight: 1.55,
  fontStyle: "italic",
};

const INPUT_ROW: CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 10,
};

const INPUT_WRAP: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
};

const INPUT: CSSProperties = {
  flex: 1,
  background: "transparent",
  border: "none",
  outline: "none",
  color: "var(--fg)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const SELECT: CSSProperties = {
  flex: 1,
  padding: "6px 28px 6px 10px",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  // Same treatment as SELECT_STYLE above — opt out of native form
  // theming so WebKit2GTK on Linux doesn't paint the closed box
  // in system-light palette. See SELECT_STYLE for the full rationale.
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  backgroundImage:
    "url(\"data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%238b909c' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 10px center",
  backgroundSize: "12px 12px",
};

const BUTTON: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 4,
  border: "1px solid var(--border-strong)",
  background: "var(--pane)",
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  cursor: "pointer",
};

const BUTTON_PRIMARY: CSSProperties = {
  ...BUTTON,
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
};

const KEYCHAIN_STRIP: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 10,
  padding: "6px 2px",
  fontSize: 11,
  color: "var(--fg-faint)",
};

const CLOUD_BADGE: CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  padding: "1px 6px",
  borderRadius: 3,
  border: "1px solid var(--border-strong)",
  letterSpacing: 0.4,
  color: "var(--fg-faint)",
  textTransform: "uppercase",
};

const LOCAL_BADGE: CSSProperties = {
  ...CLOUD_BADGE,
  borderColor: "var(--green)",
  color: "var(--green)",
};

const INLINE_CODE_BADGE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  padding: "1px 5px",
  border: "1px solid var(--border)",
  borderRadius: 3,
  color: "var(--fg-dim)",
  marginLeft: 6,
};

const DEFAULT_CONFIG: AssistantConfig = {
  provider: "",
  claude_lane: "none",
  claude_model: null,
  ollama_model: null,
  ollama_capabilities: null,
};

// ── Component ──────────────────────────────────────────────────────────

type NavSection = "appearance" | "prompt" | "assistant";

export function SettingsModal({ onClose }: { onClose: () => void }): React.ReactElement {
  useModalLayer("settings-modal");
  const panelRef = useRef<HTMLDivElement>(null);

  const [activeSection, setActiveSection] = useState<NavSection>("appearance");
  const [config, setConfig] = useState<AssistantConfig>(DEFAULT_CONFIG);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [cliVersion, setCliVersion] = useState<string | null | undefined>(undefined);
  const [ollama, setOllama] = useState<OllamaProbeResult | undefined>(undefined);
  const [theme, setTheme] = useState<ThemePreference>("system");
  // M10.4: appearance sub-block + catalog for the preset dropdowns.
  const [appearance, setAppearance] = useState<AppearancePreferences>(DEFAULT_APPEARANCE);
  const [themeCatalog, setThemeCatalog] = useState<Theme[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    void (async () => {
      const [cfg, cli, hasKey, ol, prefs, catalog] = await Promise.all([
        getAssistantConfig().catch(() => DEFAULT_CONFIG),
        probeClaudeCli().catch(() => null),
        hasClaudeApiKey().catch(() => false),
        probeOllama().catch(
          (): OllamaProbeResult => ({ reachable: false, models: [], error: null }),
        ),
        loadPreferences().catch(
          (): { theme: ThemePreference; appearance: AppearancePreferences } => ({
            theme: "system",
            appearance: DEFAULT_APPEARANCE,
          }),
        ),
        listThemes().catch((): Theme[] => []),
      ]);
      setConfig(cfg);
      setCliVersion(cli);
      setApiKeyConfigured(hasKey);
      setOllama(ol);
      setTheme(prefs.theme);
      // M10.4: hydrate appearance from disk (or fall back to
      // defaults if the field was absent on a pre-M10 file).
      setAppearance(prefs.appearance ?? DEFAULT_APPEARANCE);
      setThemeCatalog(catalog);
      // Back-fill missing Ollama capabilities on modal open —
      // e.g. a config saved before per-model probing landed,
      // or after Ollama was reinstalled with new models.
      if (
        cfg.provider === "ollama" &&
        cfg.ollama_model !== null &&
        cfg.ollama_capabilities === null &&
        ol.reachable
      ) {
        const caps = await probeOllamaModel(cfg.ollama_model).catch(() => null);
        if (caps !== null && !caps.unknown) {
          const enriched: AssistantConfig = {
            ...cfg,
            ollama_capabilities: { tools: caps.tools, vision: caps.vision },
          };
          setConfig(enriched);
          void setAssistantConfig(enriched);
        }
      }
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (!isTopmostModalLayer("settings-modal")) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const persist = async (next: AssistantConfig): Promise<void> => {
    setConfig(next);
    setStatus(null);
    try {
      await setAssistantConfig(next);
      // Let the assistant overlay refresh its provider so the new
      // config takes effect without a reload.
      window.dispatchEvent(
        new CustomEvent("shax:preference-changed", { detail: { assistant: true } }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to save settings: ${message}`);
    }
  };

  const persistClaudeLane = (lane: ClaudeLane): Promise<void> =>
    persist({ ...config, provider: lane === "none" ? "" : "claude", claude_lane: lane });

  const persistTheme = async (next: ThemePreference): Promise<void> => {
    setTheme(next);
    // M10.2: save FIRST, then dispatch. The App-level handler
    // now re-reads preferences.json to pick up any appearance
    // field (preset ids, font, ligatures) alongside the theme
    // mode. Dispatching before the save races the disk write —
    // the handler would read the previous value on every click.
    // The M7 pattern was to dispatch first and rely on
    // `detail.theme` for the applied value; M10.2's re-read is
    // strictly more powerful (handles the M10.3/M10.4 fields
    // too) but requires save-before-dispatch ordering.
    try {
      await savePreferences({ theme: next });
      window.dispatchEvent(new CustomEvent("shax:preference-changed", { detail: { theme: next } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to save theme: ${message}`);
    }
  };

  /**
   * M10.4: persist an appearance update. Same save-then-dispatch
   * pattern as `persistTheme` — the App handler re-reads the
   * file, so we must land the write before it fires. Optimistic
   * UI update stays: the picker reflects the new value
   * immediately, and a save failure surfaces via `status`
   * without rolling the visible state back.
   */
  const persistAppearance = async (patch: Partial<AppearancePreferences>): Promise<void> => {
    const next: AppearancePreferences = { ...appearance, ...patch };
    setAppearance(next);
    try {
      await savePreferences({ appearance: next });
      window.dispatchEvent(
        new CustomEvent("shax:preference-changed", { detail: { appearance: next } }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to save appearance: ${message}`);
    }
  };

  const persistOllamaModel = async (model: string): Promise<void> => {
    // Probe the model's capabilities so the provider can
    // honestly declare tool / vision support. Falls back to
    // conservative defaults if the daemon is unreachable —
    // never blocks the model pick itself.
    const caps = model.length === 0 ? null : await probeOllamaModel(model).catch(() => null);
    await persist({
      ...config,
      provider: "ollama",
      ollama_model: model || null,
      ollama_capabilities:
        caps === null || caps.unknown ? null : { tools: caps.tools, vision: caps.vision },
    });
  };

  const saveKey = async (): Promise<void> => {
    if (apiKey.length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      await setClaudeApiKey(apiKey);
      setApiKeyConfigured(true);
      setApiKey("");
      setStatus("API key saved to keychain.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to save: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      await deleteClaudeApiKey();
      setApiKeyConfigured(false);
      setStatus("API key removed.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to remove: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const cliInstalled = typeof cliVersion === "string" && cliVersion.length > 0;
  const claudeActive = config.provider === "claude";
  const ollamaActive = config.provider === "ollama";
  const ollamaReachable = ollama?.reachable === true;

  return (
    <div
      data-testid="settings-modal"
      style={BACKDROP}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} tabIndex={-1} style={PANEL}>
        <div style={HEADER}>
          <span style={HEADER_TITLE}>Preferences</span>
          <div style={HEADER_RIGHT}>
            <span data-testid="settings-hint" style={HEADER_HINT}>
              changes apply instantly
            </span>
            <button
              data-testid="settings-close"
              style={CLOSE_BUTTON}
              onClick={onClose}
              type="button"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div style={BODY}>
          <nav style={NAV_COLUMN} aria-label="Preferences sections">
            <NavItem
              testId="settings-nav-appearance"
              label="Appearance"
              icon={<AppearanceIcon />}
              active={activeSection === "appearance"}
              onSelect={() => setActiveSection("appearance")}
            />
            <NavItem
              testId="settings-nav-prompt"
              label="Prompt"
              icon={<PromptIcon />}
              active={activeSection === "prompt"}
              onSelect={() => setActiveSection("prompt")}
            />
            <NavItem
              testId="settings-nav-assistant"
              label="Assistant"
              icon={<AssistantIcon />}
              active={activeSection === "assistant"}
              onSelect={() => setActiveSection("assistant")}
            />
            <div style={NAV_FOOTER}>
              <span aria-hidden="true">◦</span>
              <span>local-first · nothing syncs</span>
            </div>
          </nav>

          <div data-testid="settings-content" style={RIGHT_PANE}>
            <div data-testid="settings-content-surface" style={RIGHT_PANE_CONTENTS}>
              {activeSection === "appearance" && (
                <AppearanceSection
                  theme={theme}
                  onPickTheme={persistTheme}
                  appearance={appearance}
                  catalog={themeCatalog}
                  onPatchAppearance={persistAppearance}
                />
              )}
              {activeSection === "prompt" && (
                <PromptSection appearance={appearance} onPatchAppearance={persistAppearance} />
              )}
              {activeSection === "assistant" && (
                <AssistantSection
                  config={config}
                  apiKey={apiKey}
                  setApiKey={setApiKey}
                  apiKeyConfigured={apiKeyConfigured}
                  cliVersion={cliVersion}
                  cliInstalled={cliInstalled}
                  claudeActive={claudeActive}
                  ollamaActive={ollamaActive}
                  ollama={ollama}
                  ollamaReachable={ollamaReachable}
                  busy={busy}
                  onPickLane={persistClaudeLane}
                  onPickOllama={() => {
                    if (!ollamaReachable || !ollama || ollama.models.length === 0) return;
                    const first = ollama.models[0];
                    void persist({
                      ...config,
                      provider: "ollama",
                      ollama_model: config.ollama_model ?? first ?? null,
                    });
                  }}
                  onPickOllamaModel={persistOllamaModel}
                  onSaveKey={saveKey}
                  onClearKey={clearKey}
                />
              )}
            </div>
          </div>
        </div>

        <div style={FOOTER}>
          <span data-testid="settings-saved-status">
            <span
              aria-hidden="true"
              style={{
                ...FOOTER_DOT,
                background: status !== null ? "var(--amber)" : "var(--green)",
              }}
            />
            {status ?? "all changes saved"}
          </span>
          <span>
            Esc or <kbd style={INLINE_CODE_BADGE}>⌘,</kbd> to close
          </span>
        </div>

        {status !== null && (
          <div data-testid="settings-message" style={{ display: "none" }} aria-live="polite">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section: Appearance ────────────────────────────────────────────────

function AppearanceSection({
  theme,
  onPickTheme,
  appearance,
  catalog,
  onPatchAppearance,
}: {
  theme: ThemePreference;
  onPickTheme: (next: ThemePreference) => Promise<void>;
  appearance: AppearancePreferences;
  catalog: readonly Theme[];
  onPatchAppearance: (patch: Partial<AppearancePreferences>) => Promise<void>;
}): React.ReactElement {
  const lightPresets = catalog.filter((t) => t.mode === "light");
  const darkPresets = catalog.filter((t) => t.mode === "dark");
  return (
    <section>
      {/* ── Mode ─────────────────────────────────────────── */}
      <div style={SECTION_TITLE}>Theme</div>
      <div style={{ ...SECTION_DESCRIPTION, marginBottom: 10 }}>
        Pick the palette Shax uses for chrome and blocks.
      </div>
      <div
        data-testid="settings-theme"
        role="radiogroup"
        aria-label="Theme"
        style={{
          display: "inline-flex",
          padding: 2,
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--pane2)",
          gap: 2,
        }}
      >
        {(["dark", "light", "system"] as ThemePreference[]).map((option) => (
          <ThemeOption
            key={option}
            option={option}
            active={theme === option}
            onSelect={() => void onPickTheme(option)}
          />
        ))}
      </div>
      <div style={{ ...LANE_STATUS, marginTop: 10 }}>
        {theme === "system"
          ? "Follows the OS setting. Updates instantly when you flip macOS Appearance."
          : theme === "dark"
            ? "Dark palette, always."
            : "Light palette, always."}
      </div>

      {/* ── Preset pickers (M10.4) ───────────────────────── */}
      <hr style={SUB_DIVIDER} />
      <div style={SECTION_TITLE}>Presets</div>
      <div style={SECTION_DESCRIPTION}>
        The catalog Shax picks from for each mode. Changes apply immediately.
      </div>
      <div style={APPEARANCE_ROW}>
        <label htmlFor="settings-theme-light" style={APPEARANCE_LABEL}>
          Light
        </label>
        <select
          id="settings-theme-light"
          data-testid="settings-preset-light"
          value={appearance.theme_light}
          onChange={(e) => void onPatchAppearance({ theme_light: e.target.value })}
          style={SELECT_STYLE}
        >
          {lightPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </div>
      <div style={APPEARANCE_ROW}>
        <label htmlFor="settings-theme-dark" style={APPEARANCE_LABEL}>
          Dark
        </label>
        <select
          id="settings-theme-dark"
          data-testid="settings-preset-dark"
          value={appearance.theme_dark}
          onChange={(e) => void onPatchAppearance({ theme_dark: e.target.value })}
          style={SELECT_STYLE}
        >
          {darkPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </div>

      {/* ── Font ─────────────────────────────────────────── */}
      <hr style={SUB_DIVIDER} />
      <div style={SECTION_TITLE}>Font</div>
      <div style={SECTION_DESCRIPTION}>
        Applies to the terminal and the file viewer. Chrome keeps the OS default.
      </div>
      <div style={APPEARANCE_ROW}>
        <label htmlFor="settings-font-family" style={APPEARANCE_LABEL}>
          Family
        </label>
        <select
          id="settings-font-family"
          data-testid="settings-font-family"
          value={appearance.font_family ?? ""}
          onChange={(e) =>
            void onPatchAppearance({
              // The empty string is the "System default" sentinel:
              // maps back to null, which `fontFamilyStack` treats
              // as "no user override, use the bundled default".
              font_family: e.target.value === "" ? null : e.target.value,
            })
          }
          style={SELECT_STYLE}
        >
          <option value="">System default (JetBrains Mono)</option>
          {BUNDLED_FONTS.map((font) => (
            <option key={font.cssFamily} value={font.cssFamily}>
              {font.displayName}
            </option>
          ))}
        </select>
      </div>
      <div style={APPEARANCE_ROW}>
        <label htmlFor="settings-font-size" style={APPEARANCE_LABEL}>
          Size
        </label>
        <input
          id="settings-font-size"
          data-testid="settings-font-size"
          type="range"
          min={MIN_FONT_SIZE}
          max={MAX_FONT_SIZE}
          value={appearance.font_size}
          onChange={(e) => void onPatchAppearance({ font_size: Number(e.target.value) })}
          style={{ flex: 1 }}
        />
        <span
          data-testid="settings-font-size-value"
          style={{
            minWidth: 32,
            textAlign: "right",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--fg-dim)",
          }}
        >
          {appearance.font_size}px
        </span>
      </div>
      <div style={APPEARANCE_ROW}>
        <label htmlFor="settings-ligatures" style={APPEARANCE_LABEL}>
          Ligatures
        </label>
        <input
          id="settings-ligatures"
          data-testid="settings-ligatures"
          type="checkbox"
          checked={appearance.ligatures}
          onChange={(e) => void onPatchAppearance({ ligatures: e.target.checked })}
        />
        <span style={{ ...LANE_STATUS, marginTop: 0, marginLeft: 4 }}>
          Fuses `==`, `!=`, `=&gt;` etc. when the font supports it.
        </span>
      </div>

      {/* ── Window ───────────────────────────────────────
          Linux only. On macOS the native decorations carry the
          traffic lights that this bar's left inset is reserved
          for, so turning them off would strip the lights and
          leave dead space — not a choice worth offering. */}
      {currentPlatform() === "linux" && (
        <>
          <hr style={SUB_DIVIDER} />
          <div style={SECTION_TITLE}>Window</div>
          <div style={APPEARANCE_ROW}>
            <label htmlFor="settings-window-decorations" style={APPEARANCE_LABEL}>
              Title bar
            </label>
            <input
              id="settings-window-decorations"
              data-testid="settings-window-decorations"
              type="checkbox"
              checked={appearance.window_decorations === "system"}
              onChange={(e) =>
                void onPatchAppearance({
                  window_decorations: e.target.checked ? "system" : "none",
                })
              }
            />
            <span style={{ ...LANE_STATUS, marginTop: 0, marginLeft: 4 }}>
              Off by default — a tiling compositor already manages the window. Shax&apos;s tab row
              stays draggable either way.
            </span>
          </div>
        </>
      )}
    </section>
  );
}

// ── Section: Prompt ────────────────────────────────────────────────

/**
 * M12.8c: the shell-prompt-specific preferences moved out of
 * Appearance into their own left-nav section. Two sub-groups
 * under mini section-titles matching the Appearance pane's
 * Theme / Presets / Font pattern:
 *
 *   - Cursor      — cursor blink toggle (M12.8b).
 *   - Editing mode — Emacs / Vi radio pair (M12.2), previously
 *                    under an "Appearance → Line editing" heading.
 *
 * As this grows (syntax highlighting toggle, autosuggestion
 * plugin toggle, paste-confirm threshold, …), everything
 * prompt-strip-scoped lands here.
 */
function PromptSection({
  appearance,
  onPatchAppearance,
}: {
  appearance: AppearancePreferences;
  onPatchAppearance: (patch: Partial<AppearancePreferences>) => Promise<void>;
}): React.ReactElement {
  return (
    <section>
      {/* ── Cursor (M12.8b) ─────────────────────────────── */}
      <div style={SECTION_TITLE}>Cursor</div>
      <div style={APPEARANCE_ROW}>
        <label htmlFor="settings-cursor-blink" style={APPEARANCE_LABEL}>
          Cursor blink
        </label>
        <input
          id="settings-cursor-blink"
          data-testid="settings-cursor-blink"
          type="checkbox"
          checked={appearance.cursor_blink}
          onChange={(e) => void onPatchAppearance({ cursor_blink: e.target.checked })}
        />
        <span style={{ ...LANE_STATUS, marginTop: 0, marginLeft: 4 }}>
          Blinks the prompt cursor once every second.
        </span>
      </div>

      {/* ── Editing mode (M12.2) ─────────────────────────
          The two cards render the choice inline with visible
          radios (same shape as the assistant lane cards) so it
          reads as "pick one." */}
      <hr style={SUB_DIVIDER} />
      <div style={SECTION_TITLE}>Editing mode</div>
      <div
        data-testid="settings-line-editing"
        role="radiogroup"
        aria-label="Editing mode"
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <LineEditingOption
          value="emacs"
          active={appearance.line_editing === "emacs"}
          title="Emacs"
          description="Standard emacs-style bindings: Ctrl-A / Ctrl-E, Esc as meta prefix. Overrides any vi-mode plugin your shell rc loaded so you get emacs even with zsh-vi-mode installed."
          onSelect={() => void onPatchAppearance({ line_editing: "emacs" })}
        />
        <LineEditingOption
          value="vi"
          active={appearance.line_editing === "vi"}
          title="Vi"
          description="Modal editing: Esc for normal mode, i / a for insert, v for visual. Shax bundles zsh-vi-mode v0.12.0 for a rich experience (used automatically unless your rc has already loaded a copy). The statusline shows INSERT / NORMAL / VISUAL alongside COMMAND."
          onSelect={() => void onPatchAppearance({ line_editing: "vi" })}
        />
      </div>
    </section>
  );
}

/** One card in the line-editing radio pair (M12.2, radio-inside-box
 *  refresh in M12.8c). Matches the assistant-lane card shape: title
 *  + description with a visible radio circle on the left so the
 *  "pick one" nature is obvious without relying only on the border
 *  colour. Selected → accent outline + accent-soft background;
 *  unselected → subdued border. */
function LineEditingOption({
  value,
  active,
  title,
  description,
  onSelect,
}: {
  value: "emacs" | "vi";
  active: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-testid={`settings-line-editing-${value}`}
      data-active={active ? "true" : "false"}
      onClick={onSelect}
      style={{
        textAlign: "left",
        padding: "12px 14px",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 8,
        background: active ? "var(--surface-hover)" : "var(--surface)",
        color: "var(--fg)",
        fontFamily: "inherit",
        cursor: "pointer",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        width: "100%",
      }}
    >
      {/* Visible radio circle — matches the assistant-lane cards
          (M12.8c). The border+background combo alone reads as
          "hover / active state" more than "pick one"; the explicit
          radio glyph makes the semantics obvious at a glance. */}
      <span aria-hidden="true" style={active ? RADIO_OUTER_ACTIVE : RADIO_OUTER}>
        {active && <span style={RADIO_INNER} />}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--fg-dim)", lineHeight: 1.45 }}>
          {description}
        </span>
      </span>
    </button>
  );
}

// ── Section: Assistant ─────────────────────────────────────────────────

interface AssistantSectionProps {
  config: AssistantConfig;
  apiKey: string;
  setApiKey: (v: string) => void;
  apiKeyConfigured: boolean | null;
  cliVersion: string | null | undefined;
  cliInstalled: boolean;
  claudeActive: boolean;
  ollamaActive: boolean;
  ollama: OllamaProbeResult | undefined;
  ollamaReachable: boolean;
  busy: boolean;
  onPickLane: (lane: ClaudeLane) => Promise<void>;
  onPickOllama: () => void;
  onPickOllamaModel: (model: string) => Promise<void>;
  onSaveKey: () => Promise<void>;
  onClearKey: () => Promise<void>;
}

function AssistantSection(props: AssistantSectionProps): React.ReactElement {
  const {
    config,
    apiKey,
    setApiKey,
    apiKeyConfigured,
    cliVersion,
    cliInstalled,
    claudeActive,
    ollamaActive,
    ollama,
    ollamaReachable,
    busy,
    onPickLane,
    onPickOllama,
    onPickOllamaModel,
    onSaveKey,
    onClearKey,
  } = props;

  return (
    <section>
      {/* Claude */}
      <div style={SECTION_TITLE}>
        <span>Assistant · Claude</span>
        <span style={CLOUD_BADGE} title="Requests go to Anthropic's cloud API">
          cloud
        </span>
      </div>
      <div style={SECTION_DESCRIPTION}>Requests go to Anthropic's cloud API.</div>
      <div style={LANE_LIST}>
        <LaneRow
          testId="settings-lane-none"
          title="Off"
          meta="No assistant surface anywhere. The terminal works as usual."
          active={!claudeActive && !ollamaActive}
          onSelect={() => void onPickLane("none")}
        />

        <LaneRow
          testId="settings-lane-api-key"
          title="Use my Anthropic API key"
          meta="Pay-per-token via api.anthropic.com."
          active={claudeActive && config.claude_lane === "api-key"}
          onSelect={() => void onPickLane("api-key")}
        >
          {claudeActive && config.claude_lane === "api-key" && (
            <>
              <div style={LANE_STATUS}>
                <span
                  aria-hidden="true"
                  style={{
                    ...FOOTER_DOT,
                    background: apiKeyConfigured === true ? "var(--green)" : "var(--fg-faint)",
                    marginRight: 0,
                  }}
                />
                <span data-testid="settings-claude-status">
                  {apiKeyConfigured === null
                    ? "checking…"
                    : apiKeyConfigured
                      ? "configured · stored in OS keychain"
                      : "not configured"}
                </span>
              </div>
              <div style={INPUT_ROW}>
                <div style={INPUT_WRAP}>
                  <span aria-hidden="true" style={{ color: "var(--fg-faint)" }}>
                    🔑
                  </span>
                  <input
                    data-testid="settings-claude-key"
                    type="password"
                    placeholder="sk-ant-…"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void onSaveKey();
                      }
                    }}
                    style={INPUT}
                  />
                </div>
                <button
                  data-testid="settings-claude-save"
                  style={BUTTON_PRIMARY}
                  onClick={() => void onSaveKey()}
                  disabled={busy || apiKey.length === 0}
                  type="button"
                >
                  Save
                </button>
                {apiKeyConfigured === true && (
                  <button
                    data-testid="settings-claude-clear"
                    style={BUTTON}
                    onClick={() => void onClearKey()}
                    disabled={busy}
                    type="button"
                    title="Remove the stored API key"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div data-testid="settings-keychain-reassurance" style={KEYCHAIN_STRIP}>
                <LockIcon />
                <span>Stored in your OS keychain — never written to disk in plain form.</span>
              </div>
            </>
          )}
        </LaneRow>

        <LaneRow
          testId="settings-lane-subscription"
          title={
            <>
              Use my Claude subscription
              <span style={INLINE_CODE_BADGE}>Claude Code</span>
            </>
          }
          meta={
            cliVersion === undefined
              ? "Checking for Claude Code…"
              : cliInstalled
                ? "Shax spawns your local claude CLI for each request."
                : "Claude Code not installed. Install from claude.com/download to use this lane."
          }
          active={claudeActive && config.claude_lane === "subscription"}
          disabled={!cliInstalled}
          onSelect={() => cliInstalled && void onPickLane("subscription")}
        >
          {cliInstalled && (
            <div style={LANE_STATUS}>
              <span
                aria-hidden="true"
                style={{
                  ...FOOTER_DOT,
                  background: "var(--green)",
                  marginRight: 0,
                }}
              />
              <span>detected · Claude Code {typeof cliVersion === "string" ? cliVersion : ""}</span>
            </div>
          )}
        </LaneRow>
      </div>

      <hr style={SUB_DIVIDER} />

      {/* Ollama */}
      <div style={SECTION_TITLE}>
        <span>Assistant · Ollama</span>
        <span style={LOCAL_BADGE} title="Nothing leaves your machine — nothing.">
          local
        </span>
      </div>
      <div style={SECTION_DESCRIPTION}>
        Runs entirely on your machine. Selecting Ollama turns off Claude.
      </div>
      <div style={LANE_LIST}>
        <LaneRow
          testId="settings-ollama"
          title="Use my local Ollama daemon"
          meta={
            ollama === undefined
              ? "Checking for Ollama…"
              : ollamaReachable
                ? ollama.models.length > 0
                  ? "Connects to localhost:11434."
                  : "Detected at localhost:11434 · no models installed yet. Run `ollama pull llama3.1` to get started."
                : "Ollama daemon not reachable at localhost:11434. Install from ollama.com/download and start it."
          }
          active={ollamaActive}
          disabled={!ollamaReachable || (ollama?.models.length ?? 0) === 0}
          onSelect={onPickOllama}
        >
          {ollamaActive && ollamaReachable && ollama && ollama.models.length > 0 && (
            <>
              <div style={LANE_STATUS}>
                <span
                  aria-hidden="true"
                  style={{
                    ...FOOTER_DOT,
                    background: "var(--green)",
                    marginRight: 0,
                  }}
                />
                <span>
                  reachable · {ollama.models.length} model
                  {ollama.models.length === 1 ? "" : "s"} installed
                </span>
              </div>
              <div style={INPUT_ROW}>
                <select
                  data-testid="settings-ollama-model"
                  value={config.ollama_model ?? ""}
                  onChange={(e) => void onPickOllamaModel(e.target.value)}
                  style={SELECT}
                >
                  {ollama.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              {config.ollama_capabilities !== null ? (
                <>
                  <div
                    data-testid="settings-ollama-capabilities"
                    style={{
                      ...LANE_STATUS,
                      marginTop: 8,
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <span>Capabilities:</span>
                    <ModelCapabilityChip
                      label="tools"
                      supported={config.ollama_capabilities.tools}
                      testId="settings-ollama-cap-tools"
                    />
                    <ModelCapabilityChip
                      label="vision"
                      supported={config.ollama_capabilities.vision}
                      testId="settings-ollama-cap-vision"
                    />
                  </div>
                  <div data-testid="settings-ollama-capabilities-note" style={LANE_NOTE}>
                    Capabilities reflect what the model{" "}
                    <em style={{ fontStyle: "normal", fontWeight: 600 }}>declares</em>, not tested
                    behaviour. Real-world tool use varies — smaller models (e.g. Llama 3.2 1B/3B)
                    often claim <code>tools</code> support but fabricate answers instead of calling
                    the tool. Try Qwen 2.5, Llama 3.1, or Mistral Nemo for reliable results.
                  </div>
                </>
              ) : (
                <div style={{ ...LANE_STATUS, marginTop: 6 }}>
                  Capabilities not probed yet — pick a model to detect tool + vision support.
                </div>
              )}
            </>
          )}
        </LaneRow>
      </div>
    </section>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function NavItem({
  testId,
  label,
  icon,
  active,
  onSelect,
}: {
  testId: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      data-testid={testId}
      data-active={active}
      type="button"
      onClick={onSelect}
      style={active ? NAV_ITEM_ACTIVE : NAV_ITEM}
    >
      <span aria-hidden="true" style={{ display: "inline-flex" }}>
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function ThemeOption({
  option,
  active,
  onSelect,
}: {
  option: ThemePreference;
  active: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const label = option === "dark" ? "Dark" : option === "light" ? "Light" : "System";
  return (
    <button
      data-testid={`settings-theme-${option}`}
      data-active={active}
      role="radio"
      aria-checked={active}
      type="button"
      onClick={onSelect}
      style={{
        padding: "5px 14px",
        borderRadius: 4,
        border: "1px solid transparent",
        background: active ? "var(--accent)" : "transparent",
        color: active ? "#fff" : "var(--fg)",
        fontFamily: "var(--font-ui)",
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function ModelCapabilityChip({
  label,
  supported,
  testId,
}: {
  label: string;
  supported: boolean;
  testId: string;
}): React.ReactElement {
  return (
    <span
      data-testid={testId}
      data-supported={supported}
      style={{
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        padding: "1px 6px",
        borderRadius: 3,
        border: "1px solid",
        color: supported ? "var(--green)" : "var(--fg-faint)",
        borderColor: supported ? "var(--green)" : "var(--border)",
        opacity: supported ? 1 : 0.55,
      }}
      title={
        supported
          ? `This model reports support for ${label}.`
          : `This model does not support ${label}.`
      }
    >
      {label}
      {supported ? " ✓" : " ✗"}
    </span>
  );
}

function LaneRow({
  testId,
  title,
  meta,
  active,
  disabled = false,
  onSelect,
  children,
}: {
  testId: string;
  title: ReactNode;
  meta: string;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children?: ReactNode;
}): React.ReactElement {
  return (
    <div
      data-testid={testId}
      data-active={active}
      role="button"
      style={{
        ...(active ? LANE_ROW_ACTIVE : LANE_ROW),
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        flexDirection: "column",
      }}
      onClick={(e) => {
        if (disabled) return;
        // Clicks inside the reveal area (inputs, buttons) shouldn't
        // re-trigger the lane select — they route to their own
        // handlers already. Only fire onSelect when the click hits
        // the lane's own chrome.
        const target = e.target as HTMLElement;
        if (target.closest("input,button,select,a")) return;
        onSelect();
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={disabled ? -1 : 0}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, width: "100%" }}>
        <span aria-hidden="true" style={active ? RADIO_OUTER_ACTIVE : RADIO_OUTER}>
          {active && <span style={RADIO_INNER} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={LANE_TITLE}>{title}</div>
          <div style={LANE_META}>{meta}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────

function AppearanceIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M 8 2 A 6 6 0 0 1 8 14 Z" fill="currentColor" />
    </svg>
  );
}

function AssistantIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M 8 2.2 L 9.2 6.4 L 13.4 7.6 L 9.2 8.8 L 8 13 L 6.8 8.8 L 2.6 7.6 L 6.8 6.4 Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** M12.8c: nav icon for the Prompt section — a shell-prompt
 *  chevron (`>`) rendered as a chunky glyph so it's readable at
 *  16×16. Matches the `❯` symbol the prompt strip itself uses. */
function PromptIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M 4 4 L 9 8 L 4 12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M 10 12 L 13 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function LockIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M 4 5.5 V 4 A 2 2 0 0 1 8 4 V 5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}
