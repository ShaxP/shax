/**
 * Statusline — the bottom chrome row of the Shax window.
 *
 * M12.4 reshape: statusbar owns global, invariant-across-panes chrome.
 * Everything pane-specific (cwd, branch, ahead/behind, language) moved
 * to the prompt strip. Removed items and their reasons are documented
 * in specs/18-prompt-overhaul.md#m124.
 *
 * Shape:
 *
 *   Left cluster (mode indicator):
 *     - Resting: [COMMAND] / [CHAT] / [BLOCK] pill (M12.1 three-way).
 *     - Alt-screen: [INTERACTIVE][~/dev/shax] — INTERACTIVE takes a
 *       distinct cyan tone; the cwd chip replaces the per-pane context
 *       the user lost when the prompt strip got hidden by vim / htop /
 *       less. During alt-screen the vi sub-mode chip is suppressed
 *       (INTERACTIVE and vi-mode are mutually exclusive concepts —
 *       vim owns the modality once it's active).
 *
 *   Right cluster (global identity + status), left-to-right:
 *     - `me@laptop`  — session identity from the active pane's shim.
 *     - `13:37:02`   — live clock, ticks via a single App-level 1s
 *                       interval. Date on hover tooltip.
 *     - `⚠ N approval(s) pending` (amber, when > 0).
 *     - `+ assistant active` (when the dock is open).
 *
 * All chrome props are pushed in by App so this component stays pure /
 * presentational.
 */

import type { CSSProperties } from "react";

/**
 * The four surfaces that own the keyboard (M12.1 + M12.4):
 *
 *   - `COMMAND` — the prompt strip owns focus (resting state).
 *   - `CHAT` — the assistant input owns focus.
 *   - `BLOCK` — block-focus mode is engaged.
 *   - `INTERACTIVE` — an alt-screen program (vim, htop, less, top,
 *     REPL) owns the terminal. The prompt strip is hidden; the mode
 *     pill grows a second chip carrying the active pane's cwd so the
 *     user still has location context.
 *
 * Not vim editor modes — surface labels. Modal overlays (search,
 * palette, viewer, safety gate, settings, confirm-close) do not change
 * the pill; they own the keyboard while open but the pill reflects
 * what will regain focus when they close.
 */
export type StatuslineMode = "COMMAND" | "CHAT" | "BLOCK" | "INTERACTIVE";

/**
 * Vi sub-modes surfaced by the M12.2 zsh shim via `OSC 133;M`. Only
 * meaningful when the user picked Vi in preferences; the shim doesn't
 * emit the marker in Emacs mode. Values not in this map (`main`,
 * `emacs`, unrecognised) render no sub-chip — the pill stays single.
 */
export type ViSubMode = "INSERT" | "NORMAL" | "VISUAL";

/**
 * Map from a zsh KEYMAP value (as reported over OSC 133;M) to the
 * sub-mode label rendered in the pill. Returns `null` for anything
 * that doesn't correspond to a distinct visible vi mode — the pill
 * then hides the sub-chip.
 */
export function viSubModeFromKeymap(keymap: string | null): ViSubMode | null {
  if (keymap === null) return null;
  switch (keymap) {
    case "viins":
    case "main": // zsh's "main" aliases to whatever bindkey -e / -v set; in vi mode it's viins.
      return "INSERT";
    case "vicmd":
      return "NORMAL";
    case "visual":
      return "VISUAL";
    default:
      return null;
  }
}

/**
 * Battery snapshot for the right-cluster battery chip (M12.4b).
 * Mirrors `BatteryStatus` in `src-tauri/src/status.rs`. `present:
 * false` means either a desktop or a probe failure; the chip renders
 * a bare plug glyph in both cases (identical treatment is deliberate
 * — the user's mental model is "am I on wall power," and the answer
 * is yes in either case).
 */
export interface BatterySnapshot {
  present: boolean;
  percent: number | null;
  charging: boolean;
}

