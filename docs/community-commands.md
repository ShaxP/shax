# Writing a community pane command

Community pane commands are small JS programs you install under `~/.config/shax/commands/`. Each one appears in the `⌘⇧P` palette alongside the built-in commands (`cd`, `git status`, `git checkout`, `git commit`, `git stash`, `git rebase`) and can collect input from the user through a declarative form. The only thing your code can *do* is return a shell command string — the host renders it, the user sees it, and the safety gate classifies it before anything runs.

This doc is the author-facing reference. If you're looking at how the sandbox works under the hood, see `specs/14-pane-commands.md`. For how the returned string is classified before running, see `docs/safety-gate.md`.

## Directory layout

```
~/.config/shax/commands/
└── my-command/
    ├── manifest.json
    └── command.js
```

Each immediate subdirectory under `commands/` is one add-on. The subdirectory name doesn't have to match the command's `name` field, but it's customary.

Hidden directories (`.git`, `.DS_Store`, etc.) are skipped. Symlinks and non-UTF-8 directory names are skipped with a console warning.

## Manifest

```json
{
  "name": "my-command",
  "version": "1.0.0",
  "description": "What this add-on does",
  "shaxApiVersion": 1,
  "matcher": { "kind": "always" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Unique identity in the registry. The registry skips duplicates and skips any name that collides with a built-in, so a malicious add-on can't shadow `cd` or the git commands. |
| `version` | yes | Free-form, displayed in future "manage add-ons" UI. |
| `description` | no | One-line description shown in the palette row. |
| `shaxApiVersion` | yes | Must equal the host's expected version (currently `1`). Old add-ons against a newer host are rejected with a console warning rather than silently misbehaving. |
| `matcher` | yes | Declarative matcher — one of the three shapes below. Predicate matchers are rejected: they'd need a synchronous worker round-trip on every palette filter tick, which the sandbox can't provide. |
| `permissions` | no | Reserved. Must be `[]` today. Non-empty arrays are rejected — future context permissions (cwd wildcards, block reads) will land here additively. |

### Matcher shapes

```json
{ "kind": "always" }
{ "kind": "in-git-repo" }
{ "kind": "cwd-prefix", "prefix": "/Users/ada/proj" }
```

- `always` — always visible in the palette.
- `in-git-repo` — visible only when the active pane's cwd is inside a git working tree.
- `cwd-prefix` — visible only when the active pane's cwd starts with `prefix`.

Community commands always land in the palette's **Custom** group, regardless of what the manifest says.

## `command.js`

A single JS file (no modules, no `require`, no top-level `import`) that assigns two magic globals:

```js
self.__shax_command_build_panel = function (ctx) {
  return { /* PanelNode — see below */ };
};

self.__shax_command_build_command = function (values) {
  return "echo hello"; // or null to cancel
};
```

The host drives a two-phase protocol:

1. **`buildPanel(ctx)`** runs when the user picks your command from the palette. It receives a sanitised context snapshot and must synchronously return a `PanelNode` (see next section). The host renders it as a form.
2. **`buildCommand(values)`** runs when the user submits the form. It receives a `values` map keyed by each node's `resultKey`, and must return the shell-command string to emit — or `null` to cancel silently.

The worker is spawned lazily on first invocation and kept alive across openings, so global state persists inside a session. Reset what you need at the top of each function.

## Panel schema

Eight node kinds, matching `src/palette/sandbox/schema.ts` exactly. The host renderer is the only path by which your data reaches the DOM; it emits plain text and structural form controls — nothing the worker returns can become a script, event handler, or `<a href>`.

```ts
type PanelNode =
  | { kind: "text-input";      label: string; default?: string; required?: boolean; resultKey: string }
  | { kind: "multiline-input"; label: string; default?: string; required?: boolean; resultKey: string }
  | { kind: "dropdown";        label: string; options: string[]; default?: string;  resultKey: string }
  | { kind: "multi-select";    label: string; options: string[];                    resultKey: string }
  | { kind: "toggle";          label: string; default?: boolean;                    resultKey: string }
  | { kind: "file-picker";     label: string; mode: "file" | "dir";                 resultKey: string }
  | { kind: "list-picker";     label: string; items: { label: string; value: string }[]; resultKey: string }
  | { kind: "group";           items: PanelNode[]; legend?: string }
