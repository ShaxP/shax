/**
 * Minimal settings modal (M6 slice 2a).
 *
 * Just enough surface to configure the Claude API key. When
 * more providers land the modal grows a dropdown; for now
 * it's a single-provider affordance.
 *
 * Opens on `shax:open-settings` (a keybind or menu item
 * dispatches it). Closes on Escape / backdrop click / the
 * close button, restoring focus to the active pane.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  deleteClaudeApiKey,
  hasClaudeApiKey,
  setClaudeApiKey,
} from "../assistant/providers/claude/apiKey";

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
  minWidth: 520,
  maxWidth: 640,
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

const PROVIDER_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 0",
};

const PROVIDER_META: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-faint)",
};

const POSTURE_BADGE: CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  padding: "1px 6px",
  borderRadius: 3,
  border: "1px solid var(--border-strong)",
  letterSpacing: 0.4,
};

const INPUT_ROW: CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 8,
};

const INPUT: CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  background: "var(--pane2)",
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
  background: "var(--pane2)",
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
  marginTop: 6,
  fontSize: 11,
  color: "var(--fg-faint)",
};

export function SettingsModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    void hasClaudeApiKey().then((v) => setConfigured(v));
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

  const save = async (): Promise<void> => {
    if (apiKey.length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      await setClaudeApiKey(apiKey);
      setConfigured(true);
      setApiKey("");
      setStatus("API key saved to keychain.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to save: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      await deleteClaudeApiKey();
      setConfigured(false);
      setStatus("API key removed.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Failed to remove: ${message}`);
    } finally {
      setBusy(false);
    }
  };

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
          <div style={SECTION_TITLE}>Assistant</div>
          <div style={PROVIDER_ROW}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Claude (Anthropic API)</div>
              <div style={PROVIDER_META}>
                Pay-per-token via your Anthropic API key. Key is stored in the OS keychain and never
                leaves your machine except to reach api.anthropic.com.
              </div>
            </div>
            <span
              data-testid="settings-claude-posture"
              style={{ ...POSTURE_BADGE, color: "var(--fg-faint)" }}
              title="Requests go to Anthropic's cloud API"
            >
              ☁ cloud
            </span>
          </div>
          <div style={STATUS_ROW}>
            Status:{" "}
            <span
              data-testid="settings-claude-status"
              style={{
                color: configured === true ? "var(--green)" : "var(--fg-faint)",
              }}
            >
              {configured === null ? "checking…" : configured ? "configured" : "not configured"}
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
                  void save();
                }
              }}
              style={INPUT}
            />
            <button
              data-testid="settings-claude-save"
              style={BUTTON_PRIMARY}
              onClick={() => void save()}
              disabled={busy || apiKey.length === 0}
              type="button"
            >
              Save
            </button>
            {configured === true && (
              <button
                data-testid="settings-claude-clear"
                style={BUTTON}
                onClick={() => void clear()}
                disabled={busy}
                type="button"
                title="Remove the stored API key"
              >
                Remove
              </button>
            )}
          </div>
          {status !== null && (
            <div data-testid="settings-claude-message" style={{ ...STATUS_ROW, marginTop: 8 }}>
              {status}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
