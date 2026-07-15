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
import {
  deleteClaudeApiKey,
  hasClaudeApiKey,
  setClaudeApiKey,
} from "../assistant/providers/claude/apiKey";
import { probeClaudeCli } from "../assistant/providers/claude/subscription";
import { loadPreferences, savePreferences } from "../theme/preferences";
import type { ThemePreference } from "../theme/theme";
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
  padding: "6px 10px",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
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

type NavSection = "appearance" | "assistant";

export function SettingsModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);

  const [activeSection, setActiveSection] = useState<NavSection>("appearance");
  const [config, setConfig] = useState<AssistantConfig>(DEFAULT_CONFIG);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [cliVersion, setCliVersion] = useState<string | null | undefined>(undefined);
  const [ollama, setOllama] = useState<OllamaProbeResult | undefined>(undefined);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    void (async () => {
      const [cfg, cli, hasKey, ol, prefs] = await Promise.all([
        getAssistantConfig().catch(() => DEFAULT_CONFIG),
        probeClaudeCli().catch(() => null),
        hasClaudeApiKey().catch(() => false),
        probeOllama().catch(
          (): OllamaProbeResult => ({ reachable: false, models: [], error: null }),
        ),
        loadPreferences().catch(() => ({ theme: "system" as ThemePreference })),
      ]);
      setConfig(cfg);
      setCliVersion(cli);
      setApiKeyConfigured(hasKey);
      setOllama(ol);
      setTheme(prefs.theme);
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
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const persist = async (next: AssistantConfig): Promise<void> => {
    setConfig(next);
    setStatus(null);
    try {
      await setAssistantConfig(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to save settings: ${message}`);
    }
  };

  const persistClaudeLane = (lane: ClaudeLane): Promise<void> =>
    persist({ ...config, provider: lane === "none" ? "" : "claude", claude_lane: lane });

  const persistTheme = async (next: ThemePreference): Promise<void> => {
    setTheme(next);
    // Broadcast so App re-applies immediately — no restart,
    // no reopen. Save happens in the background; a failure
    // here doesn't roll back the in-memory / visual state
    // (user's on-screen preference wins over a stale file).
    window.dispatchEvent(new CustomEvent("shax:preference-changed", { detail: { theme: next } }));
    try {
      await savePreferences({ theme: next });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to save theme: ${message}`);
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

          <div style={RIGHT_PANE}>
            {activeSection === "appearance" && (
              <AppearanceSection theme={theme} onPickTheme={persistTheme} />
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
}: {
  theme: ThemePreference;
  onPickTheme: (next: ThemePreference) => Promise<void>;
}): React.ReactElement {
  return (
    <section>
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
    </section>
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
