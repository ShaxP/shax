# Shax

An AI-aware terminal emulator for developers. Shax runs ordinary Linux and Unix commands but treats each command and its output as a structured, searchable, occasionally interactive "block." A Claude-powered assistant is available throughout but stays quiet until invoked. It is a calm, fast, local-first daily driver, not an AI gadget.

Actively developed. Milestones M0–M8 have shipped: a working terminal with structured blocks, native multiplexing, history search (FTS + semantic), a file viewer with static formatters, interactive widgets, the assistant with its safety gate, and the `⌘⇧P` pane-command palette with a community-command sandbox. See `specs/12-roadmap-milestones.md` for the full plan.

## Documentation

- **Extension authors** — write add-ons that appear in the `⌘⇧P` palette or format command output:
  - `docs/community-commands.md` — community pane commands.
  - `docs/community-formatters.md` — community formatters.
  - `docs/safety-gate.md` — how emitted commands are classified.
- **Contributors** — build and change Shax itself:
  - `docs/contributor-quickstart.md` — ten-minute path from clone to a running dev build.
  - `docs/branching-and-workflow.md` — Git workflow, PR rules.
  - `docs/README.md` — index of everything in `docs/`.

## What is in here

- `specs/` numbered specifications. Start at `specs/00-overview.md` and read in order.
- `docs/` external documentation (see above).
- `CLAUDE.md` the always-on guardrails every agent inherits: clean-code rules, conventions, Git workflow, testing policy, and the definition of done.
- `.claude/agents/` the agent team: one lead plus three engineers.
- `.claude/skills/` reusable skills for the team, with install notes in `.claude/skills/README.md`.
- `.github/workflows/ci.yml` continuous integration.
- `LICENSE` MIT.

## Building it

```sh
git clone https://github.com/ShaxP/shax.git
cd shax
npm install
npm run tauri:dev
```

Full setup — Rust toolchain, Tauri 2 platform deps, the three tests you'll run most — in `docs/contributor-quickstart.md`.

## Continuing development with an agent team

Shax is written with a Claude Code agent team (one orchestrator plus three engineers, see `.claude/agents/`). To pick up where the roadmap left off:

1. Make sure you are on Claude Code v2.1.32 or later and have Opus access through a Pro or Max plan.
2. Enable agent teams:
   ```
   export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
   ```
   Optionally install `tmux` for per-agent terminal panels.
3. Open Claude Code at this repo root and install the skills (see `.claude/skills/README.md`).
4. Start a task aimed at the orchestrator, for example:
   > Read CLAUDE.md and specs/12-roadmap-milestones.md. Form a team with the core, frontend, and ai engineers and execute the next milestone. Open a PR when the definition of done is met. Do not merge.

## License

MIT. See `LICENSE`.
