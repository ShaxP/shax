/**
 * Git palette built-ins (M8.3). Both matcher on
 * `ctx.gitRoot !== null` — outside a git repo they simply
 * don't appear in the palette list. `git status` is read-only
 * (no command emit); `git checkout` returns
 * `git checkout <branch>` (or the "new local from remote"
 * variant for remote-tracking refs).
 */

import { registerPaneCommand } from "../../registry";
import { GitStatusPanel } from "./GitStatusPanel";
import { GitCheckoutPanel } from "./GitCheckoutPanel";
import { GitStashPanel } from "./GitStashPanel";
import { GitCommitPanel } from "./GitCommitPanel";
import { GitRebasePanel } from "./GitRebasePanel";

registerPaneCommand({
  name: "git status",
  description: "Show the working tree status (read-only viewer).",
  group: "Git",
  matcher: (ctx) => ctx.gitRoot !== null,
  render: () => ({ kind: "panel", Panel: GitStatusPanel }),
});

registerPaneCommand({
  name: "git checkout",
  description: "Pick a branch to switch to.",
  group: "Git",
  matcher: (ctx) => ctx.gitRoot !== null,
  render: () => ({ kind: "panel", Panel: GitCheckoutPanel }),
});

registerPaneCommand({
  name: "git stash",
  description: "Stash the current working tree with an optional message.",
  group: "Git",
  matcher: (ctx) => ctx.gitRoot !== null,
  render: () => ({ kind: "panel", Panel: GitStashPanel }),
});

registerPaneCommand({
  name: "git commit",
  description: "Compose a commit — subject, body, optional sign-off.",
  group: "Git",
  matcher: (ctx) => ctx.gitRoot !== null,
  render: () => ({ kind: "panel", Panel: GitCommitPanel }),
});

registerPaneCommand({
  name: "git rebase",
  description: "Rebase the current branch onto a target (destructive).",
  group: "Git",
  matcher: (ctx) => ctx.gitRoot !== null,
  render: () => ({ kind: "panel", Panel: GitRebasePanel }),
});
