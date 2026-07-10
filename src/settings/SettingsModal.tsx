/**
 * Assistant settings modal (M6 slice 3).
 *
 * Grows again: adds an Ollama section alongside Claude,
 * complete with a ⌂ local posture badge and a model dropdown
 * populated from the local daemon probe.
 *
 * The "active provider" pattern from spec §09 is realised
 * here as a **radio between provider blocks**. Selecting a
 * lane inside Claude sets `provider: "claude"`; selecting an
 * Ollama model sets `provider: "ollama"`. Only one provider
 * is active at a time.
 *
 * Opens on Cmd/Ctrl + `,`. Closes on Escape / backdrop / the
 * close button.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
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

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 90,
};

const PANEL: CSSProperties = {
  minWidth: 600,
  maxWidth: 720,
  maxHeight: "80vh",
  overflowY: "auto",
  background: "var(--pane)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  padding: 20,
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  color: "var(--fg)",
  outline: "none",
  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.5)",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 12,
};

const TITLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
};

const SECTION: CSSProperties = {
  marginTop: 12,
  paddingTop: 12,
  borderTop: "1px solid var(--border)",
};

const SECTION_TITLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-faint)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 8,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const LANE_LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const LANE_ROW: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--pane2)",
  cursor: "pointer",
};

const LANE_ROW_ACTIVE: CSSProperties = {
  ...LANE_ROW,
  borderColor: "var(--accent)",
  boxShadow: "inset 3px 0 0 var(--accent)",
};

const LANE_TITLE: CSSProperties = {
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const LANE_META: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-faint)",
  marginTop: 2,
};

const CLOUD_BADGE: CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  padding: "1px 6px",
  borderRadius: 3,
  border: "1px solid var(--border-strong)",
  letterSpacing: 0.4,
  color: "var(--fg-faint)",
};

const LOCAL_BADGE: CSSProperties = {
  ...CLOUD_BADGE,
  borderColor: "var(--green)",
  color: "var(--green)",
};

const LANE_BODY: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--pane2)",
};

const INPUT_ROW: CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 8,
};

const INPUT: CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  background: "var(--pane)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--fg)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const SELECT: CSSProperties = {
  ...INPUT,
  fontFamily: "var(--font-ui)",
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

const STATUS_ROW: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-faint)",
};

const DEFAULT_CONFIG: AssistantConfig = {
  provider: "",
  claude_lane: "none",
  claude_model: null,
  ollama_model: null,
  ollama_capabilities: null,
};

export function SettingsModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);

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
          <span style={TITLE}>Settings</span>
          <button data-testid="settings-close" style={BUTTON} onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div style={SECTION}>
          <div style={SECTION_TITLE}>Appearance</div>
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
                onSelect={() => void persistTheme(option)}
              />
            ))}
          </div>
          <div style={{ ...STATUS_ROW, marginTop: 6 }}>
            {theme === "system"
              ? "Follows the OS setting. Updates instantly when you flip macOS Appearance."
              : theme === "dark"
                ? "Dark palette, always."
                : "Light palette, always."}
          </div>
        </div>

        <div style={SECTION}>
          <div style={SECTION_TITLE}>
            <span>Assistant · Claude</span>
            <span style={CLOUD_BADGE} title="Requests go to Anthropic's cloud API">
              ☁ cloud
            </span>
          </div>
          <div style={LANE_LIST}>
            <LaneRow
              testId="settings-lane-none"
              title="Off"
              meta="Terminal works as usual. No assistant surface."
              active={!claudeActive && !ollamaActive}
              onSelect={() => void persistClaudeLane("none")}
            />
            <LaneRow
              testId="settings-lane-api-key"
              title="Use my Anthropic API key"
              meta="Pay-per-token via api.anthropic.com. Key is stored in the OS keychain."
              active={claudeActive && config.claude_lane === "api-key"}
              onSelect={() => void persistClaudeLane("api-key")}
            />
            <LaneRow
              testId="settings-lane-subscription"
              title="Use my Claude subscription (Claude Code)"
              meta={
                cliVersion === undefined
                  ? "Checking for Claude Code…"
                  : cliInstalled
                    ? `Detected: ${cliVersion}. Runs through your local install — Shax never sees the credential.`
                    : "Claude Code not installed. Install from claude.com/download to use this lane."
              }
              active={claudeActive && config.claude_lane === "subscription"}
              disabled={!cliInstalled}
              onSelect={() => cliInstalled && void persistClaudeLane("subscription")}
            />
          </div>

          {claudeActive && config.claude_lane === "api-key" && (
            <div style={LANE_BODY}>
              <div style={STATUS_ROW}>
                Key status:{" "}
                <span
                  data-testid="settings-claude-status"
                  style={{
                    color: apiKeyConfigured === true ? "var(--green)" : "var(--fg-faint)",
                  }}
                >
                  {apiKeyConfigured === null
                    ? "checking…"
                    : apiKeyConfigured
                      ? "configured"
                      : "not configured"}
                </span>
              </div>
              <div style={INPUT_ROW}>
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
                      void saveKey();
                    }
                  }}
                  style={INPUT}
                />
                <button
                  data-testid="settings-claude-save"
                  style={BUTTON_PRIMARY}
                  onClick={() => void saveKey()}
                  disabled={busy || apiKey.length === 0}
                  type="button"
                >
                  Save
                </button>
                {apiKeyConfigured === true && (
                  <button
                    data-testid="settings-claude-clear"
                    style={BUTTON}
                    onClick={() => void clearKey()}
                    disabled={busy}
                    type="button"
                    title="Remove the stored API key"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}

          {claudeActive && config.claude_lane === "subscription" && cliInstalled && (
            <div style={LANE_BODY}>
              <div style={STATUS_ROW}>
                Shax spawns <code>claude</code> per request. Your subscription auth is handled by
                Claude Code — nothing is stored by Shax.
              </div>
            </div>
          )}
        </div>

        <div style={SECTION}>
          <div style={SECTION_TITLE}>
            <span>Assistant · Ollama</span>
            <span style={LOCAL_BADGE} title="Nothing leaves your machine — nothing.">
              ⌂ local
            </span>
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
                      ? `Detected at localhost:11434 · ${ollama.models.length} model${ollama.models.length === 1 ? "" : "s"} installed`
                      : "Detected at localhost:11434 · no models installed yet. Run `ollama pull llama3.1` to get started."
                    : "Ollama daemon not reachable at localhost:11434. Install from ollama.com/download and start it."
              }
              active={ollamaActive}
              disabled={!ollamaReachable || ollama.models.length === 0}
              onSelect={() => {
                if (!ollamaReachable || ollama.models.length === 0) return;
                const first = ollama.models[0];
                void persist({
                  ...config,
                  provider: "ollama",
                  ollama_model: config.ollama_model ?? first ?? null,
                });
              }}
            />
          </div>

          {ollamaActive && ollamaReachable && ollama.models.length > 0 && (
            <div style={LANE_BODY}>
              <div style={STATUS_ROW}>Model:</div>
              <div style={INPUT_ROW}>
                <select
                  data-testid="settings-ollama-model"
                  value={config.ollama_model ?? ""}
                  onChange={(e) => void persistOllamaModel(e.target.value)}
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
                      ...STATUS_ROW,
                      marginTop: 6,
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
                  <div
                    data-testid="settings-ollama-capabilities-note"
                    style={{
                      ...STATUS_ROW,
                      marginTop: 6,
                      fontStyle: "italic",
                      color: "var(--fg-faint)",
                    }}
                  >
                    Capabilities reflect what the model{" "}
                    <em style={{ fontStyle: "normal", fontWeight: 600 }}>declares</em>, not tested
                    behaviour. Real-world tool use varies — smaller models (e.g. Llama 3.2 1B/3B)
                    often claim <code>tools</code> support but fabricate answers instead of calling
                    the tool. Try Qwen 2.5, Llama 3.1, or Mistral Nemo for reliable results.
                  </div>
                </>
              ) : (
                <div style={{ ...STATUS_ROW, marginTop: 6 }}>
                  Capabilities not probed yet — pick a model to detect tool + vision support.
                </div>
              )}
            </div>
          )}
        </div>

        {status !== null && (
          <div
            data-testid="settings-message"
            style={{ ...STATUS_ROW, marginTop: 8, color: "var(--fg)" }}
          >
            {status}
          </div>
        )}
      </div>
    </div>
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
        padding: "4px 12px",
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
}: {
  testId: string;
  title: string;
  meta: string;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
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
      }}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={disabled ? -1 : 0}
    >
      <div style={{ flex: 1 }}>
        <div style={LANE_TITLE}>{title}</div>
        <div style={LANE_META}>{meta}</div>
      </div>
    </div>
  );
}
