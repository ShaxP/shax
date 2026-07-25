/**
 * `git commit` palette command (M8.4 spec §14).
 *
 * Form: single-line subject (required) + optional multiline body
 * + optional --signoff toggle (shown only when `user.email` is
 * set — otherwise `Signed-off-by:` would be meaningless).
 *
 * Body paragraphs (blank-line separated) become one `-m` per
 * paragraph, matching git's own convention for multi-line
 * commits without opening $EDITOR.
 *
 * Deliberately **does NOT** offer `--no-verify` — hook bypass is
 * a manual prompt-typing affordance per CLAUDE.md's hard
 * guardrails. Users who need it can type the command themselves.
 *
 * Matches on `ctx.gitRoot !== null`. The staged-changes precondition
 * is left to git itself: submitting with an empty index surfaces
 * git's own error in the scrollback, which is more informative
 * than a matcher-gated absence.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { gitUserEmail } from "../../../lib/ipc";
import { shellEscape } from "../../../lib/shellEscape";
import type { PaneContext } from "../../registry";
import {
  ERROR_BOX,
  FIELD_LABEL,
  FIELD_ROW,
  FOOTER,
  KBD,
  PANEL,
  PREVIEW,
  PREVIEW_LABEL,
  SUBMIT_BUTTON,
  TEXT_INPUT,
  TEXTAREA,
  TOGGLE_LABEL,
} from "./formStyles";

export interface GitCommitPanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

/** Split a body into paragraphs (blank-line separated). Trailing
 *  whitespace on individual lines is preserved; empty paragraphs
 *  are dropped. */
export function bodyParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function buildCommitCommand(subject: string, body: string, signoff: boolean): string {
  const parts = ["git", "commit", "-m", shellEscape(subject.trim())];
  for (const para of bodyParagraphs(body)) {
    parts.push("-m", shellEscape(para));
  }
  if (signoff) parts.push("--signoff");
  return parts.join(" ");
}

const SUBJECT_HELPER: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-faint)",
  marginTop: -4,
};

const SUBJECT_LEN_BAD: CSSProperties = {
  color: "var(--amber)",
};

export function GitCommitPanel({ ctx, onSubmit }: GitCommitPanelProps): React.ReactElement {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [signoff, setSignoff] = useState(false);
  const [signoffAvailable, setSignoffAvailable] = useState<boolean>(false);

  useEffect(() => {
    if (ctx.cwd === null) return;
    let cancelled = false;
    void gitUserEmail(ctx.cwd).then((email) => {
      if (cancelled) return;
      setSignoffAvailable(email !== null);
    });
    return () => {
      cancelled = true;
    };
  }, [ctx.cwd]);

  const trimmedSubject = subject.trim();
  const canSubmit = trimmedSubject.length > 0;
  const preview = canSubmit ? buildCommitCommand(subject, body, signoff) : "";
  // Convention: commit subjects should fit ≤ 72 chars for
  // git's own summary tools. Longer subjects still submit, but
  // we surface a soft warning in the helper text.
  const subjectTooLong = trimmedSubject.length > 72;

  const submit = (): void => {
    if (!canSubmit) return;
    onSubmit(buildCommitCommand(subject, body, signoff));
  };

  const handleSubjectKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  };

  return (
    <div style={PANEL} data-testid="palette-git-commit-panel">
      <div style={FIELD_ROW}>
        <label style={FIELD_LABEL} htmlFor="palette-git-commit-subject">
          Subject
        </label>
        <input
          id="palette-git-commit-subject"
          data-testid="palette-git-commit-subject"
          style={TEXT_INPUT}
          placeholder="Short summary (required, ≤ 72 chars)"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onKeyDown={handleSubjectKey}
          autoFocus
        />
        <div style={SUBJECT_HELPER}>
          <span style={subjectTooLong ? SUBJECT_LEN_BAD : undefined}>
            {trimmedSubject.length}/72
          </span>
          {subjectTooLong && <span> — will commit anyway, but git tools may truncate.</span>}
        </div>
      </div>

      <div style={FIELD_ROW}>
        <label style={FIELD_LABEL} htmlFor="palette-git-commit-body">
          Body
        </label>
        <textarea
          id="palette-git-commit-body"
          data-testid="palette-git-commit-body"
          style={TEXTAREA}
          placeholder="Optional. Blank lines separate paragraphs — each becomes a `-m`."
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {signoffAvailable && (
        <label style={TOGGLE_LABEL}>
          <input
            type="checkbox"
            data-testid="palette-git-commit-signoff"
            checked={signoff}
            onChange={(e) => setSignoff(e.target.checked)}
          />
          <span>
            <code>--signoff</code> — append a <code>Signed-off-by:</code> trailer.
          </span>
        </label>
      )}

      {!canSubmit && (
        <div style={ERROR_BOX} data-testid="palette-git-commit-need-subject">
          Subject is required.
        </div>
      )}

      {canSubmit && (
        <div style={PREVIEW}>
          <div style={PREVIEW_LABEL}>Preview</div>
          <div data-testid="palette-git-commit-preview">{preview}</div>
        </div>
      )}

      <div style={FOOTER}>
        <span>
          <kbd style={KBD}>⏎</kbd>commit
          <kbd style={KBD}>esc</kbd>cancel
        </span>
        <button
          type="button"
          data-testid="palette-git-commit-submit"
          disabled={!canSubmit}
          style={{
            ...SUBMIT_BUTTON,
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
          onClick={submit}
        >
          Commit
        </button>
      </div>
    </div>
  );
}
