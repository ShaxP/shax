/**
 * Renders a `PanelNode` tree from a community command's
 * `buildPanel(ctx)` output (M8.5 spec §14). Manages the values
 * map keyed by each node's `resultKey`; on submit, validates
 * required fields and calls `onSubmit(values)`.
 *
 * The renderer is *the* host-side surface for community input —
 * it must not evaluate any JS from the schema, must not render
 * `dangerouslySetInnerHTML`, and must not attach event handlers
 * from schema strings. Every value we render is either a
 * TS-typed literal or a fully-validated `string` / `boolean`
 * from the schema.
 *
 * File-picker is currently rendered as a plain text input with
 * a `📁` hint — the modal picker is deferred (spec §14
 * "Deferred (M9+)"). A future revision can swap in a real
 * modal without changing the values shape.
 */

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  FIELD_LABEL,
  FIELD_ROW,
  FOOTER,
  KBD,
  PANEL,
  SUBMIT_BUTTON,
  TEXT_INPUT,
  TEXTAREA,
  TOGGLE_LABEL,
} from "../builtins/git/formStyles";
import type { PanelNode } from "./schema";

export type SchemaValues = Record<string, string | boolean | readonly string[]>;

export interface SchemaPanelProps {
  node: PanelNode;
  onSubmit: (values: SchemaValues) => void;
  /** Optional label for the submit button. Defaults to "Run". */
  submitLabel?: string;
}

const FIELDSET: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "8px 10px 10px",
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const LEGEND: CSSProperties = {
  padding: "0 6px",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.3,
  textTransform: "uppercase",
  color: "var(--fg-dim)",
};

const ERROR_NOTE: CSSProperties = {
  fontSize: 11,
  color: "var(--red)",
};

const OPTION_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
};

const LIST_ROW: CSSProperties = {
  padding: "3px 10px",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const LIST_ROW_SELECTED: CSSProperties = {
  ...LIST_ROW,
  background: "var(--surface-hover)",
};

const LIST_BOX: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "4px 0",
  maxHeight: 160,
  overflowY: "auto",
};

/** Walk a node tree and collect the initial values map. Text
 *  inputs default to "", toggles to false unless `default` is
 *  set, dropdowns to the first option, multi-selects to []. */
function initialValues(node: PanelNode): SchemaValues {
  const out: Record<string, string | boolean | readonly string[]> = {};
  const visit = (n: PanelNode): void => {
    switch (n.kind) {
      case "text-input":
      case "multiline-input":
        out[n.resultKey] = n.default ?? "";
        break;
      case "dropdown":
        out[n.resultKey] = n.default ?? n.options[0] ?? "";
        break;
      case "multi-select":
        out[n.resultKey] = [];
        break;
      case "toggle":
        out[n.resultKey] = n.default ?? false;
        break;
      case "file-picker":
        out[n.resultKey] = "";
        break;
      case "list-picker":
        out[n.resultKey] = n.items[0]?.value ?? "";
        break;
      case "group":
        n.items.forEach(visit);
        break;
    }
  };
  visit(node);
  return out;
}

/** Walk a node tree and collect the resultKeys of required
 *  fields that are currently empty. Empty here means empty
 *  string for text-ish inputs; booleans and dropdowns are
 *  never "empty" so `required` doesn't apply to them. */
function missingRequired(node: PanelNode, values: SchemaValues): string[] {
  const missing: string[] = [];
  const visit = (n: PanelNode): void => {
    switch (n.kind) {
      case "text-input":
      case "multiline-input": {
        if (n.required === true) {
          const v = values[n.resultKey];
          if (typeof v !== "string" || v.trim().length === 0) {
            missing.push(n.resultKey);
          }
        }
        break;
      }
      case "group":
        n.items.forEach(visit);
        break;
      default:
        break;
    }
  };
  visit(node);
  return missing;
}

