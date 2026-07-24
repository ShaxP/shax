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
import "./AssistantOverlay.css";
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
import type { ApprovalPendingDetail, ApprovalResolveDetail } from "../safetyGate/SafetyGate";

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
  gap: 8,
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  background: "var(--pane2)",
};

// M7.7b: title row is "+ Shax" (sparkle-plus glyph + wordmark), a
// provider pill (claude / ollama), then the actions cluster (New +
// close) on the right. The old provider · model string moves into
// a tooltip on the provider pill so hover reveals the specific
// model without cluttering the header.
const HEADER_MARK: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--fg)",
};

const HEADER_MARK_GLYPH: CSSProperties = {
  color: "var(--accent)",
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1,
};

const PROVIDER_BADGE: CSSProperties = {
  fontSize: 10.5,
  fontFamily: "var(--font-mono)",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid var(--border-strong)",
  color: "var(--fg-dim)",
  textTransform: "lowercase",
  letterSpacing: 0.2,
};

const HEADER_SPACER: CSSProperties = { flex: 1 };

const NEW_BUTTON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 10px",
  border: "1px solid var(--border-strong)",
  background: "transparent",
  // Full pill — matches the design's rounded "+ New" affordance
  // next to the close ✕. The provider pill and the New button now
  // share the same corner radius.
  borderRadius: 999,
  color: "var(--fg-dim)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: 11.5,
};

const CLOSE_BUTTON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  border: "none",
  background: "transparent",
  borderRadius: 4,
  color: "var(--fg-faint)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  lineHeight: 1,
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
  // M7.7b: accent-outlined pill on the right instead of a solid
  // accent fill. Matches the design's chat-app treatment where
  // the user's replies read as active-voice chips. The bubble's
  // bottom-right corner is squared — the corner nearest the
  // sender — so the shape reads as a speech bubble with a tail.
  //
  // 1.5px border reads a touch more present than 1px against the
  // dark panel background — the accent gets a fair share of the
  // pixel without shouting.
  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
  border: "1.5px solid var(--accent)",
  color: "var(--fg)",
  borderRadius: "16px 16px 4px 16px",
};

// M7.7b (design pass 2): assistant replies are plain prose — no
// border, no background bubble. The `✦ Shax` label above each
// assistant turn (rendered by `TurnBubble` below) does the visual
// separation the border used to. Matches the design's "one-sided"
// chat layout where the assistant reads like inline documentation.
const BUBBLE_ASSISTANT: CSSProperties = {
  ...BUBBLE_BASE,
  alignSelf: "stretch",
  maxWidth: "100%",
  background: "transparent",
  border: "none",
  padding: "0 2px",
};

const BUBBLE_ERROR: CSSProperties = {
  ...BUBBLE_BASE,
  alignSelf: "flex-start",
  background: "transparent",
  border: "1px solid var(--red)",
  color: "var(--red)",
  padding: "8px 10px",
};

// Small "author" label rendered above every assistant + error turn so
// the reader can tell who's speaking without a bubble border.
const ASSISTANT_LABEL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--fg-dim)",
  marginBottom: 4,
};

const ASSISTANT_LABEL_STAR: CSSProperties = {
  color: "var(--accent)",
  fontSize: 12,
  lineHeight: 1,
};

const INPUT_AREA: CSSProperties = {
  padding: 10,
  borderTop: "1px solid var(--border)",
  background: "var(--pane2)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

// M7.7b design pass 3: the input reads as one visual field with the
// ✦ sparks icon flush left, the textarea filling the rest. The
// wrapper carries the border + background so the icon appears
// inside the same box the user is typing into.
const INPUT_FIELD: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "8px 10px",
  background: "var(--pane)",
  border: "1px solid var(--border)",
  borderRadius: 6,
};

const INPUT_ICON: CSSProperties = {
  color: "var(--accent)",
  fontSize: 13,
  lineHeight: 1.4,
  paddingTop: 2,
  flexShrink: 0,
};

const TEXTAREA: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 24,
  maxHeight: 160,
  padding: 0,
  background: "transparent",
  border: "none",
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
  lineHeight: 1.4,
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box",
};

