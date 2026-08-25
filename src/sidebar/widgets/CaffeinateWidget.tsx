/**
 * CaffeinateWidget (M13.4, spec §19 D6).
 *
 * A toggle that asks the OS to suppress idle sleep. It holds an
 * app-level power assertion rather than running a command in a pane —
 * see spec §19 D6 for the line this draws, and `src-tauri/src/power.rs`
 * for the per-platform mechanism.
 *
 * The earlier design emitted `caffeinate -di` into the focused pane's
 * scrollback. It was abandoned because a foreground `caffeinate`
 * blocks the pane it lands in: turning on a convenience toggle cost
 * the user a shell, and getting it back meant Ctrl+C or a new tab.
 * The honest-log principle was never the obstacle — see D6 on why a
 * power assertion is app state rather than shell state.
 *
 * The widget is nonetheless the *visible* record of that state. It is
 * pinned in the sidebar and readable at a glance whenever it is on,
 * which is what "no hidden state" asks for here.
 *
 * The backend owns the truth. Every transition reconciles against
 * what the OS actually granted, so a refused assertion shows as off
 * rather than as a toggle that lies.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useClock } from "../../lib/ClockContext";
import {
  onKeepAwakeChanged,
  powerKeepAwake,
  powerKeepAwakeState,
  type KeepAwakeState,
} from "../../lib/ipc";
import { currentPlatform, type Platform } from "../../lib/platform";
import { CARD } from "./styles";
import "./CaffeinateWidget.css";

/** Resting variant. Same as `CARD`, but with `borderColor` and
 *  `background` set explicitly so React's style-diffing cannot leak
 *  the previous render's longhand values into the resting render.
 *  Without this, switching from CARD_ACTIVE back to a bare CARD
 *  sometimes left the border in an intermediate state on some
 *  browsers — reported once as a "white border" on the off-state
 *  widget. */
const CARD_RESTING: CSSProperties = {
  ...CARD,
  background: "transparent",
  borderColor: "var(--border)",
};

/** The active card gains an accent border AND a soft accent-tinted
 *  background (M13.5 §D13, per `design/caffeinated-selected.png`).
 *  The border alone was called for by the spec's first pass but
 *  reads too subtly against the surrounding sidebar cards, all of
 *  which also carry borders. The soft fill is what makes the active
 *  card visibly a *different* thing from the resting cards, not
 *  just a differently-coloured version of the same thing.
 *
 *  Border weight is unchanged from the resting card — only the
 *  colour changes — because the accent hue on the border, plus the
 *  soft fill inside, already carry the state; growing the border
 *  thickness would shift the card's height and read as jitter on
 *  every toggle. */
const CARD_ACTIVE: CSSProperties = {
  ...CARD,
  background: "var(--accent-soft)",
  borderColor: "var(--accent)",
};

/** How long a failure message stays on the card before it reverts to
 *  the resting subtitle. Long enough to read, short enough that a
 *  transient failure doesn't become permanent furniture. */
const ERROR_LINGER_MS = 6000;

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const GLYPH: CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
  flexShrink: 0,
};

const TEXT_COLUMN: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
  flex: 1,
};

// Mixed-case bold rather than the ALL-CAPS `CARD_LABEL` the other
// cards use. Deliberate, and taken from the mockup: those labels name
// a *reading* ("CPU LOAD", "NETWORK"), where this names a *thing you
// operate*. The typographic difference is the tell that this card has
// a control in it.
const TITLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg)",
};

const SUBTITLE: CSSProperties = {
  fontSize: 11,
  // `--fg-faint` matches the mockup's rendering of `keep this Mac
  // awake` / `awake for N`. The title above is the reading; the
  // subtitle is context, and reading it at `--fg-dim` made it
  // compete with the title for attention.
  color: "var(--fg-faint)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const DURATION: CSSProperties = {
  ...SUBTITLE,
  fontFamily: "var(--font-mono)",
};

const ERROR_LINE: CSSProperties = {
  ...SUBTITLE,
  color: "var(--amber)",
};

const SWITCH_BASE: CSSProperties = {
  width: 34,
  height: 18,
  borderRadius: 9,
  border: "1px solid var(--border)",
  padding: 0,
  flexShrink: 0,
  position: "relative",
  cursor: "pointer",
  transition: "background 120ms ease-out",
  // The UA default focus ring on a native <button> can render as
  // a soft accent halo around the switch that reads visually as
  // "the card has an accent tint" after clicking the toggle. Custom
  // switch → custom (empty) focus; the click-target is unambiguous
  // and the switch's own colour carries the state.
  outline: "none",
};

const KNOB_BASE: CSSProperties = {
  position: "absolute",
  top: 2,
  width: 12,
  height: 12,
  borderRadius: "50%",
  background: "var(--fg)",
  transition: "left 120ms ease-out",
};

