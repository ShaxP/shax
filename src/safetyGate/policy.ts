/**
 * Safety-gate policy (M6 slice 1, spec §10).
 *
 * Every command proposed by a widget (§08), the assistant
 * (§09), or the pane command palette (§14) passes through
 * the gate. This module is the *policy* — pure functions
 * that classify a proposed command and answer the question
 * "how much friction should we put in front of the user
 * before running this?" The classification drives the
 * gate's UI (in `SafetyGate.tsx`), not the other way around.
 *
 * Three classifications:
 *
 *   - **routine**: widget-emitted, non-destructive. The user
 *     already picked the action on the widget; forwarding
 *     silently is the "not a nag" side of spec §10.
 *   - **destructive**: matches a known destructive pattern
 *     (`rm -rf`, `git push --force`, `git checkout .`,
 *     history rewrites, etc). Regardless of source, show a
 *     stronger confirmation with the danger called out.
 *   - **ai**: proposed by the assistant. Always show a
 *     modal — the user should see what the AI is doing.
 *     If it's *also* destructive, escalate to that mode.
 *
 * The classifier is intentionally over-cautious on the
 * destructive side: false positives cost the user one Enter
 * press; false negatives are how you delete a hard drive.
 */

/** Source the command came from. Set on the
 *  \`shax:emit-command\` event's detail. Widgets currently
 *  don't set it (defaulted to \`"widget"\`); the assistant
 *  and palette will when they arrive. */
export type EmitSource = "widget" | "ai" | "palette";

export type Classification = "routine" | "destructive" | "ai";

/** Classify a proposed command.
 *
 *  Order of precedence:
 *    1. Destructive pattern match — always wins.
 *    2. Source is \`ai\` or \`palette\` — modal path.
 *    3. Otherwise (source is \`widget\` or unspecified) —
 *       routine.
 */
export function classifyCommand(command: string, source: EmitSource): Classification {
  if (isDestructive(command)) return "destructive";
  if (source === "ai" || source === "palette") return "ai";
  return "routine";
}

/** True if the command matches any of the known destructive
 *  patterns. Anything that matches deserves a
 *  stronger-than-default confirmation.
 *
 *  Patterns intentionally err on the side of catching too
 *  much. Users can approve; they can't undo a bad rm.
 */
export function isDestructive(command: string): boolean {
  return destructiveReason(command) !== null;
}

/** Leading shell keywords and grouping that can sit in front of a
 *  real command inside a compound statement — `if …; then rm -rf x; fi`
 *  hands us the segment `then rm -rf x`, which no `^`-anchored pattern
 *  would match. */
