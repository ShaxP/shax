/**
 * Panel-schema DSL for community palette commands (M8.5 spec §14).
 *
 * Workers can't render React. Instead, a community command's
 * `buildPanel(ctx)` returns a `PanelNode` — a small declarative
 * tree of form controls — and the host renders it via
 * `SchemaPanel.tsx`. This module owns two things:
 *
 *   1. The `PanelNode` types themselves. Discriminated union;
 *      spec §14 line 141–152 pinned the eight kinds.
 *   2. `isPanelNode(x)`, a recursive type-guard used at every
 *      worker→host boundary. This is the trust boundary: it
 *      rejects unknown kinds, missing / non-string labels, extra
 *      fields, non-array `items`, and anything else that could
 *      let a worker smuggle event handlers or DOM references
 *      through the JSON pipe.
 *
 * The schema is intentionally narrow (spec §14): it can collect
 * input, constrain choices, and nothing else. Extension is
 * additive — new kinds ship in a future SHAX_API_VERSION bump.
 *
 * No React, no Tauri — pure module so it can run inside tests
 * and (part of it) inside the worker for symmetry if we ever
 * want the worker to self-validate before sending.
 */

export type PanelNode =
  | TextInputNode
  | MultilineInputNode
  | DropdownNode
  | MultiSelectNode
  | ToggleNode
  | FilePickerNode
  | ListPickerNode
  | GroupNode;

export interface TextInputNode {
  readonly kind: "text-input";
  readonly label: string;
  readonly default?: string;
  readonly required?: boolean;
  readonly resultKey: string;
}

export interface MultilineInputNode {
  readonly kind: "multiline-input";
  readonly label: string;
  readonly default?: string;
  readonly required?: boolean;
  readonly resultKey: string;
}

export interface DropdownNode {
  readonly kind: "dropdown";
  readonly label: string;
  readonly options: readonly string[];
  readonly default?: string;
  readonly resultKey: string;
}

export interface MultiSelectNode {
  readonly kind: "multi-select";
  readonly label: string;
  readonly options: readonly string[];
  readonly resultKey: string;
}

export interface ToggleNode {
  readonly kind: "toggle";
  readonly label: string;
  readonly default?: boolean;
  readonly resultKey: string;
}

export interface FilePickerNode {
  readonly kind: "file-picker";
  readonly label: string;
  readonly mode: "file" | "dir";
  readonly resultKey: string;
}

export interface ListPickerItem {
  readonly label: string;
  readonly value: string;
}

export interface ListPickerNode {
  readonly kind: "list-picker";
  readonly label: string;
  readonly items: readonly ListPickerItem[];
  readonly resultKey: string;
}

export interface GroupNode {
  readonly kind: "group";
  readonly items: readonly PanelNode[];
  readonly legend?: string;
}

/** Approximate size (bytes) of a serialised node subtree — used
 *  to size-cap what a worker can return before we walk it. */
export function estimateNodeBytes(node: unknown): number {
  try {
    return JSON.stringify(node).length * 2;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Recursive type-guard: `true` iff `value` matches the schema
 *  exactly. Rejects anything with extra fields, unknown `kind`,
 *  missing labels, non-array `items`, non-string values inside
 *  arrays, or otherwise structurally invalid input. Trust
 *  boundary: worker replies MUST pass this before rendering. */
export function isPanelNode(value: unknown): value is PanelNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as { kind?: unknown };
  switch (node.kind) {
    case "text-input":
    case "multiline-input":
      return isTextish(node);
    case "dropdown":
      return isDropdown(node);
    case "multi-select":
      return isMultiSelect(node);
    case "toggle":
      return isToggle(node);
    case "file-picker":
      return isFilePicker(node);
    case "list-picker":
      return isListPicker(node);
    case "group":
      return isGroup(node);
    default:
      return false;
  }
}

/** Every non-group leaf carries a `resultKey` used as the key
 *  in the `values` map the panel produces. Non-empty string. */
function isResultKey(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isLabel(v: unknown): v is string {
  return typeof v === "string";
}

function isTextish(node: { kind?: unknown }): boolean {
  const n = node as {
    label?: unknown;
    default?: unknown;
    required?: unknown;
    resultKey?: unknown;
  };
  if (!isLabel(n.label)) return false;
  if (!isResultKey(n.resultKey)) return false;
  if (n.default !== undefined && typeof n.default !== "string") return false;
  if (n.required !== undefined && typeof n.required !== "boolean") return false;
  return true;
}

function isDropdown(node: { kind?: unknown }): boolean {
  const n = node as {
    label?: unknown;
    options?: unknown;
    default?: unknown;
    resultKey?: unknown;
  };
  if (!isLabel(n.label)) return false;
  if (!isResultKey(n.resultKey)) return false;
  if (!Array.isArray(n.options) || n.options.length === 0) return false;
  if (!n.options.every((o) => typeof o === "string")) return false;
  if (n.default !== undefined && typeof n.default !== "string") return false;
  return true;
}

function isMultiSelect(node: { kind?: unknown }): boolean {
  const n = node as { label?: unknown; options?: unknown; resultKey?: unknown };
  if (!isLabel(n.label)) return false;
  if (!isResultKey(n.resultKey)) return false;
  if (!Array.isArray(n.options)) return false;
  if (!n.options.every((o) => typeof o === "string")) return false;
  return true;
}

function isToggle(node: { kind?: unknown }): boolean {
  const n = node as { label?: unknown; default?: unknown; resultKey?: unknown };
  if (!isLabel(n.label)) return false;
  if (!isResultKey(n.resultKey)) return false;
  if (n.default !== undefined && typeof n.default !== "boolean") return false;
  return true;
}

function isFilePicker(node: { kind?: unknown }): boolean {
  const n = node as { label?: unknown; mode?: unknown; resultKey?: unknown };
  if (!isLabel(n.label)) return false;
  if (!isResultKey(n.resultKey)) return false;
  return n.mode === "file" || n.mode === "dir";
}

function isListPicker(node: { kind?: unknown }): boolean {
  const n = node as { label?: unknown; items?: unknown; resultKey?: unknown };
  if (!isLabel(n.label)) return false;
  if (!isResultKey(n.resultKey)) return false;
  if (!Array.isArray(n.items)) return false;
  return n.items.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const i = item as { label?: unknown; value?: unknown };
    return typeof i.label === "string" && typeof i.value === "string";
  });
}

function isGroup(node: { kind?: unknown }): boolean {
  const n = node as { items?: unknown; legend?: unknown };
  if (!Array.isArray(n.items)) return false;
  if (!n.items.every(isPanelNode)) return false;
  if (n.legend !== undefined && typeof n.legend !== "string") return false;
  return true;
}
