/**
 * Assistant settings modal (M6 slice 2b).
 *
 * Grows on slice 2a: still one provider (Claude), but now
 * with a **lane picker** between the API key lane and the
 * subscription (Claude Code) lane. Persists the choice via
 * the `get_assistant_config` / `set_assistant_config` Rust
 * commands so the pick survives restarts.
 *
 * Opens on Cmd/Ctrl + `,`. Closes on Escape / backdrop /
 * close button.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  deleteClaudeApiKey,
  hasClaudeApiKey,
  setClaudeApiKey,
} from "../assistant/providers/claude/apiKey";
import { probeClaudeCli } from "../assistant/providers/claude/subscription";
import { getAssistantConfig, setAssistantConfig, type ClaudeLane } from "./config";

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
  minWidth: 560,
  maxWidth: 680,
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

const POSTURE_BADGE: CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  padding: "1px 6px",
  borderRadius: 3,
  border: "1px solid var(--border-strong)",
  letterSpacing: 0.4,
  color: "var(--fg-faint)",
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

export function SettingsModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);

  const [lane, setLane] = useState<ClaudeLane>("none");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [cliVersion, setCliVersion] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    void (async () => {
      const [cfg, cli, hasKey] = await Promise.all([
        getAssistantConfig().catch(() => ({ claude_lane: "none" as ClaudeLane })),
        probeClaudeCli().catch(() => null),
        hasClaudeApiKey().catch(() => false),
      ]);
      setLane(cfg.claude_lane ?? "none");
      setCliVersion(cli);
      setApiKeyConfigured(hasKey);
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

  const persistLane = async (next: ClaudeLane): Promise<void> => {
    setLane(next);
    setStatus(null);
    try {
      await setAssistantConfig({ provider: "claude", claude_lane: next, model: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to save lane: ${message}`);
    }
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
          <div style={SECTION_TITLE}>Assistant · Claude</div>
          <div style={LANE_LIST}>
            <LaneRow
              testId="settings-lane-none"
              title="Off"
              meta="Terminal works as usual. No assistant surface."
              posture={null}
              active={lane === "none"}
              onSelect={() => void persistLane("none")}
            />
            <LaneRow
              testId="settings-lane-api-key"
              title="Use my Anthropic API key"
              meta="Pay-per-token via api.anthropic.com. Key is stored in the OS keychain."
              posture="☁ cloud"
              active={lane === "api-key"}
              onSelect={() => void persistLane("api-key")}
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
              posture="☁ cloud"
              active={lane === "subscription"}
              disabled={!cliInstalled}
              onSelect={() => cliInstalled && void persistLane("subscription")}
            />
          </div>

          {lane === "api-key" && (
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

          {lane === "subscription" && cliInstalled && (
            <div style={LANE_BODY}>
              <div style={STATUS_ROW}>
                Shax spawns <code>claude</code> per request. Your subscription auth is handled by
                Claude Code — nothing is stored by Shax.
              </div>
            </div>
          )}

          {status !== null && (
            <div
              data-testid="settings-claude-message"
              style={{ ...STATUS_ROW, marginTop: 8, color: "var(--fg)" }}
            >
              {status}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LaneRow({
  testId,
  title,
  meta,
  posture,
  active,
  disabled = false,
  onSelect,
}: {
  testId: string;
  title: string;
  meta: string;
  posture: string | null;
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
      {posture !== null && (
        <span style={POSTURE_BADGE} title="This lane sends data to a cloud API">
          {posture}
        </span>
      )}
    </div>
  );
}