// M7.7b: hint row below the textarea. Left cluster is action hints
// (send + goal mode placeholder), right cluster is the provider's
// privacy posture written as a single sentence — the reassurance
// the design surfaces at the bottom of the input.
const INPUT_HINT_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  fontSize: 10.5,
  color: "var(--fg-faint)",
};

const INPUT_HINT_LEFT: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 12,
};

const KBD_INLINE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  padding: "0 5px",
  border: "1px solid var(--border)",
  borderRadius: 3,
  color: "var(--fg-dim)",
  marginRight: 3,
};

const GOAL_MODE_BUTTON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "1px 6px",
  border: "1px solid var(--border)",
  borderRadius: 3,
  background: "transparent",
  color: "var(--fg-faint)",
  fontFamily: "var(--font-ui)",
  fontSize: 10.5,
  cursor: "not-allowed",
  opacity: 0.7,
};

const PRIVACY_STRIP: CSSProperties = {
  marginLeft: "auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 10.5,
  color: "var(--fg-dim)",
};

const PRIVACY_DOT: CSSProperties = {
  display: "inline-block",
  width: 5,
  height: 5,
  borderRadius: "50%",
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
    /** Inline approval lifecycle (M7.7d):
     *   - `pending`  — waiting for the user's click on the card.
     *   - `approved` — command approved; running or done.
     *   - `declined` — command dropped by the user.
     *  Retrospective turns restored from history default to
     *  `approved` since we only persist settled ones. */
    status?: "pending" | "approved" | "declined";
    /** Only set when kind === "destructive" — surfaces the same
     *  reason the modal used to show in its headline. */
    destructiveReason?: string | null;
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
    // Re-read config when the settings modal saves. Previously
    // piggy-backed on `shax:refocus-pane`, but that fired for
    // unrelated reasons (assistant Esc bounce) and re-minted the
    // provider object, which triggered the auto-focus effect and
    // yanked focus straight back onto the textarea (M7.7c fix).
    window.addEventListener("shax:preference-changed", refresh);
    return () => window.removeEventListener("shax:preference-changed", refresh);
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

  // Focus the panel on mount as a fallback. When a provider
  // is available the textarea takes focus instead (see the
  // effect below) so the user can start typing without an
  // extra click. Split from the Escape handler so a parent
  // re-render — which changes the `onClose` reference — does
  // NOT re-focus the panel and steal focus back from whatever
  // child currently owns it (e.g. the textarea).
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Escape from anywhere in the dock EXCEPT the textarea closes the
  // panel (M7.7c). The textarea handles its own Escape via React's
  // onKeyDown — see `handleTextareaKey` — where it bounces focus back
  // to the active pane instead of closing. Fully closing still uses
  // ⌘K / ? / the ✕ button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const target = e.target;
      if (target instanceof Element && target === textareaRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
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

  // ⌘K from the terminal bounces focus back into the assistant
  // textarea (M7.7c). App fires this event when the dock is
  // already open but the input doesn't have focus.
  useEffect(() => {
    const onFocusInput = (): void => {
      textareaRef.current?.focus();
    };
    window.addEventListener("shax:assistant-focus-input", onFocusInput);
    return () => window.removeEventListener("shax:assistant-focus-input", onFocusInput);
  }, []);

  // Alt+Enter approves the active pending APPROVAL card (M7.7d).
  // Bound at window level rather than the textarea because the
  // textarea is `disabled={streaming}` for the whole tool loop,
  // so it can't receive keydown while a proposal is pending.
  // Reads the latest turns via `turnsRef` so the effect doesn't
  // need to re-register on every turn update.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Enter" || !e.altKey) return;
      const pendingId = firstPendingToolCallId(turnsRef.current);
      if (pendingId === null) return;
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(
        new CustomEvent("shax:approval-resolve", {
          detail: { id: pendingId, decision: "approve" },
        }),
      );
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // The textarea is `disabled={streaming}` so it can't be typed into
  // mid-response. Browsers blur a focused element when it becomes
  // disabled — without this effect focus lands nowhere and xterm's
  // own focus behaviour tends to grab it, dropping the user into
  // the terminal after every reply (M7.7c). Only reclaim focus when
  // the disable orphaned it (activeElement is body / null); if the
  // user has meanwhile clicked or Esc'd elsewhere, respect that.
  useEffect(() => {
    if (streaming) return;
    if (provider === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    textareaRef.current?.focus();
  }, [streaming, provider]);

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
      // before the next appears. The APPROVAL card appears
      // immediately with Approve / Decline buttons (M7.7d) —
      // the flow now looks like: card visible → user clicks →
      // command runs (or is dropped) → result card appears.
      for (const call of collectedToolCalls) {
        const proposalTurnId = nextId();
        workingTurns = [
          ...workingTurns,
          {
            id: proposalTurnId,
            role: "tool_proposal",
            content: "",
            toolCall: {
              id: call.id,
              name: call.name,
              command: extractCommand(call),
              reason: extractReason(call),
              status: "pending",
            },
          },
        ];
        setTurns(workingTurns);

        const { result, status, destructiveReason } = await executeToolCall(call, proposalTurnId);
        workingTurns = workingTurns.map((t) => {
          if (t.id !== proposalTurnId || t.toolCall === undefined) return t;
          return {
            ...t,
            toolCall: {
              ...t.toolCall,
              status,
              destructiveReason: destructiveReason ?? null,
            },
          };
        });
        workingTurns = [
          ...workingTurns,
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
        setTurns(workingTurns);
      }
    }
  };

  /** Route a tool call through the safety gate + PTY + block
   *  capture. Returns the structured result to feed back to
   *  the model, the final proposal-turn status, and (if
   *  destructive) the reason the gate flagged. When the user
   *  declines the gate, we return a synthetic "declined"
   *  result so the model knows and can respond gracefully. */
  const executeToolCall = async (
    call: ToolCall,
    proposalTurnId: string,
  ): Promise<{
    result: CommandToolResult;
    status: "approved" | "declined";
    destructiveReason: string | null;
  }> => {
    const command = extractCommand(call);
    const reason = extractReason(call);
    if (targetPtyId === null) {
      return {
        result: {
          exit_code: null,
          duration_ms: null,
          output:
            "No active terminal pane. Ask the user to focus a pane first, then re-ask your question.",
          truncated: false,
        },
        status: "declined",
        destructiveReason: null,
      };
    }
    if (call.name !== "run_command" || command.length === 0) {
      return {
        result: {
          exit_code: null,
          duration_ms: null,
          output: `Unsupported tool: ${call.name}`,
          truncated: false,
        },
        status: "declined",
        destructiveReason: null,
      };
    }

    const paneId = targetPtyId;
    const start = performance.now();
    let destructiveReason: string | null = null;

    // The gate publishes `shax:approval-pending` for AI-sourced
    // proposals so the assistant can style the card as
    // destructive when needed. Latch the reason on the matching
    // proposal turn so the header can read "Destructive: …".
    const onPending = (e: Event): void => {
      const detail = (e as CustomEvent<ApprovalPendingDetail>).detail;
      if (detail.id !== call.id) return;
      if (detail.kind !== "destructive") return;
      destructiveReason = detail.destructiveReason ?? "flagged as dangerous";
      setTurns((prev) =>
        prev.map((t) =>
          t.id === proposalTurnId && t.toolCall !== undefined
            ? { ...t, toolCall: { ...t.toolCall, destructiveReason } }
            : t,
        ),
      );
    };
    window.addEventListener("shax:approval-pending", onPending);

    // Race: block-complete (approved happy path) vs
    // approval-resolve{decline} (early decline) vs 5-min timeout.
    // On approve we don't return early — we still need the block
    // output — but we flip the card's status right away so the
    // buttons disappear.
    const settled = await new Promise<
      | { kind: "settled"; blockId: string; duration_ms: number }
      | { kind: "declined" }
      | { kind: "timeout" }
    >((resolve) => {
      let done = false;
      const cleanup = (): void => {
        window.removeEventListener("shax:block-complete", onBlock);
        window.removeEventListener("shax:approval-resolve", onResolve);
      };
      const onBlock = (e: Event): void => {
        const detail = (
          e as CustomEvent<{
            paneId: string;
            blockId: string;
            source: "widget" | "ai" | "palette" | "user";
          }>
        ).detail;
        if (detail.paneId !== paneId) return;
        if (detail.source !== "ai") return;
        done = true;
        cleanup();
        resolve({
          kind: "settled",
          blockId: detail.blockId,
          duration_ms: Math.round(performance.now() - start),
        });
      };
      const onResolve = (e: Event): void => {
        const detail = (e as CustomEvent<ApprovalResolveDetail>).detail;
        if (detail.id !== call.id) return;
        if (detail.decision === "approve") {
          // Flip the card state now — buttons vanish, header
          // morphs. Keep waiting for block-complete.
          setTurns((prev) =>
            prev.map((t) =>
              t.id === proposalTurnId && t.toolCall !== undefined
                ? { ...t, toolCall: { ...t.toolCall, status: "approved" } }
                : t,
            ),
          );
          return;
        }
        done = true;
        cleanup();
        resolve({ kind: "declined" });
      };
      window.addEventListener("shax:block-complete", onBlock);
      window.addEventListener("shax:approval-resolve", onResolve);
      // Dispatch AFTER listeners are attached so the gate's
      // synchronous `shax:approval-pending` broadcast (via
      // onPending, above) is guaranteed to be caught. Do NOT
      // await between attach and dispatch.
      window.dispatchEvent(
        new CustomEvent("shax:emit-command", {
          detail: {
            paneId,
            command,
            source: "ai",
            reason,
            toolCallId: call.id,
          },
        }),
      );
      setTimeout(
        () => {
          if (done) return;
          cleanup();
          resolve({ kind: "timeout" });
        },
        5 * 60 * 1000,
      );
    });

    window.removeEventListener("shax:approval-pending", onPending);

    if (settled.kind === "declined") {
      return {
        result: {
          exit_code: null,
          duration_ms: null,
          output: "Declined by user.",
          truncated: false,
        },
        status: "declined",
        destructiveReason,
      };
    }
    if (settled.kind === "timeout") {
      return {
        result: {
          exit_code: null,
          duration_ms: null,
          output: "The command was not approved by the user (or timed out).",
          truncated: false,
        },
        status: "declined",
        destructiveReason,
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
      result: {
        exit_code: null,
        duration_ms: settled.duration_ms,
        output,
        truncated,
      },
      status: "approved",
      destructiveReason,
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
      return;
    }
    // Escape from the textarea bounces focus to the active pane's
    // prompt strip; the dock stays open (M7.7c). Bound here on the
    // element rather than the window listener so no capture-order
    // race between overlays can swallow it.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent("shax:refocus-pane"));
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
        <span data-testid="assistant-overlay-mark" style={HEADER_MARK}>
          <span aria-hidden="true" style={HEADER_MARK_GLYPH}>
            ✦
          </span>
          <span>Shax</span>
        </span>
        {provider !== null && (
          <span
            data-testid="assistant-overlay-provider"
            style={PROVIDER_BADGE}
            title={modelLabel.length > 0 ? `${providerLabel} · ${modelLabel}` : providerLabel}
          >
            {providerLabel}
          </span>
        )}
        <span style={HEADER_SPACER} />
        {turns.length > 0 && (
          <button
            data-testid="assistant-overlay-new"
            style={NEW_BUTTON}
            onClick={startNewConversation}
            disabled={streaming}
            type="button"
            title="Start a new conversation (clears history)"
          >
            <span aria-hidden="true">+</span>
            New
          </button>
        )}
        <button
          data-testid="assistant-overlay-close"
          style={CLOSE_BUTTON}
          onClick={onClose}
          type="button"
          title="Close (Esc)"
          aria-label="Close assistant"
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
            {(() => {
              const activePendingId = firstPendingToolCallId(turns);
              return turns.map((t) => (
                <TurnBubble
                  key={t.id}
                  turn={t}
                  isActivePending={t.role === "tool_proposal" && t.toolCall?.id === activePendingId}
                />
              ));
            })()}
          </div>

          <div style={INPUT_AREA}>
            <div style={INPUT_FIELD}>
              <span aria-hidden="true" style={INPUT_ICON}>
                ✦
              </span>
              <textarea
                ref={textareaRef}
                data-testid="assistant-overlay-input"
                className="assistant-overlay-textarea"
                placeholder="Ask Shax, or describe a command…"
                value={input}
                disabled={streaming}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleTextareaKey}
                onFocus={() => {
                  window.dispatchEvent(
                    new CustomEvent("shax:assistant-input-focus", {
                      detail: { focused: true },
                    }),
                  );
                }}
                onBlur={() => {
                  window.dispatchEvent(
                    new CustomEvent("shax:assistant-input-focus", {
                      detail: { focused: false },
                    }),
                  );
                }}
                style={TEXTAREA}
              />
            </div>
            <div style={INPUT_HINT_ROW}>
              <span style={INPUT_HINT_LEFT}>
                <span>
                  <kbd style={KBD_INLINE}>⏎</kbd>send
                </span>
                <span
                  data-testid="assistant-overlay-esc-hint"
                  title="Return focus to the terminal without closing the assistant."
                >
                  <kbd style={KBD_INLINE}>esc</kbd>terminal
                </span>
                <button
                  data-testid="assistant-overlay-goal-mode"
                  type="button"
                  disabled
                  title="Goal mode — the assistant plans and runs a sequence of commands to reach a goal you describe. Coming soon."
                  style={GOAL_MODE_BUTTON}
                >
                  <kbd style={{ ...KBD_INLINE, marginRight: 3 }}>⌘G</kbd>goal mode
                </button>
              </span>
              <PrivacyStrip provider={provider} />
            </div>
          </div>

          <CapabilityStrip provider={provider} />
        </>
      )}
    </div>
  );
}

