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
import { ChatMarkdown } from "./ChatMarkdown";
import { FEATURES, featureAvailable } from "./features";
import { clearChatHistory, loadChatHistory, saveChatHistory } from "./history";
import { providerFromConfig } from "./providerFactory";
import type { AssistantProvider, Message, ToolCall } from "./provider";
import {
  DEFAULT_TOOLS,
  SYSTEM_PROMPT_WITH_TOOLS,
  truncateOutput,
  type CommandToolResult,
} from "./tools";
import { getAssistantConfig, type AssistantConfig } from "../settings/config";
import { getBlockOutput } from "../lib/ipc";

// M7.7a: no longer `position: fixed`. The parent (App's `<main>`) lays
// out `[tab-area | divider | assistant-panel]` as a flex row; this
// panel is a plain flex-column child whose width is set by App from
// the persisted `assistant_dock_width` preference. Height fills the
// tab-host row.
const PANEL: CSSProperties = {
  height: "100%",
  minWidth: 0,
  background: "var(--pane)",
  borderLeft: "1px solid var(--border-strong)",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  color: "var(--fg)",
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
  role: "user" | "assistant" | "error" | "tool_proposal" | "tool_result";
  content: string;
  /** True while the assistant turn is still streaming. */
  streaming?: boolean;
  /** For tool-proposal turns: the model's `run_command` call
   *  the user is being asked to approve (or the executed
   *  result if approval already happened). */
  toolCall?: {
    id: string;
    name: string;
    command: string;
    reason: string;
  };
  /** For tool-result turns: the structured result fed back
   *  to the model. Rendered as a small preview under the
   *  tool proposal. */
  toolResult?: {
    exit_code: number | null;
    duration_ms: number | null;
    output: string;
    truncated: boolean;
  };
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
  /** The pane the assistant should target for
   *  `run_command` tool calls. `null` when no pane is
   *  focused or no PTY has spawned yet — tool calls are
   *  disabled in that state. App resolves this from
   *  `activeTab.panes[focusedPaneId].ptyId`. */
  targetPtyId: string | null;
}

