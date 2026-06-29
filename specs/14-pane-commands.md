# 14 Pane commands (the command palette)

A `Cmd+K` palette that exposes pane-scoped operations — `cd` via a file browser, the git operations (`status`, `checkout`, `stash`, `commit`, `rebase`), and third-party commands a user has installed. Built on the same registry-of-matchers + sandbox-the-community-ones pattern as `07-formatters.md`, but acting on the *action* axis rather than the *render* axis.

## The non-negotiable: palette is an input method, not a side-channel

Every command in the palette ends by emitting a real shell command into the pane's prompt and submitting it. The user sees `cd /Users/ada/proj` or `git commit -m "..."` in their scrollback exactly as if they'd typed it. CLAUDE.md non-negotiable #3 — the honest log — applies to palette-emitted commands without exception. No widget, no extension, no built-in command bypasses the prompt.

This isn't a limitation. It's the feature:

- The user can edit the command before submitting, re-run it from history, share it, search for it, audit it.
- The safety gate (`10`) catches destructive patterns regardless of how the command was authored.
- There is no hidden state the user can't reproduce by looking at their own scrollback.

A "preview before submit" step is part of every palette command. The palette never types into the PTY without an explicit confirmation keystroke (`Enter`), even for read-only commands. Same UX for `git status` and `git push --force` — removes the "I clicked the wrong thing" foot-gun.

## Trigger and palette UX