function TurnBubble({
  turn,
  isActivePending = false,
}: {
  turn: ChatTurn;
  isActivePending?: boolean;
}): React.ReactElement {
  if (turn.role === "tool_proposal")
    return <ToolProposalBubble turn={turn} isActivePending={isActivePending} />;
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
  // Assistant + error turns get a "✦ Shax" author label above the
  // content — the visual separation the removed border used to do.
  // User turns don't get a label; the bubble alignment + shape are
  // enough to signal authorship.
  const showLabel = turn.role === "assistant" || turn.role === "error";
  return (
    <div data-testid={`assistant-overlay-turn-${turn.role}`} style={style}>
      {showLabel && (
        <div data-testid="assistant-overlay-author" style={ASSISTANT_LABEL}>
          <span aria-hidden="true" style={ASSISTANT_LABEL_STAR}>
            ✦
          </span>
          <span>Shax</span>
        </div>
      )}
      {showEllipsis ? "…" : rendersMarkdown ? <ChatMarkdown text={turn.content} /> : turn.content}
    </div>
  );
}

// M7.7b + M7.7d: solid amber card matching the design's APPROVAL
// REQUIRED treatment. As of M7.7d the card owns the actual
// approve / decline — the safety-gate modal no longer renders for
// AI-sourced commands. Card style shifts by status:
//   - pending   → amber (default below)
//   - approved  → muted, no actions
//   - declined  → muted, no actions
//   - destructive-pending → red border + red Approve button
const TOOL_PROPOSAL_BUBBLE: CSSProperties = {
  ...BUBBLE_BASE,
  alignSelf: "flex-start",
  maxWidth: "95%",
  background: "color-mix(in srgb, var(--amber) 10%, transparent)",
  border: "1px solid var(--amber)",
  borderRadius: 8,
  fontSize: 12,
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const TOOL_PROPOSAL_BUBBLE_DESTRUCTIVE: CSSProperties = {
  ...TOOL_PROPOSAL_BUBBLE,
  background: "color-mix(in srgb, var(--red) 10%, transparent)",
  border: "1px solid var(--red)",
};

const TOOL_PROPOSAL_BUBBLE_SETTLED: CSSProperties = {
  ...TOOL_PROPOSAL_BUBBLE,
  background: "var(--pane2)",
  border: "1px solid var(--border)",
};

const TOOL_PROPOSAL_ACTIONS: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 2,
};

