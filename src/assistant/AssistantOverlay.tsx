/**
 * Assistant chat overlay — right-side panel (M6 slice 4).
 *
 * The visible surface for everything M6 built:
 *
 *   - Instantiates the right provider from `AssistantConfig`
 *     via `providerFromConfig`.
 *   - Renders a running conversation; user turns on the
 *     right, assistant turns on the left with streaming
 *     text.
 *   - Shows a **capability strip** below the input listing
 *     the features available with the active provider (spec
 *     §09 "features degrade gracefully"). Unavailable ones
 *     are dimmed with tooltips.
 *   - Handles the `shax:assistant-ask` event so
 *     explain-on-error buttons on failed blocks can seed a
 *     prompt.
 *   - Not-configured empty state links to Settings.
 *
 * Cmd/Ctrl + K toggles from App. Escape closes. Focus is
 * stolen on open, restored to the active pane on close via
 * `shax:refocus-pane`.
 *
 * MVP scope — text only. No tool proposals, no image input,
 * no goal mode. Those all come after the safety-gate
 * integration for provider-emitted commands is designed.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_MODEL as CLAUDE_DEFAULT_MODEL } from "./providers/claude/apiKey";
import { DEFAULT_MODEL as OLLAMA_DEFAULT_MODEL } from "./providers/ollama/ollama";
import { FEATURES, featureAvailable } from "./features";
import { providerFromConfig } from "./providerFactory";
import type { AssistantProvider, Message, StreamEvent } from "./provider";
import { getAssistantConfig, type AssistantConfig } from "../settings/config";

const PANEL: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: 420,
  background: "var(--pane)",
  borderLeft: "1px solid var(--border-strong)",
  boxShadow: "-10px 0 30px rgba(0, 0, 0, 0.35)",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  color: "var(--fg)",
  zIndex: 80,
  outline: "none",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  background: "var(--pane2)",
};

const HEADER_TITLE: CSSProperties = {
  flex: 1,
  fontSize: 12,
  fontWeight: 600,
};

const HEADER_META: CSSProperties = {
  fontSize: 10,
  color: "var(--fg-faint)",
  fontFamily: "var(--font-mono)",
};

const POSTURE_BADGE: CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  padding: "1px 6px",
  borderRadius: 3,
  border: "1px solid var(--border-strong)",
  color: "var(--fg-faint)",
};

const CLOSE_BUTTON: CSSProperties = {
  padding: "2px 6px",
  border: "1px solid var(--border)",
  background: "var(--pane)",
  borderRadius: 3,
  color: "var(--fg)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: 11,
};

const MESSAGES: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const BUBBLE_BASE: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  maxWidth: "85%",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  lineHeight: 1.4,
};

const BUBBLE_USER: CSSProperties = {
  ...BUBBLE_BASE,
  alignSelf: "flex-end",
  background: "var(--accent)",
  color: "#fff",
};

const BUBBLE_ASSISTANT: CSSProperties = {
  ...BUBBLE_BASE,
  alignSelf: "flex-start",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
};

const BUBBLE_ERROR: CSSProperties = {
  ...BUBBLE_ASSISTANT,
  color: "var(--red)",
  borderColor: "var(--red)",
};

const INPUT_AREA: CSSProperties = {
  padding: 10,
  borderTop: "1px solid var(--border)",
  background: "var(--pane2)",
};

const TEXTAREA: CSSProperties = {
  width: "100%",
  minHeight: 40,
  maxHeight: 160,
  padding: 8,
  background: "var(--pane)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box",
};

const CAPABILITY_STRIP: CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "6px 10px",
  borderTop: "1px solid var(--border)",
  background: "var(--pane)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  color: "var(--fg-faint)",
  alignItems: "center",
  flexWrap: "wrap",
};

const CAPABILITY_BADGE: CSSProperties = {
  padding: "1px 6px",
  borderRadius: 3,
  border: "1px solid var(--border)",
};

const CAPABILITY_BADGE_AVAILABLE: CSSProperties = {
  ...CAPABILITY_BADGE,
  color: "var(--green)",
  borderColor: "var(--green)",
};

const CAPABILITY_BADGE_UNAVAILABLE: CSSProperties = {
  ...CAPABILITY_BADGE,
  color: "var(--fg-faint)",
  opacity: 0.55,
  cursor: "help",
};

const EMPTY_STATE: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: 20,
  textAlign: "center",
  color: "var(--fg-faint)",
};

const OPEN_SETTINGS_BUTTON: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 4,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "#fff",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

interface ChatTurn {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  /** True while the assistant turn is still streaming. */
  streaming?: boolean;
}

