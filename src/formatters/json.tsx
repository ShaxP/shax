/**
 * JSON formatter (M4 slice 4.6a).
 *
 * Renders a parsed JSON value as a collapsible tree with
 * type-coloured leaves. Matches `jq` (the canonical JSON-emitting
 * tool) and any block whose stdout parses as JSON — that lets it
 * win over the cat formatter for `cat foo.json`, `curl …json`,
 * and similar.
 *
 * Spec: 07-formatters §built-in formatters → JSON. The future
 * SRC lens (M4.5) will give users the pretty-printed source view;
 * for now the FMT/RAW pair is enough.
 *
 * Higher priority than `cat` so that JSON-shaped output is
 * promoted past the generic source viewer.
 */

import type { CSSProperties } from "react";
import { useState } from "react";
import {
  entryCount,
  isLikelyJsonCommand,
  kindOf,
  probeJson,
  type JsonNodeKind,
} from "./detectJson";
import { PASS, type Formatter, type FormatterContext } from "./types";

// ─── styling ────────────────────────────────────────────────────

const HOST: CSSProperties = {
  margin: "4px 0 0 0",
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  lineHeight: 1.55,
  // Inline cap; modal overrides via `--formatter-max-height`.
  maxHeight: "var(--formatter-max-height, 480px)",
  overflowY: "auto",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 4,
  whiteSpace: "pre",
};

const INDENT_STEP_PX = 14;
const DISCLOSURE: CSSProperties = {
  width: 12,
  display: "inline-block",
  textAlign: "center",
  color: "var(--fg-faint)",
  userSelect: "none",
  cursor: "pointer",
};
const DISCLOSURE_LEAF: CSSProperties = {
  ...DISCLOSURE,
  visibility: "hidden",
  cursor: "default",
};

const KEY: CSSProperties = {
  color: "var(--accent)",
};
const PUNCT: CSSProperties = {
  color: "var(--fg-faint)",
};
const SUMMARY: CSSProperties = {
  color: "var(--fg-faint)",
  fontStyle: "italic",
  marginLeft: 8,
};

function valueStyle(kind: JsonNodeKind): CSSProperties {
  switch (kind) {
    case "string":
      return { color: "var(--green)" };
    case "number":
      return { color: "var(--amber)" };
    case "boolean":
      return { color: "var(--magenta)" };
    case "null":
      return { color: "var(--fg-faint)", fontStyle: "italic" };
    case "object":
    case "array":
      return { color: "var(--fg-dim)" };
  }
}

// ─── tree row ───────────────────────────────────────────────────

interface NodeProps {
  /** Key under the parent. `null` at the root, string for object
   *  keys, number for array indices. */
  parentKey: string | number | null;
  /** Whether this node lives inside an array (controls key
   *  formatting — array indices are rendered as `[i]` not `"i":`). */
  inArray: boolean;
  /** Whether this is the last sibling, so we can omit the
   *  trailing comma. */
  isLast: boolean;
  value: unknown;
  depth: number;
  /** Default collapsed-state at this depth (top level expanded,
   *  everything below collapsed by default). */
  defaultExpanded: boolean;
}