export function SchemaPanel({
  node,
  onSubmit,
  submitLabel = "Run",
}: SchemaPanelProps): React.ReactElement {
  const [values, setValues] = useState<SchemaValues>(() => initialValues(node));
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const firstFocusableRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const missing = useMemo(() => missingRequired(node, values), [node, values]);
  const canSubmit = missing.length === 0;

  const set = (key: string, value: string | boolean | readonly string[]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const submit = (): void => {
    setAttemptedSubmit(true);
    if (!canSubmit) return;
    onSubmit(values);
  };

  const handleTextKey = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  };

  const renderNode = (n: PanelNode, index: number): ReactNode => {
    const nodeKey = n.kind === "group" ? `group-${index}` : n.resultKey;
    switch (n.kind) {
      case "text-input": {
        const val = String(values[n.resultKey] ?? "");
        const isMissing = attemptedSubmit && missing.includes(n.resultKey);
        return (
          <div key={nodeKey} style={FIELD_ROW}>
            <label style={FIELD_LABEL} htmlFor={`palette-community-${n.resultKey}`}>
              {n.label}
              {n.required === true && " *"}
            </label>
            <input
              id={`palette-community-${n.resultKey}`}
              data-testid={`palette-community-${n.resultKey}`}
              data-kind="text-input"
              style={TEXT_INPUT}
              value={val}
              onChange={(e) => set(n.resultKey, e.target.value)}
              onKeyDown={handleTextKey}
              autoFocus={index === 0}
              ref={
                index === 0
                  ? (el) => {
                      firstFocusableRef.current = el;
                    }
                  : undefined
              }
            />
            {isMissing && <div style={ERROR_NOTE}>required</div>}
          </div>
        );
      }
      case "multiline-input": {
        const val = String(values[n.resultKey] ?? "");
        const isMissing = attemptedSubmit && missing.includes(n.resultKey);
        return (
          <div key={nodeKey} style={FIELD_ROW}>
            <label style={FIELD_LABEL} htmlFor={`palette-community-${n.resultKey}`}>
              {n.label}
              {n.required === true && " *"}
            </label>
            <textarea
              id={`palette-community-${n.resultKey}`}
              data-testid={`palette-community-${n.resultKey}`}
              data-kind="multiline-input"
              style={TEXTAREA}
              value={val}
              onChange={(e) => set(n.resultKey, e.target.value)}
            />
            {isMissing && <div style={ERROR_NOTE}>required</div>}
          </div>
        );
      }
      case "dropdown": {
        const val = String(values[n.resultKey] ?? "");
        return (
          <div key={nodeKey} style={FIELD_ROW}>
            <label style={FIELD_LABEL} htmlFor={`palette-community-${n.resultKey}`}>
              {n.label}
            </label>
            <select
              id={`palette-community-${n.resultKey}`}
              data-testid={`palette-community-${n.resultKey}`}
              data-kind="dropdown"
              style={TEXT_INPUT}
              value={val}
              onChange={(e) => set(n.resultKey, e.target.value)}
            >
              {n.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        );
      }
      case "multi-select": {
        const rawSelected = values[n.resultKey];
        const selected: readonly string[] = Array.isArray(rawSelected) ? rawSelected : [];
        return (
          <div key={nodeKey} style={FIELD_ROW}>
            <label style={FIELD_LABEL}>{n.label}</label>
            <div
              data-testid={`palette-community-${n.resultKey}`}
              data-kind="multi-select"
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              {n.options.map((opt) => {
                const checked = selected.includes(opt);
                return (
                  <label key={opt} style={OPTION_ROW}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...selected, opt]
                          : selected.filter((v) => v !== opt);
                        set(n.resultKey, next);
                      }}
                    />
                    <span>{opt}</span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      }
      case "toggle": {
        const val = values[n.resultKey] === true;
        return (
          <label key={nodeKey} style={TOGGLE_LABEL}>
            <input
              type="checkbox"
              data-testid={`palette-community-${n.resultKey}`}
              data-kind="toggle"
              checked={val}
              onChange={(e) => set(n.resultKey, e.target.checked)}
            />
            <span>{n.label}</span>
          </label>
        );
      }
      case "file-picker": {
        const val = String(values[n.resultKey] ?? "");
        return (
          <div key={nodeKey} style={FIELD_ROW}>
            <label style={FIELD_LABEL} htmlFor={`palette-community-${n.resultKey}`}>
              {n.label} ({n.mode})
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                id={`palette-community-${n.resultKey}`}
                data-testid={`palette-community-${n.resultKey}`}
                data-kind="file-picker"
                style={{ ...TEXT_INPUT, flex: 1 }}
                value={val}
                placeholder={n.mode === "dir" ? "/path/to/dir" : "/path/to/file"}
                onChange={(e) => set(n.resultKey, e.target.value)}
                onKeyDown={handleTextKey}
              />
              <span
                aria-hidden="true"
                title="File browser coming in a later slice — type the path for now."
                style={{
                  padding: "4px 8px",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--fg-faint)",
                }}
              >
                📁
              </span>
            </div>
          </div>
        );
      }
      case "list-picker": {
        const val = String(values[n.resultKey] ?? "");
        return (
          <div key={nodeKey} style={FIELD_ROW}>
            <label style={FIELD_LABEL}>{n.label}</label>
            <div
              data-testid={`palette-community-${n.resultKey}`}
              data-kind="list-picker"
              style={LIST_BOX}
            >
              {n.items.map((item) => {
                const isSelected = item.value === val;
                return (
                  <div
                    key={item.value}
                    data-value={item.value}
                    data-selected={isSelected ? "true" : "false"}
                    style={isSelected ? LIST_ROW_SELECTED : LIST_ROW}
                    onClick={() => set(n.resultKey, item.value)}
                  >
                    {item.label}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }
      case "group": {
        return (
          <fieldset key={nodeKey} style={FIELDSET}>
            {n.legend !== undefined && <legend style={LEGEND}>{n.legend}</legend>}
            {n.items.map((child, i) => renderNode(child, i))}
          </fieldset>
        );
      }
    }
  };

  return (
    <div style={PANEL} data-testid="palette-community-schema-panel">
      {renderNode(node, 0)}
      <div style={FOOTER}>
        <span>
          <kbd style={KBD}>⏎</kbd>run
          <kbd style={KBD}>esc</kbd>cancel
        </span>
        <button
          type="button"
          data-testid="palette-community-submit"
          style={{
            ...SUBMIT_BUTTON,
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
          onClick={submit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
