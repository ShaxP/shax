# `docs/` — Shax documentation

This tree is the **external** face of the codebase: how-to guides, quickstarts, and references for people who use Shax or extend it. If you're looking for design intent — *why* Shax is shaped this way — read `specs/` instead.

## Convention

**Docs are external, specs are internal.** A `docs/*.md` change is user-visible; a `specs/*.md` change is design intent. If the two disagree on *how* something works, docs win (they're what users read); on *why* it works that way, specs win (they're the reasoning of record). Docs that mirror a spec always link the spec at the top; the spec doesn't have to know about the doc.

## Index

| File | Audience | Purpose | Mirrors |
|---|---|---|---|
| [community-commands.md](community-commands.md) | Extension author | Write a community pane-command add-on that ships as `manifest.json` + `command.js` in `~/.config/shax/commands/<name>/`. | `specs/14-pane-commands.md` |
| [community-formatters.md](community-formatters.md) | Extension author | Write a community formatter add-on that turns command output into a rich view. | `specs/07-formatters.md` |
| [safety-gate.md](safety-gate.md) | Extension author | How the safety gate classifies commands your add-on emits — `routine`, `destructive`, or `ai`, and what the user sees for each. | `specs/10-safety-and-permissions.md` |
| [contributor-quickstart.md](contributor-quickstart.md) | Contributor | Ten-minute path from `git clone` to a running `npm run tauri:dev`, plus the three tests you'll run most. | — |
| [branching-and-workflow.md](branching-and-workflow.md) | Contributor | Trunk-based Git workflow: branch names, Conventional Commits, PR rules, release tagging. | — |
| [verification-backlog.md](verification-backlog.md) | Contributor | Merged work that CI cannot prove — needs real hardware, a real OS prompt, or a platform we don't develop on. Delete entries as they're confirmed. | — |

## When to write a new doc

- **Extension surface changes** — a new schema kind, a new manifest field, a new safety-gate classification — update the matching author doc *in the same PR* as the code. That's the fastest-rotting part of `docs/` because it says what code does.
- **Onboarding gaps** — if a contributor asks the same question twice, it belongs in `contributor-quickstart.md` or its own file.
- **User-facing features** — keyboard shortcuts, split layouts, history search, block toggle, viewer, assistant — belong in a future `docs/user-guide.md`, not here yet. That doc will land once the user surface is stable.

## When to update a spec instead

Anything that answers "why is this shaped like this" — design constraints, tradeoffs, deferred alternatives — belongs in `specs/`. Anything that answers "how do I use this" — signatures, field names, examples — belongs here.