function JsonNode({
  parentKey,
  inArray,
  isLast,
  value,
  depth,
  defaultExpanded,
}: NodeProps): React.ReactElement {
  const kind = kindOf(value);
  const isContainer = kind === "object" || kind === "array";
  const [expanded, setExpanded] = useState(defaultExpanded);

  const indentPx = depth * INDENT_STEP_PX;
  const keyLabel = renderKeyLabel(parentKey, inArray);
  const comma = isLast ? "" : ",";

  if (!isContainer) {
    return (
      <div style={{ ...ROW, paddingLeft: indentPx }} data-testid="formatter-json-node">
        <span style={DISCLOSURE_LEAF} aria-hidden="true">
          ·
        </span>
        {keyLabel !== null && (
          <>
            <span style={KEY}>{keyLabel}</span>
            <span style={PUNCT}>:</span>
          </>
        )}
        <span style={valueStyle(kind)}>{renderPrimitive(value, kind)}</span>
        {comma !== "" && <span style={PUNCT}>{comma}</span>}
      </div>
    );
  }

  const count = entryCount(value);
  const openBracket = kind === "array" ? "[" : "{";
  const closeBracket = kind === "array" ? "]" : "}";
  const summary = collapsedSummary(kind, count);

  if (!expanded) {
    return (
      <div
        style={{ ...ROW, paddingLeft: indentPx }}
        data-testid="formatter-json-node"
        data-kind={kind}
      >
        <span
          style={DISCLOSURE}
          onClick={(e) => {
            // Tree-local: don't bubble to BlockRow's onClick,
            // which would shift block-focus to this row and
            // visually "select another block" from the user's
            // perspective.
            e.stopPropagation();
            setExpanded(true);
          }}
          role="button"
          aria-label="Expand"
        >
          ▶
        </span>
        {keyLabel !== null && (
          <>
            <span style={KEY}>{keyLabel}</span>
            <span style={PUNCT}>:</span>
          </>
        )}
        <span style={PUNCT}>
          {openBracket} {closeBracket}
        </span>
        <span style={SUMMARY}>{summary}</span>
        {comma !== "" && <span style={PUNCT}>{comma}</span>}
      </div>
    );
  }

  // Expanded.
  return (
    <div data-testid="formatter-json-node" data-kind={kind}>
      <div style={{ ...ROW, paddingLeft: indentPx }}>
        <span
          style={DISCLOSURE}
          onClick={() => setExpanded(false)}
          role="button"
          aria-label="Collapse"
        >
          ▼
        </span>
        {keyLabel !== null && (
          <>
            <span style={KEY}>{keyLabel}</span>
            <span style={PUNCT}>:</span>
          </>
        )}
        <span style={PUNCT}>{openBracket}</span>
      </div>
      {kind === "array"
        ? (value as unknown[]).map((child, i) => (
            <JsonNode
              key={i}
              parentKey={i}
              inArray={true}
              isLast={i === (value as unknown[]).length - 1}
              value={child}
              depth={depth + 1}
              defaultExpanded={false}
            />
          ))
        : Object.entries(value as Record<string, unknown>).map(([k, v], i, arr) => (
            <JsonNode
              key={k}
              parentKey={k}
              inArray={false}
              isLast={i === arr.length - 1}
              value={v}
              depth={depth + 1}
              defaultExpanded={false}
            />
          ))}
      <div style={{ ...ROW, paddingLeft: indentPx }}>
        <span style={DISCLOSURE_LEAF} aria-hidden="true">
          ·
        </span>
        <span style={PUNCT}>{closeBracket}</span>
        {comma !== "" && <span style={PUNCT}>{comma}</span>}
      </div>
    </div>
  );
}

function renderKeyLabel(key: string | number | null, inArray: boolean): string | null {
  if (key === null) return null;
  if (inArray) return `[${String(key)}]`;
  // Quote string keys so they read like the source JSON they
  // came from; the eye is calibrated to that shape.
  return `"${String(key)}"`;
}

function renderPrimitive(value: unknown, kind: JsonNodeKind): string {
  switch (kind) {
    case "null":
      return "null";
    case "boolean":
      return value === true ? "true" : "false";
    case "number":
      return String(value);
    case "string":
      return `"${String(value)}"`;
    default:
      // containers handled in the caller
      return "";
  }
}

function collapsedSummary(kind: "object" | "array", count: number): string {
  if (kind === "object") return `${count} ${count === 1 ? "entry" : "entries"}`;
  return `${count} ${count === 1 ? "item" : "items"}`;
}

// ─── view ───────────────────────────────────────────────────────

interface JsonViewProps {
  value: unknown;
}

function JsonView({ value }: JsonViewProps): React.ReactElement {
  return (
    <div data-testid="formatter-json" style={HOST}>
      <JsonNode
        parentKey={null}
        inArray={false}
        isLast={true}
        value={value}
        depth={0}
        defaultExpanded={true}
      />
    </div>
  );
}

// ─── formatter ──────────────────────────────────────────────────

function render(ctx: FormatterContext): React.ReactNode | typeof PASS {
  // Two routes:
  //   1. argv hint (jq, future: curl with json content-type) —
  //      try to parse, but PASS if parsing fails so RAW catches
  //      the actual non-JSON output that `jq` errors produce.
  //   2. content predicate — any block whose stdout parses
  //      cleanly as JSON, regardless of command. Lets `cat
  //      foo.json` route here in preference to the cat formatter.
  const probe = probeJson(ctx.stdout);
  if (probe === null) return PASS;
  return <JsonView value={probe.value} />;
}

export const jsonFormatter: Formatter = {
  name: "json",
  matcher: {
    kind: "predicate",
    test: (ctx) => {
      // Cheap argv hint first — saves a parse for the obvious
      // case. For everything else, do the looks-like + parse
      // check inline (probeJson is fast on non-JSON because of
      // the looksLikeJson pre-flight).
      if (isLikelyJsonCommand(ctx.argv)) return true;
      return probeJson(ctx.stdout) !== null;
    },
  },
  // Higher than the cat formatter's default 0 so JSON wins over
  // generic source viewing for `cat foo.json`.
  priority: 10,
  render,
};