export interface AssistantOverlayProps {
  onClose: () => void;
  /** When set, the overlay auto-sends this on mount. Used by
   *  the explain-on-error button on failed blocks. */
  seededPrompt: string | null;
  onSeedConsumed: () => void;
  /** Fired when the user clicks "Open Settings" from the
   *  empty state — App opens the settings modal. */
  onOpenSettings: () => void;
}

export function AssistantOverlay({
  onClose,
  seededPrompt,
  onSeedConsumed,
  onOpenSettings,
}: AssistantOverlayProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const turnsRef = useRef<ChatTurn[]>([]);
  turnsRef.current = turns;

  // Load config on mount. If it changes mid-session (user
  // opens settings) we re-read after settings closes; App
  // fires `shax:refocus-pane` then, which we listen for.
  useEffect(() => {
    void getAssistantConfig().then(setConfig);
  }, []);

  useEffect(() => {
    const refresh = (): void => {
      void getAssistantConfig().then(setConfig);
    };
    // The settings modal doesn't emit a dedicated
    // "config-changed" event yet; re-read on focus-pane
    // signals + on window focus as a low-cost heuristic.
    window.addEventListener("shax:refocus-pane", refresh);
    return () => window.removeEventListener("shax:refocus-pane", refresh);
  }, []);

  const resolution = useMemo(() => {
    if (config === null) return null;
    return providerFromConfig(config);
  }, [config]);
  const provider: AssistantProvider | null = resolution?.provider ?? null;

  const providerLabel = useMemo(() => {
    if (provider === null) return "Assistant";
    return provider.displayName;
  }, [provider]);

  const modelLabel = useMemo(() => {
    if (config === null || provider === null) return "";
    if (provider.id === "claude") return config.claude_model ?? CLAUDE_DEFAULT_MODEL;
    if (provider.id === "ollama") return config.ollama_model ?? OLLAMA_DEFAULT_MODEL;
    return "";
  }, [config, provider]);

  // Focus the panel on mount; close via Escape.
  useEffect(() => {
    panelRef.current?.focus();
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

  // Auto-scroll to bottom as messages / streaming deltas
  // arrive.
  useEffect(() => {
    const el = messagesRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const sendPrompt = async (text: string): Promise<void> => {
    if (streamingRef.current) return;
    if (provider === null) return;
    if (text.trim().length === 0) return;
    const userTurn: ChatTurn = { id: nextId(), role: "user", content: text };
    const assistantTurn: ChatTurn = {
      id: nextId(),
      role: "assistant",
      content: "",
      streaming: true,
    };
    setTurns((prev) => [...prev, userTurn, assistantTurn]);
    setInput("");
    setStreaming(true);
    streamingRef.current = true;

    const messages: Message[] = turnsToMessages([...turnsRef.current, userTurn]);
    try {
      for await (const event of provider.stream({ messages })) {
        applyEvent(assistantTurn.id, event, setTurns);
        if (event.kind === "done" || event.kind === "error") break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTurns((prev) =>
        prev.map((t) =>
          t.id === assistantTurn.id
            ? { ...t, role: "error", content: `Error: ${message}`, streaming: false }
            : t,
        ),
      );
    } finally {
      // Ensure the streaming flag is cleared even if the
      // provider surfaced only text + closed without a done
      // event.
      setTurns((prev) =>
        prev.map((t) => (t.id === assistantTurn.id ? { ...t, streaming: false } : t)),
      );
      setStreaming(false);
      streamingRef.current = false;
    }
  };

  // Auto-send seeded prompt (from explain-on-error) once the
  // provider is available. Clear the seed via `onSeedConsumed`
  // so we don't re-send on rerender.
  useEffect(() => {
    if (seededPrompt === null) return;
    if (provider === null) return;
    if (streamingRef.current) return;
    onSeedConsumed();
    void sendPrompt(seededPrompt);
    // Provider + seed change independently. `sendPrompt`
    // reads the latest via closure so the deps here are just
    // the trigger inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seededPrompt, provider]);

  const handleTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendPrompt(input);
    }
  };

  const notConfigured = provider === null;

  return (
    <div
      data-testid="assistant-overlay"
      ref={panelRef}
      tabIndex={-1}
      style={PANEL}
      onKeyDown={(e) => {
        // Stop keydown bubbling to the terminal / block-focus
        // handlers when a message is being typed. Escape is
        // still handled at the window-level listener above.
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      <div style={HEADER}>
        <div style={HEADER_TITLE}>
          {providerLabel}
          {modelLabel.length > 0 && (
            <span style={{ ...HEADER_META, marginLeft: 6 }}>· {modelLabel}</span>
          )}
        </div>
        {provider !== null && (
          <span
            data-testid="assistant-overlay-posture"
            style={{
              ...POSTURE_BADGE,
              color: provider.privacyPosture === "local" ? "var(--green)" : "var(--fg-faint)",
              borderColor:
                provider.privacyPosture === "local" ? "var(--green)" : "var(--border-strong)",
            }}
            title={
              provider.privacyPosture === "local"
                ? "Nothing leaves your machine."
                : "Requests go to a cloud API."
            }
          >
            {provider.privacyPosture === "local" ? "⌂ local" : "☁ cloud"}
          </span>
        )}
        <button
          data-testid="assistant-overlay-close"
          style={CLOSE_BUTTON}
          onClick={onClose}
          type="button"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {notConfigured ? (
        <div style={EMPTY_STATE}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>
            No provider configured
          </div>
          <div>{resolution?.reason?.hint ?? "Choose a provider in Settings."}</div>
          <button
            data-testid="assistant-overlay-open-settings"
            style={OPEN_SETTINGS_BUTTON}
            onClick={onOpenSettings}
            type="button"
          >
            Open Settings
          </button>
        </div>
      ) : (
        <>
          <div ref={messagesRef} style={MESSAGES} data-testid="assistant-overlay-messages">
            {turns.length === 0 && (
              <div style={{ color: "var(--fg-faint)", fontSize: 12 }}>
                Type a message. The assistant is reached for, never intrusive.
              </div>
            )}
            {turns.map((t) => (
              <TurnBubble key={t.id} turn={t} />
            ))}
          </div>

          <div style={INPUT_AREA}>
            <textarea
              ref={textareaRef}
              data-testid="assistant-overlay-input"
              placeholder="Type a message… (Enter to send, Shift+Enter for a newline)"
              value={input}
              disabled={streaming}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleTextareaKey}
              style={TEXTAREA}
            />
          </div>

          <CapabilityStrip provider={provider} />
        </>
      )}
    </div>
  );
}

function TurnBubble({ turn }: { turn: ChatTurn }): React.ReactElement {
  const style =
    turn.role === "user" ? BUBBLE_USER : turn.role === "error" ? BUBBLE_ERROR : BUBBLE_ASSISTANT;
  return (
    <div data-testid={`assistant-overlay-turn-${turn.role}`} style={style}>
      {turn.content.length === 0 && turn.streaming === true ? "…" : turn.content}
    </div>
  );
}

function CapabilityStrip({ provider }: { provider: AssistantProvider }): React.ReactElement {
  return (
    <div style={CAPABILITY_STRIP} data-testid="assistant-overlay-capabilities">
      <span style={{ ...CAPABILITY_BADGE_AVAILABLE }} title="Streaming text always works.">
        text
      </span>
      {FEATURES.map((feature) => {
        const available = featureAvailable(feature, provider.capabilities);
        return (
          <span
            key={feature.id}
            data-testid={`assistant-overlay-cap-${feature.id}`}
            data-available={available}
            style={available ? CAPABILITY_BADGE_AVAILABLE : CAPABILITY_BADGE_UNAVAILABLE}
            title={available ? "Available with this provider." : feature.unavailableTooltip}
          >
            {feature.label}
            {available ? "" : " ✗"}
          </span>
        );
      })}
    </div>
  );
}

function turnsToMessages(turns: readonly ChatTurn[]): Message[] {
  const out: Message[] = [];
  for (const t of turns) {
    if (t.role === "user") out.push({ role: "user", content: t.content });
    else if (t.role === "assistant") out.push({ role: "assistant", content: t.content });
    // Error turns don't flow back to the provider.
  }
  return out;
}

function applyEvent(
  turnId: string,
  event: StreamEvent,
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>>,
): void {
  if (event.kind === "text") {
    setTurns((prev) =>
      prev.map((t) => (t.id === turnId ? { ...t, content: t.content + event.delta } : t)),
    );
  } else if (event.kind === "error") {
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId
          ? { ...t, role: "error", content: `Error: ${event.message}`, streaming: false }
          : t,
      ),
    );
  } else if (event.kind === "done") {
    setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, streaming: false } : t)));
  }
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `turn-${idCounter}`;
}
