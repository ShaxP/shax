# Skills

Skills are reusable, on-demand knowledge the agents load when a task needs it. Each is a folder with a `SKILL.md` that has YAML frontmatter (`name`, `description`) and a Markdown body. The body loads only when the skill is invoked, so they are cheap to keep around.

## Skills in this repo

- **osc133-shell-integration** how to write and parse OSC 133 shell-integration for zsh, bash, and fish. For the core engineer at M1.
- **tauri-pty-bridge** patterns for `portable-pty` plus Tauri channels: per-pane PTYs, the reader task, resize and winsize, and clean reaping. For the core engineer at M1 and M2.
- **shax-formatter-authoring** the formatter and widget API: registration, the context object, the promotion declaration, the visible-command rule, and the sandbox. For the frontend engineer at M4 and M5, and for future community authors.

## Installing the skills

Skills are discovered from two places:

- **Project skills** (recommended here, so the team and any collaborator share them): keep them in this repo at `.claude/skills/<skill-name>/SKILL.md`. They are picked up automatically when Claude Code runs at the repo root. They are already in place; no action needed beyond having the repo checked out.
- **Personal skills** (if you want them available everywhere, across all your projects): copy a skill folder to `~/.claude/skills/<skill-name>/`.

To verify they are loaded, run `/skills` (or the equivalent skills listing) inside Claude Code at the repo root and confirm the three appear. Because each skill's body loads only when invoked, you do not pay for them until an agent actually uses one.

## Adding a skill

Create `.claude/skills/<name>/SKILL.md` with frontmatter:

```
---
name: <kebab-case-name>
description: <one or two sentences on when to use this skill; this is what triggers it>
---

<the body: concrete, actionable guidance>
```

Keep the description specific and trigger-oriented (when to use it), since that is what determines whether the skill activates.