const TOOL_PROPOSAL_BUTTON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "5px 10px",
  borderRadius: 4,
  border: "1px solid var(--border-strong)",
  background: "var(--pane2)",
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  cursor: "pointer",
};

const TOOL_PROPOSAL_BUTTON_APPROVE: CSSProperties = {
  ...TOOL_PROPOSAL_BUTTON,
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
};

const TOOL_PROPOSAL_BUTTON_APPROVE_DESTRUCTIVE: CSSProperties = {
  ...TOOL_PROPOSAL_BUTTON,
  background: "var(--red)",
  borderColor: "var(--red)",
  color: "#fff",
  fontWeight: 600,
};

// Small chord glyph shown on the right of the Approve button when
// its card is the active pending. Reads as a chip embedded in the
// button so the shortcut is discoverable next to the action —
// matching the old modal's "(Enter)" hint (M7.7d).
const APPROVE_MNEMONIC: CSSProperties = {
  marginLeft: 8,
  padding: "1px 6px",
  borderRadius: 4,
  fontSize: 10.5,
  fontFamily: "var(--font-mono)",
  fontWeight: 500,
  background: "rgba(255, 255, 255, 0.18)",
  color: "inherit",
  lineHeight: 1.3,
};

const TOOL_PROPOSAL_HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 10.5,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: "var(--amber)",
  fontWeight: 600,
};

