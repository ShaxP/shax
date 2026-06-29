/**
 * Render schema for sandboxed (community) formatters (slice 4.6b1).
 *
 * Workers run in a separate JS context — no DOM, no React. They
 * can't return UI elements; they return a constrained tree of
 * primitives that the host translates into React on the main
 * thread. The schema is intentionally narrow:
 *
 *   - it can collect display, not interact (no event handlers,
 *     no input fields — those would need a separate pane-command
 *     API once M8 lands),
 *   - colours are theme tokens (`accent`, `green`, `red`, …) not
 *     raw hex, so community formatters automatically fit the
 *     current theme,
 *   - the recursive `group` lets formatters compose without
 *     escalating the schema surface every time.
 *
 * Once published this is a stable API: extending is additive
 * (new node kinds), narrowing or renaming is a breaking change.
 */

/** Theme-aware colour. Maps to a CSS `var(--…)` token at render
 *  time. Defaults to the body foreground when omitted. */
export type SandboxColor =
  | "default"
  | "dim"
  | "faint"
  | "accent"
  | "green"
  | "amber"
  | "red"
  | "cyan"
  | "magenta";

export type SandboxNode = TextNode | GroupNode | TableNode | KeyValueNode | DividerNode;

export interface TextNode {
  kind: "text";
  text: string;
  color?: SandboxColor;
  weight?: "normal" | "bold";
  /** Treat the text as `whiteSpace: pre` so embedded `\n` and
   *  multiple spaces aren't collapsed. Default `false`. */
  pre?: boolean;
}

export interface GroupNode {
  kind: "group";
  direction: "row" | "column";
  /** Pixel gap between children. Defaults to 4 for rows, 2 for columns. */
  gap?: number;
  children: SandboxNode[];
}

export interface TableNode {
  kind: "table";
  /** Optional header row. */
  header?: readonly string[];
  /** Data rows. Each row should match the header length (the
   *  renderer is forgiving on mismatched lengths — short rows
   *  pad with empty strings; long rows truncate to header
   *  length or just keep extra cells if there's no header). */
  rows: readonly (readonly string[])[];
}

export interface KeyValueNode {
  kind: "key-value";
  entries: readonly KeyValueEntry[];
}

export interface KeyValueEntry {
  key: string;
  value: string;
  valueColor?: SandboxColor;
}

export interface DividerNode {
  kind: "divider";
}

/** Runtime type guard — keeps the schema-validator at one place.
 *  Rejects anything that isn't a recognised node, including
 *  objects with extra properties (workers can't sneak event
 *  handlers in by tacking them on). */
export function isSandboxNode(value: unknown): value is SandboxNode {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as { kind?: unknown };
  switch (obj.kind) {
    case "text":
      return isTextNode(value);
    case "group":
      return isGroupNode(value);
    case "table":
      return isTableNode(value);
    case "key-value":
      return isKeyValueNode(value);
    case "divider":
      return true;
    default:
      return false;
  }
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isSandboxColor(v: unknown): v is SandboxColor {
  return (
    v === "default" ||
    v === "dim" ||
    v === "faint" ||
    v === "accent" ||
    v === "green" ||
    v === "amber" ||
    v === "red" ||
    v === "cyan" ||
    v === "magenta"
  );
}

function isTextNode(value: object): value is TextNode {
  const n = value as Partial<TextNode>;
  if (n.kind !== "text") return false;
  if (!isString(n.text)) return false;
  if (n.color !== undefined && !isSandboxColor(n.color)) return false;
  if (n.weight !== undefined && n.weight !== "normal" && n.weight !== "bold") return false;
  if (n.pre !== undefined && typeof n.pre !== "boolean") return false;
  return true;
}

function isGroupNode(value: object): value is GroupNode {
  const n = value as Partial<GroupNode>;
  if (n.kind !== "group") return false;
  if (n.direction !== "row" && n.direction !== "column") return false;
  if (n.gap !== undefined && typeof n.gap !== "number") return false;
  if (!Array.isArray(n.children)) return false;
  return n.children.every((child: unknown) => isSandboxNode(child));
}

function isTableNode(value: object): value is TableNode {
  const n = value as Partial<TableNode>;
  if (n.kind !== "table") return false;
  if (!Array.isArray(n.rows)) return false;
  if (n.header !== undefined) {
    if (!Array.isArray(n.header)) return false;
    if (!n.header.every(isString)) return false;
  }
  return n.rows.every((row: unknown) => Array.isArray(row) && (row as unknown[]).every(isString));
}

function isKeyValueNode(value: object): value is KeyValueNode {
  const n = value as Partial<KeyValueNode>;
  if (n.kind !== "key-value") return false;
  if (!Array.isArray(n.entries)) return false;
  return n.entries.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Partial<KeyValueEntry>;
    if (!isString(e.key)) return false;
    if (!isString(e.value)) return false;
    if (e.valueColor !== undefined && !isSandboxColor(e.valueColor)) return false;
    return true;
  });
}