// Rail card carries the same border-colour + background contract as
// the extended card — off is transparent with a thin `--border`
// outline; on is `--accent-soft` filled with an `--accent` border.
// Without the outline the resting rail glyph read as loose furniture
// rather than a control the user could operate by expanding; with it
// the two states of the widget stay visually consistent between the
// two states of the sidebar.
//
// Compact padding (6 px) rather than the extended card's `10px 12px`
// — the rail's content area is ~40 px wide, so a 12 px horizontal
// padding would leave nothing for the glyph.
// 32 × 32 rounded square (explicit width AND height rather than
// width + aspectRatio so the shape is guaranteed 1:1 regardless of
// any flex quirk the container introduces). `alignSelf: center`
// opts out of the sidebar slot's default flex stretch so the
// dimensions are respected.
//
// The border treatment matches every outlined widget in the
// extended sidebar exactly — 1 px solid `--border` — so the rail's
// off-state feels consistent with the cards the user sees when the
// sidebar is open. Active flips only the colour to `--accent`,
// same 1 px width, so the toggle changes hue rather than weight.
const RAIL_ROOT_BASE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  alignSelf: "center",
  width: 32,
  height: 32,
  padding: 0,
  borderRadius: 8,
  fontSize: 15,
  cursor: "default",
  boxSizing: "border-box",
};

// Both variants declare the full `border` SHORTHAND, not longhands.
// This is load-bearing: the extended card carries `border: "1px
// solid var(--border)"` (see `CARD` in `styles.ts`), and when the
// sidebar transitions extended → rail, React sees `border` removed
// from the previous style object and clears it via
// `element.style.border = ""`. Per CSSOM that ALSO nukes every
// border-longhand on the DOM node. If the rail then declared its
// border via `borderColor` + `borderWidth` + `borderStyle`
// longhands, React would diff each against the previous prop
// value; unchanged ones (like `borderColor: "var(--border)"`) get
// skipped, leaving the DOM at `currentColor` (near-white in dark
// mode) — which reported as "thick white border, as if activated"
// on the collapse-after-expand path.
//
// Declaring the shorthand on both sides makes React overwrite the
// full border block on every transition, no longhand skip.
const RAIL_ROOT_RESTING: CSSProperties = {
  ...RAIL_ROOT_BASE,
  background: "transparent",
  border: "1px solid var(--border)",
};

const RAIL_ROOT_ACTIVE: CSSProperties = {
  ...RAIL_ROOT_BASE,
  background: "var(--accent-soft)",
  border: "1px solid var(--accent)",
};

export interface CaffeinateWidgetProps {
  /** Sidebar's expanded / rail state. */
  visible: boolean;
}