- `Cmd+K` (Linux/Windows: `Ctrl+K`) opens the palette in the active pane.
- The palette is App-level chrome — one open at a time, like search.
- Block-focus mode, like the search overlay and viewer modal, surrenders the keymap while the palette is open. The bypass uses the same `data-testid` DOM check.
- `Esc` closes the palette and returns focus to the prompt.
- Type-to-filter on command names + descriptions; fuzzy matching (same trigram approach as M3's history search).
- Arrow keys or `j` / `k` move the selection; `Enter` opens the selected command's panel.

## Architecture

### `PaneCommand` contract

Mirrors `Formatter` (`07`), shifted from "render bytes" to "produce a command":

```
PaneCommand {
  name         "cd to directory"                  // human-readable
  description  "Browse the filesystem and switch into a directory"
  icon         optional glyph
  group        "Navigation" | "Git" | "Custom"   // section header in the palette
  matcher      predicate over PaneContext         // available when …?
  render       opens a panel UI                   // returns Promise<{ command: string } | null>
}
```

`matcher` runs synchronously, takes the current `PaneContext`, returns boolean. `render` is the open-the-panel function; it returns either the shell command to emit (string) or `null` if the user cancelled. The host writes the string at the prompt and submits, ending the gesture.

### `PaneContext` (what matchers and panels see)

```
PaneContext {
  cwd            string
  branch         string | null
  gitRoot        string | null     // null when cwd is not inside a repo
  pty            PtyId
  blocks         readonly UiBlock[]
  selectedBlock  UiBlock | null    // when block-focus is engaged
}
```

`gitRoot` is computed by walking up from `cwd` to the nearest `.git` (cached per-pane). Matchers like the git commands say `(ctx) => ctx.gitRoot !== null`.

### Registry

Process-wide registry built on the same shape as the formatter registry. Built-ins are registered at module load; community commands are loaded from the user's config and run sandboxed. `name` is the identity key — duplicate registrations are silently ignored (idempotent under HMR).

## Built-in commands

| Command              | Available when             | Panel produces                                                          |
| -------------------- | -------------------------- | ----------------------------------------------------------------------- |
| **cd to directory**  | always                     | file browser; pick a dir → `cd <path>`                                  |
| **git status**       | `gitRoot !== null`         | a richer view of the slice-4.5 porcelain output (read-only, no command) |
| **git checkout**     | `gitRoot !== null`         | branch picker (local + remote-tracking) → `git checkout <branch>`       |
| **git stash**        | repo, dirty tree           | stash message form → `git stash push -m "..."` (or `-u` flag for untracked) |
| **git commit**       | repo, staged changes       | commit-message editor → `git commit -m "..." -m "..."`                  |
| **git rebase**       | repo                       | branch picker + `-i` toggle → `git rebase [-i] <target>`                |

Read-only commands (`git status`) skip the "preview + submit" gesture: they just show their data and close on Esc. They don't write to the prompt because there's nothing to write.

## The `cd` file browser

Single-pane navigation, MC-flavoured but using whatever React component shape fits the design system best. Spec calls out the *behaviour*, not the layout:

- Header: a breadcrumb of the current path, with each segment clickable to jump up.
- Body: a vertical list of the current directory's children — directories first, then files (greyed; selecting a file is a no-op since `cd` needs a dir).
- Each row: the same icon palette the `ls` formatter uses (`07` rule 2: probe filesystem, not screen-scrape).
- Type-to-filter narrows the list in place.
- `↑` / `↓` or `j` / `k` to move the selection; `Enter` on a directory descends; `Backspace` or `h` goes up.
- `Cmd+Enter` (or "Use this dir" footer button) selects the current directory without descending — produces `cd <current>`.
- Hidden files toggle (`Cmd+H`) — off by default.
- Symlinks render with the slice-4.4 link icon; following them descends into the target.

Returns `cd <absolute-path>` as the command. The preview line shows what will be run; `Enter` submits, `Esc` cancels.

## Git commands — specifics

### git checkout

- Branch list comes from `git for-each-ref --format='%(refname:short)' refs/heads refs/remotes` (machine-readable, no screen-scrape — same `run_git` helper that powers `git_status_porcelain`).
- Current branch is shown but disabled.
- Remote-tracking branches like `origin/feat/foo` produce `git checkout -b feat/foo origin/feat/foo` when selected (the common new-local-branch-from-remote pattern).
- Type-to-filter on branch name.

### git stash

- Message field (free-form).
- `--keep-index` toggle.
- `--include-untracked` toggle (default off; on for "stash everything" intuition).
- Preview shows the assembled `git stash push -m "..." [flags]`.

### git commit

- Message field (single line, required).
- Body field (multi-line, optional). `--body` flag is one `-m` per paragraph.
- `--no-verify` is **not** offered. Hook bypass is a manual prompt-typing affordance, not a palette one (matches CLAUDE.md hard guardrail).
- `--signoff` toggle when the user has `user.email` configured.

### git rebase

- Branch / commit picker for the target.
- `-i` toggle. When set, the assembled command also sets `GIT_SEQUENCE_EDITOR=cat` for a dry-run preview pass? — out of scope for v1; v1 ships the plain `git rebase [-i] <target>` and the user uses their normal editor.
- **Destructive** — passes through the safety gate (`10`) which adds the stronger confirmation step before submit.

## Safety gate interplay

The existing safety gate from `specs/10` already inspects every command the user submits and adds a confirmation step for destructive patterns (`rm -rf`, `git push --force`, `git reset --hard`, etc.). Palette-emitted commands are no different — they hit the same gate via the same write-to-prompt-and-submit path.

The palette's own "preview + Enter" step is the *first* confirmation; the gate is the *second*, and only fires on destructive patterns. Non-destructive commands feel like one click ("pick branch", `Enter`); destructive ones feel like two ("pick branch", `Enter`, gate confirms).

## Extensibility — community commands

Direct mirror of the formatter sandbox in `07`:

1. Built-ins run trusted on the main thread.
2. Community / user commands run in a **Web Worker** with a tightly restricted API.
3. The worker's contract: read the `PaneContext`, build a declarative panel, return a command string (or `null` for cancel). **No filesystem, no network, no shell access from inside the worker.** The only path to "doing" anything is the return value, which Shax types at the prompt — and the user sees it before it runs.

This makes a malicious community command structurally incapable of mischief: it can *propose* an `rm -rf /`, but the user sees the proposal in their own prompt and the safety gate catches it.

### Form-schema for community panels

Workers can't render React directly. They build a panel by returning a small declarative JSON schema that the host renders:

```
PanelSchema = OneOf<
  { kind: "text-input",      label, default?, required?,   resultKey }
  { kind: "multiline-input", label, default?, required?,   resultKey }
  { kind: "dropdown",        label, options: string[],     resultKey }
  { kind: "multi-select",    label, options: string[],     resultKey }
  { kind: "toggle",          label, default?,              resultKey }
  { kind: "file-picker",     label, mode: "file" | "dir",  resultKey }
  { kind: "list-picker",     label, items: ListItem[],     resultKey }
  { kind: "group",           items: PanelSchema[],         legend? }
>
```

The community command returns a schema plus a `buildCommand(values: Record<string, unknown>) => string` callback (also worker-side) that consumes the user's filled-in values and assembles the shell command.

The schema is intentionally narrow:

- It can collect input.
- It can constrain choices (dropdowns / lists / toggles).
- It cannot run JS in the host context, mutate the DOM, or claim focus outside the panel area.

Once published the schema is a stable API surface. Extending it is additive; existing extensions keep working.

### Manifest

```
ShaxCommandManifest {
  name             "shax-aws-cli"
  version          "1.0.0"
  description      "Helpers for AWS CLI workflows"
  shaxApiVersion   1
  permissions      []                 // empty for now; future fine-grain context perms
  entry            "./command.js"     // worker module
}
```

Manifest path on disk (per-user) is `~/.config/shax/commands/<name>/manifest.json` and `~/.config/shax/commands/<name>/command.js`. Loaded on app start; reloadable from the palette via a built-in "Reload commands" entry.

## Discoverability

- Palette is empty when first opened — type to filter, or scroll the full list.
- A "Help / cheat-sheet" entry at the bottom of the palette lists every built-in plus their matcher conditions ("Available when in a git repo").
- The `?` key inside the palette opens a brief overlay describing the palette's own keymap.

## What's deliberately out of scope (v1)

- **Multi-pane operations.** A palette command acts on the active pane only. Cross-pane operations ("run this in every pane") are a separate, later feature.
- **Background / non-emitting commands.** Every palette command ends by emitting a shell command. We do not offer "commands that don't write to the prompt." If a palette entry has no command to emit (like read-only `git status`), it just shows data and closes — but it doesn't *do* anything else.
- **Mouse-driven file-browser drag-drop.** Pure keyboard / single-click navigation is the v1 surface.
- **Per-command keybindings.** Discovery is via the palette; later we can let users bind palette commands directly to shortcut keys, but v1 ships through `Cmd+K` only.

## Cross-references

- `02-rendering-two-path.md` — every palette command emits a real shell command into the prompt; honest log applies.
- `07-formatters.md` — sister registry-and-sandbox pattern. Same trust model, same idempotency rule.
- `10-safety-and-permissions.md` — the gate catches destructive commands regardless of authoring path; palette is one such path.
- `12-roadmap-milestones.md` — `M8` introduces the palette framework + the built-in `cd` and git commands. The community-sandbox half ships alongside the formatter sandbox in M4 polish or M8 depending on which lands first.
