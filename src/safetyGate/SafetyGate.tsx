/**
 * The safety gate (M6 slice 1, spec §10).
 *
 * A single mount at the App root. Listens for the
 * `shax:emit-command` window event that widgets, the
 * assistant (§09), and eventually the pane command palette
 * (§14) use to propose a command. Classifies the proposal
 * via `policy.ts` and:
 *
 *   - **routine** → re-dispatch `shax:emit-command-approved`
 *     immediately (silent forwarding — spec §10 "not a nag").
 *   - **ai** or **destructive** → show a modal. Enter approves
 *     (running the command visibly in the prompt), Esc
 *     declines (drops it).
 *
 * `TerminalPane` listens for the *approved* event; the raw
 * request event no longer reaches it. That's the chokepoint
 * property spec §10 asks for — one place, every command.
 *
 * A pending modal blocks further proposals: a second
 * `shax:emit-command` while the first is being decided is
 * dropped. Keeps the UX simple and avoids stacking modals.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { classifyCommand, destructiveReason, type EmitSource } from "./policy";

/** Wire-format for the proposal event. Widgets currently
 *  don't set `source` (defaults to `"widget"`), `cwd`, or
 *  `reason` — those are for the assistant / palette later. */
export interface EmitCommandDetail {
  paneId: string;
  command: string;
  source?: EmitSource;
  cwd?: string | null;
  /** Human-readable rationale — set by the assistant when it
   *  proposes a tool call, so the modal can show *why*. */
  reason?: string;
}

/** Wire-format for the approved event that TerminalPane
 *  actually acts on. Identical to the request minus the
 *  gate-only metadata. */
export interface ApprovedCommandDetail {
  paneId: string;
  command: string;
  source: EmitSource;
}

interface Pending {
  detail: EmitCommandDetail;
  kind: "ai" | "destructive";
  reason: string | null;
}

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const PANEL: CSSProperties = {
  minWidth: 480,
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

const HEADLINE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 8,
};

const HEADLINE_DESTRUCTIVE: CSSProperties = {
  ...HEADLINE,
  color: "var(--red)",
};

const COMMAND_BOX: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  background: "var(--pane2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "8px 10px",
  margin: "8px 0",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const META_ROW: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  color: "var(--fg-faint)",
  margin: "2px 0",
};

const ACTIONS: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 12,
};

const BUTTON_BASE: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 4,
  border: "1px solid var(--border-strong)",
  background: "var(--pane2)",
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  cursor: "pointer",
};

const BUTTON_APPROVE: CSSProperties = {
  ...BUTTON_BASE,
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
};

const BUTTON_APPROVE_DESTRUCTIVE: CSSProperties = {
  ...BUTTON_BASE,
  background: "var(--red)",
  borderColor: "var(--red)",
  color: "#fff",
  fontWeight: 600,
};

export function SafetyGate(): React.ReactElement | null {
  const [pending, setPending] = useState<Pending | null>(null);
  // Ref mirror so the listener sees the latest value without
  // re-registering when a proposal is being decided.
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onProposal = (e: Event): void => {
      const detail = (e as CustomEvent<EmitCommandDetail>).detail;
      if (detail === null || detail === undefined) return;
      if (pendingRef.current !== null) {
        // Modal already open. Drop the second proposal to
        // avoid stacking modals. UX: user's own extra Space
        // press while thinking about a modal does nothing.
        return;
      }
      const source: EmitSource = detail.source ?? "widget";
      const classification = classifyCommand(detail.command, source);
      if (classification === "routine") {
        // Silent-forward. Every routine emit still passes
        // through here — this is the chokepoint. It just
        // doesn't show UI.
        dispatchApproved(detail, source);
        return;
      }
      setPending({
        detail,
        kind: classification,
        reason: destructiveReason(detail.command),
      });
    };
    window.addEventListener("shax:emit-command", onProposal);
    return () => window.removeEventListener("shax:emit-command", onProposal);
  }, []);

  // Steal keyboard focus when a modal opens, restore it on
  // close via the App-level refocus-pane signal (handled by
  // the caller — see App.tsx).
  useEffect(() => {
    if (pending === null) return;
    panelRef.current?.focus();
  }, [pending]);

  // Broadcast pending count to the App (statusline uses it for the
  // "⚠ N approval pending" chip). Fires on every open + close so
  // the chip appears with the modal and disappears with it. Count
  // is 0 or 1 today — the gate only tracks a single pending — but
  // the event carries a number for forward-compat.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("shax:approvals-pending", {
        detail: { count: pending === null ? 0 : 1 },
      }),
    );
  }, [pending]);

  // Keyboard: Enter approves, Esc declines. Listener attached
  // globally so it fires regardless of what has focus.
  useEffect(() => {
    if (pending === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        approve();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        decline();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending]);

  function approve(): void {
    const p = pendingRef.current;
    if (p === null) return;
    const source: EmitSource = p.detail.source ?? "widget";
    dispatchApproved(p.detail, source);
    setPending(null);
    window.dispatchEvent(new CustomEvent("shax:refocus-pane"));
  }

  function decline(): void {
    setPending(null);
    window.dispatchEvent(new CustomEvent("shax:refocus-pane"));
  }

  if (pending === null) return null;

  const isDestructive = pending.kind === "destructive";
  const headline = isDestructive
    ? `Destructive: ${pending.reason ?? "flagged as dangerous"}`
    : "Run this command?";

  return (
    <div
      data-testid="safety-gate"
      data-kind={pending.kind}
      style={BACKDROP}
      onClick={(e) => {
        // Backdrop click declines.
        if (e.target === e.currentTarget) decline();
      }}
    >
      <div ref={panelRef} tabIndex={-1} style={PANEL}>
        <div style={isDestructive ? HEADLINE_DESTRUCTIVE : HEADLINE}>{headline}</div>
        <div data-testid="safety-gate-command" style={COMMAND_BOX}>
          {pending.detail.command}
        </div>
        <div style={META_ROW}>pane: {pending.detail.paneId}</div>
        {pending.detail.cwd !== null && pending.detail.cwd !== undefined && (
          <div style={META_ROW}>cwd: {pending.detail.cwd}</div>
        )}
        {pending.detail.reason !== undefined && (
          <div style={META_ROW}>why: {pending.detail.reason}</div>
        )}
        <div style={ACTIONS}>
          <button
            data-testid="safety-gate-decline"
            style={BUTTON_BASE}
            onClick={decline}
            type="button"
          >
            Decline (Esc)
          </button>
          <button
            data-testid="safety-gate-approve"
            style={isDestructive ? BUTTON_APPROVE_DESTRUCTIVE : BUTTON_APPROVE}
            onClick={approve}
            type="button"
          >
            {isDestructive ? "Run anyway (Enter)" : "Approve (Enter)"}
          </button>
        </div>
      </div>
    </div>
  );
}

function dispatchApproved(detail: EmitCommandDetail, source: EmitSource): void {
  const approved: ApprovedCommandDetail = {
    paneId: detail.paneId,
    command: detail.command,
    source,
  };
  window.dispatchEvent(new CustomEvent("shax:emit-command-approved", { detail: approved }));
}