const TOOL_PROPOSAL_HEADER_META: CSSProperties = {
  marginLeft: "auto",
  fontSize: 10.5,
  fontWeight: 400,
  color: "var(--fg-faint)",
  textTransform: "none",
  letterSpacing: 0,
};

const TOOL_COMMAND: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  padding: "8px 10px",
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  color: "var(--fg)",
};

const TOOL_META: CSSProperties = {
  color: "var(--fg-dim)",
  fontSize: 11,
};

const TOOL_OUTPUT: CSSProperties = {
  ...TOOL_COMMAND,
  maxHeight: 200,
  overflow: "auto",
};

/**
 * First tool-call id waiting on inline approval. Powers the
 * Alt+Enter shortcut and the `⌥⏎` mnemonic on the Approve button.
 * Returns `null` when nothing is pending.
 */
function firstPendingToolCallId(turns: ChatTurn[]): string | null {
  for (const t of turns) {
    if (t.role !== "tool_proposal") continue;
    if (t.toolCall?.status !== "pending") continue;
    return t.toolCall.id;
  }
  return null;
}

/**
 * Cheap heuristic for the "writes N files · staged" hint in the
 * APPROVAL card header (M7.7b). Not a security check — the safety
 * gate is the actual chokepoint — just a UI label to help the user
 * understand at a glance what the proposal is about to do.
 */
