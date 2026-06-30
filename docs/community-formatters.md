# Writing a community formatter

Community formatters are small JS programs you install under `~/.config/shax/formatters/`. Each turns a shell command's output into a structured view that Shax renders inline (and in the preview modal). They run inside a Web Worker with no DOM, network, filesystem, or Tauri access — the only thing they can do is *return* a schema describing what to display, and the host renders it.

This doc is the author-facing reference. If you're looking at how the sandbox works under the hood, see `specs/07-formatters.md`.

## Directory layout

```
~/.config/shax/formatters/
└── my-formatter/
    ├── manifest.json
    └── formatter.js
```

Each immediate subdirectory under `formatters/` is one add-on. The subdirectory name doesn't have to match the formatter's `name` field, but it's customary.

Hidden directories (`.git`, `.DS_Store`, etc.) are skipped.

## Manifest

```json
{
  "name": "my-formatter",
  "version": "1.0.0",
  "description": "What this add-on does",
  "shaxApiVersion": 1,
  "matcher": {
    "kind": "argv0",
    "argv0": "my-tool"
  },
  "priority": 0
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Unique identity in the registry. The registry skips duplicate names, so a malicious add-on can't shadow a built-in. |
| `version` | yes | Free-form, displayed in future "manage add-ons" UI. |
| `description` | no | One-line description, displayed where applicable. |
| `shaxApiVersion` | yes | Must equal the host's expected version (currently `1`). Old add-ons against a newer host are rejected with a console warning rather than silently misbehaving. |
| `matcher` | yes | Declarative matcher — either `{ "kind": "argv0", "argv0": "my-tool" }` or `{ "kind": "argv0-subcommand", "argv0": "git", "subcommand": "blame" }`. `predicate` matchers are rejected (they'd let add-ons inspect state outside the sandbox). |
| `priority` | no | Tie-break vs. other formatters. Built-ins are at 0; set higher to win over a built-in on the same command. |

## `formatter.js`

A single JS file (no modules, no `require`) that assigns its render function to a magic global:

```js
self.__shax_formatter_render = function (ctx) {
  // … parse, transform, build a node …
  return { kind: "text", text: "Hello from my-formatter" };
};
```

The host wraps your code in a worker scaffold that drives the `onmessage` protocol. You only write the render function. Return one of the schema nodes below, or `null` to decline (the block falls back to RAW).

## Context

The render function receives a sanitised context:

```ts
interface SandboxInvokeContext {
  readonly argv: readonly string[]; // ["my-tool", "--flag", "arg"]
  readonly cwd: string | null;
  readonly stdout: string;          // ANSI-stripped, zsh-`%`-stripped
  readonly stderr: string;          // empty today; reserved
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}
```

You **don't** get `paneId`, `rawAnsi`, or `env`. Those exist for built-ins; the sandbox surface stays narrow.

## Render schema

Five node kinds. The host renderer is the only path by which your data reaches the DOM; it emits plain text and structural elements — nothing the worker returns can become a script, an event handler, or an `<a href>`.

```ts
type SandboxNode = TextNode | GroupNode | TableNode | KeyValueNode | DividerNode;

interface TextNode {
  kind: "text";
  text: string;
  color?: "default" | "dim" | "faint" | "accent" | "green" | "amber" | "red" | "cyan" | "magenta";
  weight?: "normal" | "bold";
  pre?: boolean;     // preserve whitespace
}

interface GroupNode {
  kind: "group";
  direction: "row" | "column";
  gap?: number;
  children: SandboxNode[];
}

interface TableNode {
  kind: "table";
  header?: string[];
  rows: string[][];
}

interface KeyValueNode {
  kind: "key-value";
  entries: { key: string; value: string; valueColor?: SandboxColor }[];
}

interface DividerNode {
  kind: "divider";
}
```

Colours are theme tokens — `"green"` becomes `var(--green)` at render time, so your add-on automatically fits whatever theme the user has.

## A complete example — `wc`

```json
{
  "name": "wc",
  "version": "1.0.0",
  "description": "Render wc output as a key-value or table",
  "shaxApiVersion": 1,
  "matcher": { "kind": "argv0", "argv0": "wc" }
}
```

```js
self.__shax_formatter_render = function (ctx) {
  var lines = ctx.stdout.trim().split("\n")
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });
  if (lines.length === 0) return null;

  var rows = lines.map(function (line) {
    return line.split(/\s+/).filter(function (p) { return p.length > 0; });
  });

  // Single-line output → key-value; multi-line → table.
  if (rows.length === 1) {
    var r = rows[0];
    return {
      kind: "key-value",
      entries: [
        { key: "lines", value: r[0] || "" },
        { key: "words", value: r[1] || "" },
        { key: "bytes", value: r[2] || "" },
        { key: "file",  value: r[3] || "(stdin)" },
      ],
    };
  }
  return {
    kind: "table",
    header: ["lines", "words", "bytes", "file"],
    rows: rows,
  };
};
```

This is the same `wc` sample bundled with Shax — copy it as a starting point.

## Limits

- Each invocation has a **1-second timeout**. A formatter that doesn't return is reaped; the block falls back to RAW.
- The returned schema must fit in **~1 MiB** (UTF-16 approximation). Don't try to render gigantic JSON; collapse / paginate inside your view.
- `formatter.js` itself can't exceed **256 KiB**. Bundle a smaller renderer, or split logic out into multiple add-ons.
- The worker is **reused across invocations** within a session. Avoid global state that depends on per-invocation cleanup; reset what you need at the top of `render`.

## Debugging

- Open DevTools (Cmd+Option+I) and look for `[shax sandbox] spawned worker for "..."` on the Console tab — that confirms your add-on loaded.
- `window.__shaxSandbox` reports the live worker set and total invocation count.
- A failure inside your render is logged: `sandbox: worker declined: <reason>`.
- The Sources tab → Threads section shows each worker as its own thread; set breakpoints inside.

## What you can't do

The sandbox is a security boundary. Inside a worker:

- No `document`, no `window`, no DOM access.
- No `fetch`, no `XMLHttpRequest`, no `WebSocket` (the browser provides them, but blob-loaded workers running under our CSP can't reach the network).
- No filesystem.
- No Tauri `invoke` — the add-on can't trigger shell commands or read files.
- No spawning sub-workers.

The only thing your code can do is *compute a value* from the context and return a schema node. The host renders it. The user sees text in the colours and shapes you chose — and only that.

## Loading

Drop the directory under `~/.config/shax/formatters/`, then restart Shax. (A "Reload add-ons" command lands in the future pane palette; until then, restart.)

If your add-on doesn't show up:
- Check the Console for `community formatter "<name>": ...` warnings — the manifest probably failed validation.
- Confirm the directory has `manifest.json` and `formatter.js` (not `formatter.ts`, not `index.js`).
- Confirm the `name` in the manifest doesn't collide with a built-in (`cat`, `bat`, `ls`, `eza`, `exa`, `git-status`, `git-diff`, `json`, `wc`). The registry skips duplicates.