const SEGMENT_PREFIX = /^(?:(?:then|else|elif|do|if|while|until|time)\s+|[!({]\s*)/;

/** Split a compound command into the individual commands it runs.
 *
 *  Deliberately does NOT split on a single `|`: the "piping remote
 *  script to a shell" pattern (`curl … | sh`) needs the pipe intact to
 *  match at all, and splitting it would turn one destructive command
 *  into two innocent-looking halves — weakening the gate rather than
 *  strengthening it.
 *
 *  Quoting is not parsed. `echo "a; b"` therefore splits, which can
 *  only ever produce a false positive — one extra Enter press, the
 *  trade this module already makes everywhere else.
 */
function commandSegments(command: string): string[] {
  const segments: string[] = [];
  for (const raw of command.split(/&&|\|\||;|\n/)) {
    let segment = raw.trim();
    for (;;) {
      const stripped = segment.replace(SEGMENT_PREFIX, "");
      if (stripped === segment) break;
      segment = stripped;
    }
    if (segment.length > 0) segments.push(segment);
  }
  return segments;
}

/** Match a single command (no `&&` / `;` chaining) against the
 *  destructive patterns. */
function segmentReason(segment: string): string | null {
  // rm handled specially because flag ORDER varies and the
  // "near / or $HOME" and wildcard cases are subsets of the
  // general "recursive force delete" catch-all.
  if (isRmRecursiveForce(segment)) {
    if (/\s(?:\/|\$HOME|~)(?:\s|$)/.test(segment)) return "recursive delete near / or $HOME";
    if (/\s\*(?:\s|$)/.test(segment)) return "wildcard force delete";
    return "recursive force delete";
  }

  for (const { test, reason } of REASONED_PATTERNS) {
    if (test.test(segment)) return reason;
  }
  return null;
}

/** Human-readable reason a command matched a destructive
 *  pattern. Returned for the modal's headline; null if not
 *  destructive.
 *
 *  Every pattern here is `^`-anchored, so before this looked at
 *  segments it only ever inspected the FIRST command in a compound
 *  statement. `rm -rf /tmp/x` was caught; `cd /tmp && rm -rf x` and
 *  `test -d /tmp/x && rm -rf /tmp/x` were not — and a model asked to
 *  delete a directory that may not exist will readily emit the guarded
 *  form. The guard defeated the anchor and the user got the ordinary
 *  approval card for a recursive delete.
 *
 *  The whole string is still tested first, because the pipe-to-shell
 *  pattern only matches with its pipe in place. Segments are tested
 *  after, so a destructive command anywhere in a chain is caught.
 */
export function destructiveReason(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;

  const whole = segmentReason(trimmed);
  if (whole !== null) return whole;

  for (const segment of commandSegments(trimmed)) {
    const reason = segmentReason(segment);
    if (reason !== null) return reason;
  }
  return null;
}

/** Does the command have `-r` (or `-R` or `--recursive`) AND
 *  `-f` (or `--force`), in any flag ordering / clustering?
 *  Split on whitespace + character-check each cluster so we
 *  catch `-rf`, `-vrf`, `-rvf`, `-r -f`, `--recursive --force`,
 *  and every variant thereof. */
function isRmRecursiveForce(cmd: string): boolean {
  const m = /^(?:sudo\s+)?rm\s+/.exec(cmd);
  if (m === null) return false;
  const args = cmd.slice(m[0].length).split(/\s+/);
  let hasRecursive = false;
  let hasForce = false;
  for (const arg of args) {
    if (arg === "--recursive") {
      hasRecursive = true;
      continue;
    }
    if (arg === "--force") {
      hasForce = true;
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (arg.startsWith("-") && arg.length > 1) {
      const chars = arg.slice(1);
      if (chars.includes("r") || chars.includes("R")) hasRecursive = true;
      if (chars.includes("f")) hasForce = true;
    }
  }
  return hasRecursive && hasForce;
}

interface ReasonedPattern {
  test: RegExp;
  reason: string;
}

// Non-rm patterns. Order matters — first match wins, so put
// more specific patterns above their catch-all counterparts.
const REASONED_PATTERNS: readonly ReasonedPattern[] = [
  // git force-push / history rewrites
  {
    test: /^git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+push\b.*(?:--force\b|--force-with-lease\b|\s-f\b)/,
    reason: "force push",
  },
  {
    test: /^git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+(?:rebase|reset)\s+.*--hard\b/,
    reason: "hard reset / rebase — irrecoverable local changes",
  },
  { test: /^git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+filter-branch\b/, reason: "history rewrite" },
  { test: /^git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+filter-repo\b/, reason: "history rewrite" },
  {
    test: /^git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+clean\s+(?:-[a-zA-Z]*f[a-zA-Z]*|-\w*d\w*f\w*)\b/,
    reason: "untracked-file clean",
  },
  {
    test: /^git(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+checkout\s+(?:-{1,2}\s+)?[.]\s*$/,
    reason: "discard all local changes",
  },

  // shutdown / reboot / dd / mkfs / disk-touching
  { test: /^\s*(?:sudo\s+)?(?:shutdown|reboot|halt|poweroff)\b/, reason: "system shutdown" },
  { test: /^\s*(?:sudo\s+)?dd\s+/, reason: "raw disk write" },
  { test: /^\s*(?:sudo\s+)?mkfs(?:\.\w+)?\s+/, reason: "format filesystem" },

  // curl | sh style
  {
    test: /(?:curl|wget)\b.*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/,
    reason: "piping remote script to a shell",
  },

  // Sudo su / root escalation flags
  { test: /^\s*sudo\s+-s\b/, reason: "root shell" },
  { test: /^\s*sudo\s+su\b/, reason: "root shell" },
];