export interface StatuslineProps {
  /** See {@link StatuslineMode}. */
  mode?: StatuslineMode;
  /**
   * Only meaningful when `mode === "INTERACTIVE"`. The active pane's
   * cwd, rendered as a subdued chip next to the INTERACTIVE label so
   * a user in vim / htop / less still sees where they are. `null`
   * when unknown.
   */
  interactiveCwd?: string | null;
  /**
   * Raw zsh KEYMAP value from the most recent OSC 133;M on the active
   * pane (M12.2). Rendered as a second chip next to the primary mode
   * chip when the mode is COMMAND and the mapped sub-mode is non-null.
   * Ignored for CHAT / BLOCK / INTERACTIVE — those surfaces are outside
   * the shell prompt.
   */
  viKeymap?: string | null;
  /**
   * Session identity from the active pane's shim (M12.4). Both are
   * `null` until the first OSC 133 A arrives.
   */
  user?: string | null;
  host?: string | null;
  /**
   * Live clock — the current time formatted `HH:MM:SS`, pushed in by
   * App's single 1s interval. `null` disables the clock chip (used by
   * tests that don't care about time).
   */
  clock?: string | null;
  /**
   * Full localized date string for the clock's hover tooltip. Same
   * source as `clock`; falls back to no tooltip when `null`.
   */
  clockTooltip?: string | null;
  /**
   * M12.4b: snapshot of the host's power state. When omitted, the
   * chip hides entirely (used by tests that don't care and by
   * the browser dev shell before the first probe returns).
   */
  battery?: BatterySnapshot;
  /**
   * M12.4b: IPv4 address of the default-route interface. `null`
   * hides the chip (offline machine, VPN-only host, or probe
   * failure — all treated the same).
   */
  localIp?: string | null;
  /**
   * True when the assistant dock is open (M7.7b). Adds a small "+
   * assistant active" indicator on the right so users know the
   * dock is engaged even when the panel is scrolled.
   */
  assistantActive?: boolean;
  /**
   * Number of assistant tool calls waiting for user approval
   * (M7.7b). Rendered as an amber "⚠ N approval pending" chip
   * on the right so the user can find the pending modal from any
   * pane. `0` hides the chip.
   */
  approvalsPending?: number;
}

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: 30,
  background: "var(--titlebar)",
  borderTop: "1px solid var(--border)",
  fontSize: 11,
  fontFamily: "var(--font-ui)",
  flexShrink: 0,
};

const MODE_PILL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: "100%",
  padding: "0 13px",
  color: "#fff",
  fontWeight: 700,
  letterSpacing: "0.08em",
};

/** Per-mode background color. `COMMAND` / `CHAT` use the primary accent
 *  (typing surfaces the user actively engages); `BLOCK` gets amber to
 *  signal "you're navigating scrollback"; `INTERACTIVE` gets cyan to
 *  signal "a program owns the terminal now" — distinct from both
 *  accent and amber. */
const MODE_BACKGROUND: Record<StatuslineMode, string> = {
  COMMAND: "var(--accent)",
  CHAT: "var(--accent)",
  BLOCK: "var(--amber)",
  INTERACTIVE: "var(--cyan)",
};

/** Sub-chip (M12.2 vi sub-mode, M12.4 alt-screen cwd) sits directly
 *  right of the mode pill. Single subdued background so it reads as
 *  a continuation of the pill, not a separate widget. */
const SUB_MODE_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: "100%",
  padding: "0 11px",
  background: "var(--surface-hover)",
  color: "var(--fg)",
  fontWeight: 600,
  letterSpacing: "0.08em",
  fontSize: 10,
  borderRight: "1px solid var(--border)",
};

/** Alt-screen cwd chip — same shape as SUB_MODE_CHIP but with monospace
 *  font and no letter-spacing, since the cwd is a path (spatially
 *  meaningful) not an all-caps label. */
const INTERACTIVE_CWD_CHIP: CSSProperties = {
  ...SUB_MODE_CHIP,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0,
  color: "var(--fg-dim)",
  // Truncate long paths — never allow the alt-screen cwd chip to push
  // the right-side identity cluster off-screen.
  maxWidth: 320,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const RIGHT_CELL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 13px",
  color: "var(--fg-dim)",
  borderLeft: "1px solid var(--border)",
};

const IDENTITY_TEXT: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};

const CLOCK_TEXT: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  // Fixed-width tabular numerals so the seconds ticking doesn't
  // wiggle the neighbouring chrome left/right by a pixel each second.
  fontVariantNumeric: "tabular-nums",
};

/** M12.4b Nerd Font (Font Awesome) icon codepoints for the battery
 *  chip. Named per the FA icon names so a future reader can grep. */
const BATTERY_ICON = {
  full: "", // nf-fa-battery_full (100%)
  threeQuarters: "", // nf-fa-battery_three_quarters
  half: "", // nf-fa-battery_half
  quarter: "", // nf-fa-battery_quarter
  empty: "", // nf-fa-battery_empty
  plug: "", // nf-fa-plug
} as const;

/** Pick the discharging-battery fill glyph for a given percentage.
 *  Buckets follow the Font Awesome icon set: empty (< 12%), quarter
 *  (< 38%), half (< 62%), three-quarters (< 88%), full (>= 88%).
 *  Cutoffs sit at the midpoint between the FA levels (100% → full,
 *  75% → 3/4, 50% → 1/2, etc.). */
function batteryFillIcon(percent: number): string {
  if (percent < 12) return BATTERY_ICON.empty;
  if (percent < 38) return BATTERY_ICON.quarter;
  if (percent < 62) return BATTERY_ICON.half;
  if (percent < 88) return BATTERY_ICON.threeQuarters;
  return BATTERY_ICON.full;
}

/** Compose the battery chip's icon + label + colour for a snapshot.
 *  Returns `null` when the chip should be hidden entirely (currently
 *  never — the desktop path always renders the plug, per the spec's
 *  "consistent rule" reasoning). */