export function CaffeinateWidget({ visible }: CaffeinateWidgetProps): React.ReactElement {
  const platform = useMemo(() => currentPlatform(), []);
  const now = useClock();

  const [on, setOn] = useState(false);
  // Owned by the backend, not by this component. One assertion means
  // one start time, so every window renders the same duration.
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards a second click landing while the first round-trip is still
  // open, which would race two opposite requests against each other.
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const adopt = useCallback((state: KeepAwakeState): void => {
    if (!mountedRef.current) return;
    setOn(state.held);
    setStartedAtMs(state.held ? (state.since_ms ?? null) : null);
  }, []);

  // The assertion is process-wide and outlives this React tree, so a
  // reloaded or newly-opened window reads the real state back instead
  // of assuming off. Without this, a second window would render a
  // convincing "off" for a machine that is genuinely being kept awake.
  useEffect(() => {
    void powerKeepAwakeState().then(adopt);
  }, [adopt]);

  // ...and every window keeps following it, not just at mount. One
  // assertion, many widgets: toggling it in one window must move the
  // switch in all of them, or the others sit there lying about a
  // machine that is genuinely being kept awake.
  useEffect(() => onKeepAwakeChanged(adopt), [adopt]);

  useEffect(() => {
    if (error === null) return;
    const handle = setTimeout(() => setError(null), ERROR_LINGER_MS);
    return () => clearTimeout(handle);
  }, [error]);

  const toggle = useCallback((): void => {
    if (busy) return;
    const next = !on;
    setBusy(true);
    setError(null);
    void powerKeepAwake(next)
      // Reconcile against what the OS granted, not what we asked for.
      // Outside Tauri this always resolves to "off", which is the
      // honest answer: there is no OS here to keep awake.
      .then(adopt)
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        // `power::set` guarantees a failed acquire leaves the
        // assertion off, so mirroring that here cannot desync.
        setOn(false);
        setStartedAtMs(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  }, [adopt, busy, on]);

  const elapsed = on && startedAtMs !== null ? now.getTime() - startedAtMs : null;
  const tooltip = buildTooltip(on, error, platform);

  if (!visible) {
    return (
      // `key="rail"` — load-bearing. The extended card uses the
      // `border` SHORTHAND (see CARD in styles.ts) with a separate
      // `borderColor` longhand override; the rail's inline style is
      // materially different. When React reconciled the two off the
      // same DOM node during an extended → rail transition, its
      // style-prop diff left the border in an inconsistent state
      // (the reported "thick white border, as if activated"). A
      // distinct `key` here forces React to unmount the extended
      // div and mount a fresh one in the rail state, guaranteeing
      // no leftover inline-style state. Same reasoning for
      // `key="extended"` on the visible branch below.
      <div
        key="rail"
        data-testid="sidebar-caffeinate-rail"
        data-active={on ? "true" : "false"}
        style={on ? RAIL_ROOT_ACTIVE : RAIL_ROOT_RESTING}
        title={tooltip}
      >
        <span style={{ filter: on ? "none" : "grayscale(1)" }}>☕</span>
      </div>
    );
  }

  // Accent blue rather than green when active (M13.5 §D13). The
  // semantic here is active-vs-idle, not good-vs-bad, so accent —
  // the app-wide "user-selected active" colour — is honest where
  // green would read as "healthy."
  const switchStyle: CSSProperties = {
    ...SWITCH_BASE,
    background: on ? "var(--accent)" : "var(--surface)",
    opacity: busy ? 0.6 : 1,
  };

  return (
    <div
      // Paired with `key="rail"` above — see the comment there. The
      // distinct key on this branch forces a fresh mount on the
      // rail → extended transition too, so neither direction can
      // leak inline styles from the other's shorthand form.
      key="extended"
      data-testid="sidebar-caffeinate"
      data-active={on ? "true" : "false"}
      className={error !== null ? "shax-caffeinate-refusing" : undefined}
      style={on ? CARD_ACTIVE : CARD_RESTING}
      title={tooltip}
    >
      <div style={ROW}>
        <span style={GLYPH} aria-hidden="true">
          ☕
        </span>
        <div style={TEXT_COLUMN}>
          {/* Title flips verb → adjective on state. "Caffeinate"
              reads as an invitation to do the thing; "Caffeinated"
              reads as the state you're in. */}
          <span style={TITLE} data-testid="sidebar-caffeinate-title">
            {on ? "Caffeinated" : "Caffeinate"}
          </span>
          {renderSecondLine(on, elapsed, error, platform)}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={on ? "Stop keeping this computer awake" : "Keep this computer awake"}
          data-testid="sidebar-caffeinate-switch"
          style={switchStyle}
          onClick={toggle}
        >
          <span style={{ ...KNOB_BASE, left: on ? 18 : 2 }} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** The line under the title carries whichever of the three states is
 *  live: a failure, a running duration, or the resting explanation. */
function renderSecondLine(
  on: boolean,
  elapsed: number | null,
  error: string | null,
  platform: Platform,
): React.ReactElement {
  if (error !== null) {
    // The card is 280px wide with a nowrap line, so a backend message
    // long enough to be useful is a message long enough to be clipped
    // to uselessness. Short label here, whole thing in the tooltip.
    return (
      <span style={ERROR_LINE} data-testid="sidebar-caffeinate-error" title={error}>
        {shortenError(error)}
      </span>
    );
  }
  if (on && elapsed !== null) {
    // Duration is contextualised as "awake for N m N s" rather than
    // the bare `2m 14s` the M13.4 spec called for. A reader who
    // doesn't know what the number counts now does; the mono
    // treatment on the number keeps the reading itself glanceable.
    return (
      <span style={SUBTITLE} data-testid="sidebar-caffeinate-duration">
        awake for <span style={DURATION}>{formatDuration(elapsed)}</span>
      </span>
    );
  }
  return (
    <span style={SUBTITLE} data-testid="sidebar-caffeinate-subtitle">
      {on ? "keeping this computer awake" : subtitleFor(platform)}
    </span>
  );
}

/** Mirrors the mockup's "keep this Mac awake" line, corrected per
 *  platform so Linux and Windows users aren't told about a Mac. */
function subtitleFor(platform: Platform): string {
  return platform === "macos" ? "keep this Mac awake" : "keep this computer awake";
}

/** A few words that fit the card. The full message is always one
 *  hover away, and is what a bug report should quote. */
function shortenError(error: string): string {
  if (/not found|is missing/i.test(error)) return "not available on this system";
  return "couldn't keep awake";
}

function buildTooltip(on: boolean, error: string | null, platform: Platform): string {
  if (error !== null) return `Keep-awake failed: ${error}`;
  // Linux inhibits idle *system* sleep only. Screen blanking belongs
  // to the screensaver, which we deliberately don't touch — saying
  // "will not sleep" there would promise more than we deliver
  // (fidelity contract).
  if (platform === "linux") {
    return on
      ? "This computer will not go to sleep while this is on. The screen can still blank."
      : "Stop this computer sleeping while you're away (does not stop the screen blanking)";
  }
  return on
    ? "This computer will not sleep while this is on"
    : "Stop this computer sleeping while you're away";
}

/** "45s" / "2m 14s" / "1h 03m". Seconds are dropped past an hour — by
 *  then the useful signal is "still on," not the exact second. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
