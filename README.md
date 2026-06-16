# Shax

An AI-aware terminal emulator for developers. Shax runs ordinary Linux and Unix commands but treats each command and its output as a structured, searchable, occasionally interactive "block." A Claude-powered assistant is available throughout but stays quiet until invoked. It is a calm, fast, local-first daily driver, not an AI gadget.

This repository currently contains the **specifications and build guardrails**, not yet the implementation. It is structured so that a Claude Code agent team can pick it up and build the product.

## What is in here

- `specs/` numbered specifications. Start at `specs/00-overview.md` and read in order.
- `CLAUDE.md` the always-on guardrails every agent inherits: clean-code rules, conventions, Git workflow, testing policy, and the definition of done.
- `.claude/agents/` the agent team: one lead plus three engineers.
- `.claude/skills/` reusable skills for the team, with install notes in `.claude/skills/README.md`.
- `docs/branching-and-workflow.md` the Git and release workflow.
- `.github/workflows/ci.yml` continuous integration.
- `LICENSE` MIT.

## How to start the build

1. Make sure you are on Claude Code v2.1.32 or later and have Opus 4.6 access through a Pro or Max plan.
2. Enable agent teams. Add to your shell or to `settings.json`:
   ```
   export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
   ```
   Optionally install `tmux` for per-agent terminal panels (fitting, given what we are building).
3. Open Claude Code at this repo root: `/Users/shahram/source/repos/shax`.
4. Install the skills (see `.claude/skills/README.md`).
5. Start a team task aimed at the orchestrator, for example:
   > Read CLAUDE.md and specs/00-overview.md, then specs/12-roadmap-milestones.md. Form a team with the core, frontend, and ai engineers and execute milestone M0. Open a PR when the definition of done is met. Do not merge.

## Build order

Terminal (PTY plus blocks via OSC 133), then native multiplexing, then search, then the file viewer and static formatters, then interactive widgets (diff, status, ls), then the AI assistant and auth. See `specs/12-roadmap-milestones.md`.

## License

MIT. See `LICENSE`.