function commandEffectSummary(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "no-op";
  // Multi-command joined by && / ; — count them as sub-effects.
  const parts = trimmed
    .split(/&&|;/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const writes = parts.some((p) =>
    /^(sed\s+-i|rm\s|mv\s|cp\s|touch\s|mkdir\s|chmod\s|chown\s|tee\s|npm\s+install|pnpm\s+install|yarn\s+install|cargo\s+add|apt\s+install|brew\s+install|git\s+(commit|reset|checkout|merge|rebase|push|apply))/.test(
      p,
    ),
  );
  const stages = parts.some((p) => /^git\s+add/.test(p));
  const labels: string[] = [];
  if (writes) labels.push(`writes ${parts.length === 1 ? "1 file" : `${parts.length} files`}`);
  if (stages) labels.push("staged");
  if (labels.length === 0) return "side effect";
  return labels.join(" · ");
}

function ToolProposalBubble({
  turn,
  isActivePending = false,
}: {
  turn: ChatTurn;
  isActivePending?: boolean;
}): React.ReactElement {
  const command = turn.toolCall?.command ?? "";
  const summary = commandEffectSummary(command);
  const status = turn.toolCall?.status ?? "approved";
  const destructiveReason = turn.toolCall?.destructiveReason ?? null;
  const isDestructive = destructiveReason !== null;
  const isPending = status === "pending";

  const bubbleStyle = isPending
    ? isDestructive
      ? TOOL_PROPOSAL_BUBBLE_DESTRUCTIVE
      : TOOL_PROPOSAL_BUBBLE
    : TOOL_PROPOSAL_BUBBLE_SETTLED;

  let headerColor: string;
  let headerIcon: string;
  let headerText: string;
  if (status === "approved") {
    headerColor = "var(--fg-faint)";
    headerIcon = "✓";
    headerText = "Approved";
  } else if (status === "declined") {
    headerColor = "var(--fg-faint)";
    headerIcon = "✕";
    headerText = "Declined";
  } else if (isDestructive) {
    headerColor = "var(--red)";
    headerIcon = "⚠";
    headerText = `Destructive: ${destructiveReason}`;
  } else {
    headerColor = "var(--amber)";
    headerIcon = "⚠";
    headerText = "Approval required";
  }

  const emitResolve = (decision: "approve" | "decline"): void => {
    const detail: ApprovalResolveDetail = {
      id: turn.toolCall?.id ?? "",
      decision,
    };
    window.dispatchEvent(new CustomEvent("shax:approval-resolve", { detail }));
  };

  return (
    <div
      data-testid="assistant-overlay-turn-tool_proposal"
      data-status={status}
      data-destructive={isDestructive ? "true" : "false"}
      style={bubbleStyle}
    >
      <div style={{ ...TOOL_PROPOSAL_HEADER, color: headerColor }}>
        <span aria-hidden="true">{headerIcon}</span>
        <span>{headerText}</span>
        {isPending && (
          <span
            data-testid="assistant-overlay-turn-tool_proposal-summary"
            style={TOOL_PROPOSAL_HEADER_META}
          >
            {summary}
          </span>
        )}
      </div>
      {turn.toolCall?.reason !== undefined && turn.toolCall.reason.length > 0 && (
        <div style={TOOL_META}>{turn.toolCall.reason}</div>
      )}
      <div style={TOOL_COMMAND}>{command}</div>
      {isPending && (
        <div style={TOOL_PROPOSAL_ACTIONS}>
          <button
            data-testid="assistant-overlay-turn-tool_proposal-decline"
            type="button"
            style={TOOL_PROPOSAL_BUTTON}
            onClick={() => emitResolve("decline")}
          >
            Decline
          </button>
          <button
            data-testid="assistant-overlay-turn-tool_proposal-approve"
            type="button"
            style={
              isDestructive
                ? TOOL_PROPOSAL_BUTTON_APPROVE_DESTRUCTIVE
                : TOOL_PROPOSAL_BUTTON_APPROVE
            }
            onClick={() => emitResolve("approve")}
          >
            <span>{isDestructive ? "Run anyway" : "Approve"}</span>
            {isActivePending && (
              <span
                data-testid="assistant-overlay-turn-tool_proposal-approve-mnemonic"
                aria-hidden="true"
                style={APPROVE_MNEMONIC}
                title="Alt+Enter to approve"
              >
                ⌥⏎
              </span>
            )}
          </button>
        </div>
      )}
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

/**
 * Provider-appropriate privacy reassurance shown below the textarea
 * (M7.7b). Local providers get the design's "local · nothing leaves
 * this machine" line; cloud providers get a matching cloud sentence
 * so the user always knows where their prompt is about to travel.
 */
function PrivacyStrip({ provider }: { provider: AssistantProvider }): React.ReactElement {
  const local = provider.privacyPosture === "local";
  return (
    <span
      data-testid="assistant-overlay-privacy"
      data-posture={local ? "local" : "cloud"}
      style={PRIVACY_STRIP}
      title={
        local
          ? "Nothing you type is sent off this machine."
          : "Prompts go to a cloud API — see Settings for the exact provider."
      }
    >
      <span
        aria-hidden="true"
        style={{ ...PRIVACY_DOT, background: local ? "var(--green)" : "var(--accent)" }}
      />
      {local ? "local · nothing leaves this machine" : "cloud · prompts leave your machine"}
    </span>
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
