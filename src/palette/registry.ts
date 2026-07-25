/**
 * Pane-command registry (M8 spec §14 — the `Cmd+Shift+P` palette).
 *
 * Mirrors the shape of the formatter registry (specs/07): a
 * `PaneCommand` describes an *action* (produce a shell command
 * string), a `Formatter` describes a *render* (produce a rich
 * view of bytes). Same trust model, same idempotency-by-name
 * rule, same host / community sandbox split (built-ins land in
 * M8.1–M8.4; the sandbox lands in M8.5).
 */

import type React from "react";

/**
 * What matchers and panel components see. A synchronous snapshot
 * of the active pane at the moment the palette opens. `null`
 * fields are for panes that haven't produced a value yet (fresh
 * pane before the first `OSC 133 A`, non-git cwd, etc.).
 *
 * M8.1 ships the minimum needed for the stub. Later slices
 * extend with `gitRoot`, `blocks`, `selectedBlock` per §14 as
 * the built-ins that need them arrive.
 */
export interface PaneContext {
  /** Backend pty id of the active pane. Always set (the palette
   *  doesn't open when there's no pane). */
  ptyId: string;
  /** Working directory, from the most recent `OSC 133 A`. */
  cwd: string | null;
  /** Current git branch, from the most recent prompt hint. */
  branch: string | null;
  /** Absolute path to the nearest ancestor `.git` — `null` when
   *  `cwd` is not inside a repo. Resolved lazily by the palette
   *  on open via the `git_root_for` IPC. Git commands (M8.3+)
   *  matcher on `ctx.gitRoot !== null`. */
  gitRoot: string | null;
}

/** Grouping in the palette list body. Sections read as small
 *  headers above their entries. Community commands land under
 *  `"Custom"` regardless of what the manifest says. */
export type PaneCommandGroup = "Navigation" | "Git" | "Custom" | "Debug";

/**
 * The rendered panel for a command. Two shapes:
 *  - `preview` — a string. The overlay draws it in the footer,
 *    `Enter` submits it as-is. Simplest case, used by the M8.1
 *    stub.
 *  - `panel` — a React component. Rendered inside the palette
 *    overlay's body; when the panel resolves (via `onSubmit`)
 *    the overlay writes the result string to the prompt. Used
 *    by cd, git commands, etc.
 *
 * Either shape may `null` out to signal "no command to emit"
 * (read-only commands like `git status` in M8.3).
 */
export type PaneCommandRender =
  | { kind: "preview"; command: string }
  | {
      kind: "panel";
      Panel: React.ComponentType<{
        ctx: PaneContext;
        onSubmit: (command: string | null) => void;
      }>;
    };

/** A single palette entry. Registration is idempotent by
 *  `name` — re-registering the same name silently wins (matches
 *  the formatter registry so HMR doesn't produce duplicates). */
export interface PaneCommand {
  /** Human-readable, unique. Serves as the identity key. */
  name: string;
  /** One-line explanation shown in the palette list. */
  description: string;
  /** Section header in the palette list body. */
  group: PaneCommandGroup;
  /** Predicate over the current `PaneContext`. Runs
   *  synchronously on every filter tick; keep it cheap. Return
   *  `true` if the command should appear in the list. */
  matcher: (ctx: PaneContext) => boolean;
  /** Build the panel / preview when the user selects the row. */
  render: (ctx: PaneContext) => PaneCommandRender;
}

const registry = new Map<string, PaneCommand>();

/** Register a `PaneCommand`. Idempotent by name — the last
 *  registration wins. Returns the command back for chaining. */
export function registerPaneCommand(command: PaneCommand): PaneCommand {
  registry.set(command.name, command);
  return command;
}

/** Snapshot of registered commands, in registration order. */
export function listPaneCommands(): PaneCommand[] {
  return Array.from(registry.values());
}

/** Filter the registry by `PaneContext` availability. */
export function availableCommands(ctx: PaneContext): PaneCommand[] {
  return listPaneCommands().filter((c) => c.matcher(ctx));
}

/** Test hook — wipe the registry so tests don't leak state
 *  across cases. Not exported for production use. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