function batteryChip(
  battery: BatterySnapshot,
): { icon: string; label: string; amber: boolean; title: string } | null {
  if (!battery.present) {
    return {
      icon: BATTERY_ICON.plug,
      label: "",
      amber: false,
      title: "AC power (no battery detected)",
    };
  }
  const pct = battery.percent;
  const pctLabel = pct === null ? "?" : `${pct}%`;
  // On wall power = actively charging OR present at 100%. Fully-
  // charged plugged-in laptops report `charging: false` from the OS,
  // so the second half of the disjunction is what makes them show
  // the plug rather than the "battery full" glyph — matches the
  // user's mental model of "am I plugged in."
  const onWallPower = battery.charging || pct === 100;
  if (onWallPower) {
    return {
      icon: BATTERY_ICON.plug,
      label: pctLabel,
      amber: false,
      title: battery.charging ? `Charging (${pctLabel})` : `AC power (${pctLabel})`,
    };
  }
  const amber = pct !== null && pct < 20;
  return {
    icon: pct === null ? BATTERY_ICON.empty : batteryFillIcon(pct),
    label: pctLabel,
    amber,
    title: amber ? `Battery low (${pctLabel})` : `On battery (${pctLabel})`,
  };
}

const BATTERY_ICON_STYLE: CSSProperties = {
  fontFamily: "'JetBrainsMono Nerd Font', var(--font-mono), monospace",
  fontSize: 13,
  lineHeight: 1,
};

const BATTERY_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
};

const LOCAL_IP_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};

export function Statusline({
  mode = "COMMAND",
  interactiveCwd = null,
  viKeymap = null,
  user = null,
  host = null,
  clock = null,
  clockTooltip = null,
  battery,
  localIp = null,
  assistantActive = false,
  approvalsPending = 0,
}: StatuslineProps): React.ReactElement {
  const battery_ = battery !== undefined ? batteryChip(battery) : null;
  // Vi sub-mode rides alongside COMMAND only. INTERACTIVE gets the
  // cwd chip; the two states can't co-exist (vim owns the modality
  // once alt-screen is active).
  const subMode = mode === "COMMAND" ? viSubModeFromKeymap(viKeymap) : null;
  const showInteractiveCwd = mode === "INTERACTIVE" && interactiveCwd !== null;
  const identity = user !== null && host !== null ? `${user}@${host}` : (user ?? host ?? null);
  return (
    <div data-testid="statusline" style={ROW}>
      <span
        style={{ ...MODE_PILL, background: MODE_BACKGROUND[mode] }}
        data-testid="statusline-mode"
        data-mode={mode}
      >
        {mode}
      </span>
      {subMode !== null && (
        <span style={SUB_MODE_CHIP} data-testid="statusline-vi-submode" data-submode={subMode}>
          {subMode}
        </span>
      )}
      {showInteractiveCwd && (
        <span
          style={INTERACTIVE_CWD_CHIP}
          data-testid="statusline-interactive-cwd"
          title={interactiveCwd ?? undefined}
        >
          {interactiveCwd}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {identity !== null && (
        <span style={RIGHT_CELL} data-testid="statusline-identity">
          <span style={IDENTITY_TEXT}>{identity}</span>
        </span>
      )}
      {localIp !== null && (
        <span style={RIGHT_CELL} data-testid="statusline-local-ip" title="Local IP address">
          <span style={LOCAL_IP_STYLE}>{localIp}</span>
        </span>
      )}
      {battery_ !== null && (
        <span
          style={{ ...RIGHT_CELL, color: battery_.amber ? "var(--amber)" : "var(--fg-dim)" }}
          data-testid="statusline-battery"
          data-battery-present={battery?.present ? "true" : "false"}
          data-battery-charging={battery?.charging ? "true" : "false"}
          data-battery-amber={battery_.amber ? "true" : "false"}
          title={battery_.title}
        >
          <span style={BATTERY_ICON_STYLE}>{battery_.icon}</span>
          {battery_.label.length > 0 && <span style={BATTERY_LABEL_STYLE}>{battery_.label}</span>}
        </span>
      )}
      {clock !== null && (
        <span style={RIGHT_CELL} data-testid="statusline-clock" title={clockTooltip ?? undefined}>
          <span style={CLOCK_TEXT}>{clock}</span>
        </span>
      )}
      {approvalsPending > 0 && (
        <span
          data-testid="statusline-approvals-pending"
          style={{ ...RIGHT_CELL, color: "var(--amber)" }}
          title={
            approvalsPending === 1
              ? "One assistant command is waiting for your approval."
              : `${approvalsPending} assistant commands are waiting for your approval.`
          }
        >
          <span aria-hidden="true">⚠</span> {approvalsPending} approval
          {approvalsPending === 1 ? "" : "s"} pending
        </span>
      )}
      {assistantActive && (
        <span
          data-testid="statusline-assistant-active"
          style={{ ...RIGHT_CELL, color: "var(--accent)" }}
          title="The assistant dock is open."
        >
          <span aria-hidden="true">+</span> assistant active
        </span>
      )}
    </div>
  );
}
