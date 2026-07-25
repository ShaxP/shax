/**
 * `git stash` palette command (M8.4 spec §14).
 *
 * A tiny form: message (free-form) + two toggles. Assembles
 * `git stash push -m "..." [--keep-index] [--include-untracked]`
 * and hands it to the palette host for the visible-command
 * emit.
 *
 * Matches on `ctx.gitRoot !== null` — spec calls for "repo,
 * dirty tree" but we let the shell surface the clean-tree case
 * rather than adding a status probe just to gate the entry. The
 * user still sees the preview and can back out.
 */

import { useState, type CSSProperties } from "react";
import { shellEscape } from "../../../lib/shellEscape";
import type { PaneContext } from "../../registry";
import {
  FIELD_LABEL,
  FIELD_ROW,
  FOOTER,
  KBD,
  PANEL,
  PREVIEW,
  PREVIEW_LABEL,
  SUBMIT_BUTTON,
  TEXT_INPUT,
  TOGGLE_LABEL,
} from "./formStyles";

export interface GitStashPanelProps {
  ctx: PaneContext;
  onSubmit: (command: string | null) => void;
}

const HELPER_TEXT: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-faint)",
  marginTop: -4,
};

export function buildStashCommand(
  message: string,
  keepIndex: boolean,
  includeUntracked: boolean,
): string {
  const parts = ["git", "stash", "push"];
  const trimmed = message.trim();
  if (trimmed.length > 0) parts.push("-m", shellEscape(trimmed));
  if (keepIndex) parts.push("--keep-index");
  if (includeUntracked) parts.push("--include-untracked");
  return parts.join(" ");
}

export function GitStashPanel({ onSubmit }: GitStashPanelProps): React.ReactElement {
  const [message, setMessage] = useState("");
  const [keepIndex, setKeepIndex] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(false);

  const preview = buildStashCommand(message, keepIndex, includeUntracked);

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onSubmit(preview);
    }
  };

  return (
    <div style={PANEL} data-testid="palette-git-stash-panel">
      <div style={FIELD_ROW}>
        <label style={FIELD_LABEL} htmlFor="palette-git-stash-message">
          Message
        </label>
        <input
          id="palette-git-stash-message"
          data-testid="palette-git-stash-message"
          style={TEXT_INPUT}
          placeholder="Optional — describe what you're stashing"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKey}
          autoFocus
        />
        <div style={HELPER_TEXT}>Empty is fine; git assigns a default WIP message.</div>
      </div>

      <label style={TOGGLE_LABEL}>
        <input
          type="checkbox"
          data-testid="palette-git-stash-keep-index"
          checked={keepIndex}
          onChange={(e) => setKeepIndex(e.target.checked)}
        />
        <span>
          <code>--keep-index</code> — leave staged changes in the index after stashing
        </span>
      </label>

      <label style={TOGGLE_LABEL}>
        <input
          type="checkbox"
          data-testid="palette-git-stash-include-untracked"
          checked={includeUntracked}
          onChange={(e) => setIncludeUntracked(e.target.checked)}
        />
        <span>
          <code>--include-untracked</code> — stash untracked files too
        </span>
      </label>

      <div style={PREVIEW}>
        <div style={PREVIEW_LABEL}>Preview</div>
        <div data-testid="palette-git-stash-preview">{preview}</div>
      </div>

      <div style={FOOTER}>
        <span>
          <kbd style={KBD}>⏎</kbd>run
          <kbd style={KBD}>esc</kbd>cancel
        </span>
        <button
          type="button"
          data-testid="palette-git-stash-submit"
          style={SUBMIT_BUTTON}
          onClick={() => onSubmit(preview)}
        >
          Stash
        </button>
      </div>
    </div>
  );
}