```

### Reject rules

Every worker→host reply is validated by `isPanelNode`. Anything that trips these rules is dropped and the panel shows an error state:

- Unknown `kind` values are rejected. Extension is additive via a future `shaxApiVersion` bump.
- Every leaf node needs a non-empty string `resultKey`.
- Every leaf node needs a string `label` (a non-string label, e.g. `{onclick: "..."}`, is a smuggle attempt and gets rejected).
- `dropdown` needs a non-empty `options` array of strings.
- `multi-select` needs an `options` array of strings (may be empty).
- `file-picker` needs `mode: "file" | "dir"`.
- `list-picker` items need both `label` and `value` as strings.
- `group.items` must be an array; each item is recursively validated.
- `text-input.required` and `toggle.default` must be booleans when present.

### Values

The values map you receive in `buildCommand` uses each leaf's `resultKey` as the key:

- `text-input` / `multiline-input` → `string` (empty if untouched)
- `dropdown` → `string` (the selected option)
- `multi-select` → `string[]`
- `toggle` → `boolean`
- `file-picker` → `string` (path)
- `list-picker` → `string` (the selected item's `value`)

`group` nodes flatten — their children's `resultKey`s live at the top level of the values map.

## Context

The `buildPanel(ctx)` phase receives a snapshot:

```ts
interface CommunityCommandContext {
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly gitRoot: string | null;
}
```

You **don't** get `ptyId`, `env`, or block history. Those exist for built-ins; the sandbox surface stays narrow.

`buildCommand(values)` gets only the form values — no context. If your command needs to know the cwd at submit time, capture it in `buildPanel` and stash it inside a `default` field or a hidden node.

## Shell-escaping

The worker has no import surface, so you can't reach `src/lib/shellEscape.ts`. Copy this helper into your `command.js`:

```js
// Same contract as src/lib/shellEscape.ts.
function shellEscape(s) {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
```

Anything containing spaces, quotes, `$`, `;`, `|`, `&`, or newlines will be single-quote-wrapped and escaped. That's enough to prevent shell metacharacter injection from anything a user types into a text field. The safety gate still classifies the *escaped* command — see `docs/safety-gate.md`.

## A complete example — `mkdir`

Shax ships an in-repo sample at `src/palette/sandbox/samples/mkdir.ts`. To exercise the on-disk pipeline, split it into two files:

**`~/.config/shax/commands/mkdir/manifest.json`**

```json
{
  "name": "mkdir",
  "version": "1.0.0",
  "description": "Create a directory — sandboxed community-command sample.",
  "shaxApiVersion": 1,
  "matcher": { "kind": "always" }
}
```

**`~/.config/shax/commands/mkdir/command.js`**

```js
// Community-command sample: mkdir.
// Runs in a Worker with no filesystem / network access — the only
// path to doing anything is the string returned from
// __shax_command_build_command.

self.__shax_command_build_panel = function (_ctx) {
  return {
    kind: "group",
    legend: "Create a directory",
    items: [
      {
        kind: "text-input",
        label: "Path",
        resultKey: "path",
        required: true,
      },
      {
        kind: "toggle",
        label: "-p (create intermediate directories, ignore if exists)",
        resultKey: "parents",
        default: true,
      },
    ],
  };
};

function shellEscape(s) {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

self.__shax_command_build_command = function (values) {
  var path = (values && typeof values.path === "string") ? values.path.trim() : "";
  if (path.length === 0) return null;
  var parts = ["mkdir"];
  if (values && values.parents === true) parts.push("-p");
  parts.push(shellEscape(path));
  return parts.join(" ");
};
```

Reload the palette (`⌘⇧P` → **Reload community commands**) and the entry appears in the **Custom** group with a magenta *community* pill.

## The safety gate

Every string your `buildCommand` returns is classified by `src/safetyGate/policy.ts` before it reaches the pane's prompt. Because the source is `palette`, non-destructive commands get a confirmation modal; destructive patterns get a red gate with a `Destructive: <reason>` headline. The categories the classifier watches for:

- `rm -rf …` in any flag ordering (`-rf`, `-vrf`, `-r -f`, `--recursive --force`), especially near `/`, `$HOME`, `~`, or with a wildcard.
- `git push --force`, `--force-with-lease`, `-f`.
- `git reset --hard` / `git rebase … --hard`.
- `git filter-branch` / `git filter-repo`.
- `git clean -fd`.
- `git checkout .`.
- `shutdown` / `reboot` / `halt` / `poweroff`.
- `dd`, `mkfs.*`.
- `curl … | sh` / `wget … | bash`.
- `sudo -s` / `sudo su`.

You're free to *offer* destructive actions — the user will see the red modal and can approve. But the gate is un-bypassable by design; that's the fidelity contract from `CLAUDE.md`. Read `docs/safety-gate.md` for the full table and reasoning.

## Limits

- **Timeout: 1 second per phase.** A `buildPanel` or `buildCommand` that doesn't return within a second is reaped and the worker is torn down; the panel shows an error state.
- **Panel schema: ~1 MiB.** The JSON payload from `buildPanel` must fit. Return a smaller tree, or collapse / paginate inside your view.
- **Command length: 128 KiB.** The string from `buildCommand` must fit — well above anything the shell will accept anyway, but a runaway loop can't dump gigabytes into the prompt.
- **Source file: 256 KiB.** `command.js` itself is size-capped by the backend loader. Split logic into multiple add-ons if you need more.
- **Worker reuse.** One worker per command, kept alive across palette openings within a session. Avoid module-level side effects that only make sense per-invocation.

## Debugging

- Open DevTools (`Cmd+Option+I`) and look for `[shax command sandbox] spawned worker for "..."` on the Console tab — that confirms your add-on loaded.
- `window.__shaxCommandSandbox` reports the live worker set and total invocation count.
- Failures inside your `buildPanel` / `buildCommand` are logged: `command sandbox: buildPanel declined: <reason>` or `command sandbox: buildCommand declined: <reason>`.
- The Sources tab → Threads section shows each worker as its own thread; set breakpoints inside.
- Manifest and loader failures log as `community command "<name>": ...`.

## What you can't do

The sandbox is a security boundary. Inside a worker:

- No `document`, no `window`, no DOM access.
- No `fetch`, no `XMLHttpRequest`, no `WebSocket` (the browser provides them, but blob-loaded workers running under our CSP can't reach the network).
- No filesystem.
- No Tauri `invoke` — the add-on can't trigger shell commands or read files.
- No spawning sub-workers.
- No access to the pane's PTY, block history, or environment variables.

The only thing your code can do is *compute a shell-command string* from the form values and return it. The host emits it into the prompt. The safety gate classifies it. The user approves or declines. That's the whole loop.

## Loading

Drop the directory under `~/.config/shax/commands/`, then open the palette (`⌘⇧P`) and pick **Reload community commands** (in the Debug group). Your entry appears without restarting the app.

If your add-on doesn't show up:
- Check the Console for `community command "<name>": ...` warnings — the manifest probably failed validation.
- Confirm the directory has `manifest.json` and `command.js` (not `command.ts`, not `index.js`).
- Confirm the `name` in the manifest doesn't collide with a built-in (`cd`, `echo hello`, `Reload community commands`, `mkdir (sample)`, or any of the git commands). The registry skips duplicates.
- Confirm `command.js` is under 256 KiB.