export function AssistantOverlay({
  onClose,
  seededPrompt,
  onSeedConsumed,
  onOpenSettings,
  targetPtyId,
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

  // Load persisted chat history on mount so the user picks
  // up where they left off. The overlay stays functional
  // even if the load fails (empty history is a valid state).
  useEffect(() => {
    void loadChatHistory().then((history) => {
      if (history.turns.length === 0) return;
      setTurns(
        history.turns.map((t): ChatTurn => {
          const role: ChatTurn["role"] =
            t.role === "user" || t.role === "error" ? t.role : "assistant";
          return { id: nextId(), role, content: t.content };
        }),
      );
    });
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

  // Focus the panel on mount as a fallback; close via
  // Escape. When a provider is available the textarea takes
  // focus instead (see the effect below) so the user can
  // start typing without an extra click.
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

  // When the provider resolves, hand focus to the textarea so
  // the user can type immediately. If the provider stays
  // null (nothing configured), leave focus on the panel so
  // the "Open Settings" button is reachable via Tab / Enter.
  useEffect(() => {
    if (provider === null) return;
    textareaRef.current?.focus();
  }, [provider]);

  // Auto-scroll to bottom as messages / streaming deltas
  // arrive.
  useEffect(() => {
    const el = messagesRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const persistTurns = (settled: ChatTurn[]): void => {
    void saveChatHistory({
      turns: settled
        // Tool proposal / result turns don't round-trip cleanly
        // through persistence (their metadata lives in
        // `toolCall` / `toolResult`, not `content`). Skip them
        // for now — history restore treats them as ephemeral.
        .filter((t) => t.role === "user" || t.role === "assistant" || t.role === "error")
        .map((t) => ({ role: t.role, content: t.content, created_ms: 0 })),
    });
  };

  const sendPrompt = async (text: string): Promise<void> => {
    if (streamingRef.current) return;
    if (provider === null) return;
    if (text.trim().length === 0) return;
    const userTurn: ChatTurn = { id: nextId(), role: "user", content: text };
    setTurns((prev) => [...prev, userTurn]);
    setInput("");
    setStreaming(true);
    streamingRef.current = true;

    try {
      await runToolLoop(provider, [...turnsRef.current, userTurn]);
    } finally {
      setTurns((prev) => {
        // Clear any dangling streaming flag on the last
        // assistant turn — provider may have surfaced only
        // text without a `done` event.
        const settled = prev.map((t) => (t.streaming === true ? { ...t, streaming: false } : t));
        persistTurns(settled);
        return settled;
      });
      setStreaming(false);
      streamingRef.current = false;
    }
  };

  /** The multi-turn tool loop. Streams one turn from the
   *  provider; if it proposes a `run_command` tool call, we
   *  route through the safety gate, wait for the block to
   *  complete, capture its output, feed the structured
   *  result back, and re-stream. Loops until the provider
   *  emits a `done` event without a pending tool call. */
  const runToolLoop = async (
    provider: AssistantProvider,
    startingTurns: ChatTurn[],
  ): Promise<void> => {
    let workingTurns: ChatTurn[] = startingTurns;
    // Safety valve — the model shouldn't loop forever.
    const MAX_ITERATIONS = 8;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const assistantTurn: ChatTurn = {
        id: nextId(),
        role: "assistant",
        content: "",
        streaming: true,
      };
      workingTurns = [...workingTurns, assistantTurn];
      setTurns(workingTurns);

      const tools = provider.capabilities.tools ? DEFAULT_TOOLS : undefined;
      // Prepend the tools-aware system prompt when tools are
      // enabled. Without it, models see the tool schema but
      // often default to "here's how you could do it
      // yourself" instead of actually calling the tool.
      const conversationMessages = turnsToMessages(workingTurns);
      const messages: Message[] =
        tools !== undefined
          ? [{ role: "system", content: SYSTEM_PROMPT_WITH_TOOLS }, ...conversationMessages]
          : conversationMessages;

      const collectedToolCalls: ToolCall[] = [];
      let assistantContent = "";
      let sawError = false;
      try {
        for await (const event of provider.stream({ messages, tools })) {
          if (event.kind === "text") {
            assistantContent += event.delta;
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantTurn.id ? { ...t, content: assistantContent } : t,
              ),
            );
          } else if (event.kind === "tool_call") {
            collectedToolCalls.push(event.call);
          } else if (event.kind === "error") {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantTurn.id
                  ? { ...t, role: "error", content: `Error: ${event.message}`, streaming: false }
                  : t,
              ),
            );
            sawError = true;
            break;
          } else if (event.kind === "done") {
            break;
          }
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
        return;
      }

      setTurns((prev) =>
        prev.map((t) => (t.id === assistantTurn.id ? { ...t, streaming: false } : t)),
      );
      workingTurns = workingTurns.map((t) =>
        t.id === assistantTurn.id ? { ...t, content: assistantContent, streaming: false } : t,
      );

      if (sawError) return;
      if (collectedToolCalls.length === 0) return;

      // Execute each proposed tool call. Runs sequentially so
      // the user sees one command approved and completed
      // before the next appears.
      for (const call of collectedToolCalls) {
        const result = await executeToolCall(call);
        workingTurns = [
          ...workingTurns,
          {
            id: nextId(),
            role: "tool_proposal",
            content: "",
            toolCall: {
              id: call.id,
              name: call.name,
              command: extractCommand(call),
              reason: extractReason(call),
            },
          },
          {
            id: nextId(),
            role: "tool_result",
            content: "",
            toolCall: {
              id: call.id,
              name: call.name,
              command: extractCommand(call),
              reason: extractReason(call),
            },
            toolResult: result,
          },
        ];
      }
      setTurns(workingTurns);
    }
  };

  /** Route a tool call through the safety gate + PTY + block
   *  capture. Returns the structured result to feed back to
   *  the model. When the user declines the gate, we return a
   *  synthetic "declined" result so the model knows and can
   *  respond gracefully. */
  const executeToolCall = async (call: ToolCall): Promise<CommandToolResult> => {
    const command = extractCommand(call);
    const reason = extractReason(call);
    if (targetPtyId === null) {
      return {
        exit_code: null,
        duration_ms: null,
        output:
          "No active terminal pane. Ask the user to focus a pane first, then re-ask your question.",
        truncated: false,
      };
    }
    if (call.name !== "run_command" || command.length === 0) {
      return {
        exit_code: null,
        duration_ms: null,
        output: `Unsupported tool: ${call.name}`,
        truncated: false,
      };
    }

    // Await the block-complete event correlated with this
    // emit. TerminalPane tags AI emits with source: "ai" via
    // the FIFO source queue.
    const paneId = targetPtyId;
    const start = performance.now();
    const blockComplete = new Promise<{
      blockId: string;
      exit_code: number | null;
      duration_ms: number | null;
    } | null>((resolve) => {
      let settled = false;
      const listener = (e: Event): void => {
        const detail = (
          e as CustomEvent<{
            paneId: string;
            blockId: string;
            source: "widget" | "ai" | "palette" | "user";
          }>
        ).detail;
        if (detail.paneId !== paneId) return;
        if (detail.source !== "ai") return;
        settled = true;
        window.removeEventListener("shax:block-complete", listener);
        resolve({
          blockId: detail.blockId,
          exit_code: null,
          duration_ms: Math.round(performance.now() - start),
        });
      };
      window.addEventListener("shax:block-complete", listener);
      // Bail if nothing arrives within a generous window —
      // gate declined, or the shell hung. 5 minutes.
      setTimeout(
        () => {
          if (settled) return;
          window.removeEventListener("shax:block-complete", listener);
          resolve(null);
        },
        5 * 60 * 1000,
      );
    });

    // Dispatch the AI-sourced emit. Safety gate intercepts,
    // shows the modal, and re-dispatches `-approved` on
    // approval.
    window.dispatchEvent(
      new CustomEvent("shax:emit-command", {
        detail: {
          paneId,
          command,
          source: "ai",
          reason,
        },
      }),
    );

    const settled = await blockComplete;
    if (settled === null) {
      return {
        exit_code: null,
        duration_ms: null,
        output: "The command was not approved by the user (or timed out).",
        truncated: false,
      };
    }

    // Fetch the block's captured output.
    let outputText: string;
    try {
      const bytes = await getBlockOutput(paneId, settled.blockId);
      outputText = new TextDecoder().decode(bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outputText = `(failed to fetch block output: ${message})`;
    }
    const { output, truncated } = truncateOutput(outputText);
    return {
      exit_code: settled.exit_code,
      duration_ms: settled.duration_ms,
      output,
      truncated,
    };
  };

  const startNewConversation = (): void => {
    if (streamingRef.current) return;
    setTurns([]);
    void clearChatHistory();
    textareaRef.current?.focus();
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
        {turns.length > 0 && (
          <button
            data-testid="assistant-overlay-new"
            style={CLOSE_BUTTON}
            onClick={startNewConversation}
            disabled={streaming}
            type="button"
            title="Start a new conversation (clears history)"
          >
            New
          </button>
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
  if (turn.role === "tool_proposal") return <ToolProposalBubble turn={turn} />;
  if (turn.role === "tool_result") return <ToolResultBubble turn={turn} />;
  const style =
    turn.role === "user" ? BUBBLE_USER : turn.role === "error" ? BUBBLE_ERROR : BUBBLE_ASSISTANT;
  const showEllipsis = turn.content.length === 0 && turn.streaming === true;
  // Assistant + error turns get markdown rendered — code
  // blocks, lists, links, tables all come out formatted.
  // User turns stay plain text: the user typed them, they
  // don't need a Markdown parser and treating them as
  // Markdown would surprise-format their own input.
  const rendersMarkdown = turn.role !== "user";
  return (
    <div data-testid={`assistant-overlay-turn-${turn.role}`} style={style}>
      {showEllipsis ? "…" : rendersMarkdown ? <ChatMarkdown text={turn.content} /> : turn.content}
    </div>
  );
}

const TOOL_PROPOSAL_BUBBLE: CSSProperties = {
  ...BUBBLE_ASSISTANT,
  borderColor: "var(--amber, #d09030)",
  borderStyle: "dashed",
  fontSize: 12,
};

const TOOL_COMMAND: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  padding: "4px 6px",
  background: "rgba(0, 0, 0, 0.35)",
  borderRadius: 4,
  marginTop: 4,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const TOOL_META: CSSProperties = {
  color: "var(--fg-faint)",
  fontSize: 11,
  marginTop: 4,
};

const TOOL_OUTPUT: CSSProperties = {
  ...TOOL_COMMAND,
  maxHeight: 200,
  overflow: "auto",
};

function ToolProposalBubble({ turn }: { turn: ChatTurn }): React.ReactElement {
  return (
    <div data-testid="assistant-overlay-turn-tool_proposal" style={TOOL_PROPOSAL_BUBBLE}>
      <div style={{ fontSize: 11, color: "var(--amber, #d09030)", letterSpacing: 0.4 }}>
        PROPOSED · run_command
      </div>
      {turn.toolCall?.reason !== undefined && turn.toolCall.reason.length > 0 && (
        <div style={TOOL_META}>Why: {turn.toolCall.reason}</div>
      )}
      <div style={TOOL_COMMAND}>{turn.toolCall?.command ?? ""}</div>
    </div>
  );
}

function ToolResultBubble({ turn }: { turn: ChatTurn }): React.ReactElement {
  const result = turn.toolResult;
  if (result === undefined) return <div />;
  const okColor =
    result.exit_code === 0
      ? "var(--green)"
      : result.exit_code === null
        ? "var(--fg-faint)"
        : "var(--red)";
  return (
    <div
      data-testid="assistant-overlay-turn-tool_result"
      style={{ ...BUBBLE_ASSISTANT, fontSize: 12 }}
    >
      <div style={{ fontSize: 11, color: okColor, letterSpacing: 0.4 }}>
        RESULT · exit {result.exit_code === null ? "—" : String(result.exit_code)}
        {result.duration_ms !== null && ` · ${result.duration_ms} ms`}
        {result.truncated && " · truncated"}
      </div>
      <div style={TOOL_OUTPUT}>{result.output.length === 0 ? "(no output)" : result.output}</div>
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
    if (t.role === "user") {
      out.push({ role: "user", content: t.content });
    } else if (t.role === "assistant") {
      // An assistant turn immediately followed by tool_proposal
      // turns needs the tool_use content blocks folded in so
      // Anthropic can match tool_result IDs back to the calls.
      // We capture that by looking ahead in the turns array —
      // but this simple flattener runs after the fact, so we
      // just look for consecutive tool_proposal siblings.
      const idx = turns.indexOf(t);
      const toolCalls: ToolCall[] = [];
      for (let i = idx + 1; i < turns.length; i++) {
        const next = turns[i];
        if (next?.role !== "tool_proposal") break;
        if (next.toolCall === undefined) break;
        toolCalls.push({
          id: next.toolCall.id,
          name: next.toolCall.name,
          input: { command: next.toolCall.command, reason: next.toolCall.reason },
        });
      }
      if (toolCalls.length > 0) {
        out.push({ role: "assistant", content: t.content, toolCalls });
      } else {
        out.push({ role: "assistant", content: t.content });
      }
    } else if (t.role === "tool_result" && t.toolCall !== undefined && t.toolResult !== undefined) {
      out.push({
        role: "tool",
        toolCallId: t.toolCall.id,
        content: JSON.stringify(t.toolResult),
      });
    }
    // Error + tool_proposal turns don't push anything new
    // themselves — tool_proposal was already folded into the
    // preceding assistant turn.
  }
  return out;
}

/** Extract the `command` argument from a `run_command` tool
 *  call. Defensive against malformed input from the model. */
function extractCommand(call: ToolCall): string {
  if (typeof call.input !== "object" || call.input === null) return "";
  const command = (call.input as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

/** Extract the `reason` argument. Optional in practice; the
 *  approval modal shows a fallback when missing. */
function extractReason(call: ToolCall): string {
  if (typeof call.input !== "object" || call.input === null) return "";
  const reason = (call.input as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : "";
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `turn-${idCounter}`;
}
