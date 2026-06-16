# CLAUDE.md

This file is read by every agent on every task. It is the contract. If anything here conflicts with a spec, this file wins on process and principles; the spec wins on product behavior. When in doubt, ask rather than guess.

## What we are building

Shax is a cross-platform desktop terminal emulator (Tauri 2, Rust backend, React and TypeScript frontend). It runs real shell commands, captures each command and its output as a structured block, makes the full history searchable, renders rich and sometimes interactive views of completed output, and offers a Claude-powered assistant that stays out of the way until invoked. Read `specs/00-overview.md` for the product, `specs/01-architecture.md` for the shape.

## Non-negotiable product principles

These are the soul of the product. Violating them is a defect even if the code works.

1. **Daily-driver first.** It must feel as fast and calm as a great native terminal. The AI is reached for, never intrusive.
2. **The fidelity contract.** Every rich or formatted view is a lens over the real bytes. The raw output is always one toggle away, and a formatter that errors falls back to raw silently. Never let a pretty view hide ground truth.
3. **The honest log.** The scrollback is a truthful, reproducible history. Any action taken by a widget or the assistant happens by emitting a real, visible command, never a hidden side effect.
4. **Never hijack input-owning programs.** Programs that own their own input loop or the alternate screen (vim, less, top, ssh sessions, REPLs) always render as raw passthrough. Only non-interactive, exited commands may be formatted or promoted to widgets, and only behind the promotion gate in `specs/02-rendering-two-path.md`.
5. **Gate every side effect.** Anything destructive or state-changing, whether from a widget or the assistant, passes through the approval gate in `specs/10-safety-and-permissions.md`.
6. **Local-first and private.** No account is required to use the terminal. History lives on the user's machine. No telemetry without explicit opt-in. Never handle or store Claude credentials directly (see `specs/09-ai-assistant-and-auth.md`).

## Tech stack

See `specs/11-tech-stack-and-conventions.md` for versions and the full crate and package list. In short: Tauri 2; Rust with `portable-pty`, a VT parser, `rusqlite` with SQLite FTS5 and `sqlite-vec`, `tokio`, `thiserror`, `anyhow`, `serde`; React with strict TypeScript, Vite, `xterm.js`, CodeMirror 6, `react-markdown` with DOMPurify; the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) driven locally.

## Repository layout

```
shax/
  src-tauri/        Rust backend (PTY, VT, OSC 133, multiplexing, store, search, agent bridge, safety)
  src/              React + TypeScript frontend (panes, blocks, viewer, widgets, search UI, assistant UI)
  specs/            specifications (source of truth for behavior)
  docs/             workflow and contributor docs
  .claude/          agents and skills
  .github/          CI
```

## Clean code principles

We follow Clean Code and SOLID, adapted with language idioms. Concretely:

- Functions are small and do one thing. If you need "and" to describe it, split it.
- Names say what they mean. No abbreviations that need a comment to decode.
- Comments explain *why*, not *what*. Code says what. Delete commented-out code.
- No dead code, no speculative generality. Build what the current milestone needs.
- Dependencies point inward toward stable abstractions. UI depends on the core, never the reverse.
- Prefer composition over inheritance, pure functions over hidden state, and explicit errors over panics.
- DRY within reason. Two similar things are fine; three is a pattern to extract.

## Language conventions

**Rust**
- `cargo fmt` and `cargo clippy` must be clean. CI runs clippy with `-D warnings`.
- Errors are values. Use `thiserror` for library error types and `anyhow` only at application edges. No `unwrap` or `expect` outside tests and `main` startup.
- Keep modules cohesive; one responsibility per module. Public items are documented with `///`.
- Async on `tokio`. Never block the async runtime on PTY or disk IO.

**TypeScript and React**
- Strict TypeScript. No `any`; use `unknown` and narrow. No non-null `!` assertions without a comment justifying them.
- Function components and hooks only. No class components.
- ESLint and Prettier must be clean. Small files, named exports, colocated styles.
- No browser storage APIs for app state; state lives in React state or comes from the Rust backend over Tauri IPC.

## Testing policy

Test-alongside, not test-first. Write tests in the same change as the code they cover.

- **Core logic must have meaningful tests:** the VT parser and OSC 133 capture, the PTY and multiplexing lifecycle, the block and search data model, formatters and the promotion gate, and the safety and permission gate. These are where correctness bugs hurt, so cover the real cases and the edge cases, not just the happy path.
- **UI is covered by Playwright end-to-end tests** for the flows that matter (run a command and see a block, split a pane, search history, open a viewer, approve a gated command). Do not chase unit-test coverage on pure presentation.
- No hard coverage percentage. The bar is "core logic is genuinely tested and CI is green," judged at review.
- A change that touches core logic without tests is not done.

## Git workflow

Trunk-based. Full details in `docs/branching-and-workflow.md`.

- `main` is always releasable. Branch off it: `feat/...`, `fix/...`, `chore/...`, `docs/...`.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).
- One logical change per PR. Squash-merge. Keep `main` linear.
- Agents open PRs but never merge. The human approves and merges. Never force-push `main`.

## Definition of done

A task is done only when all of these hold:

1. It satisfies the relevant spec, and the PR description links the spec section.
2. `cargo fmt`, `cargo clippy -D warnings`, ESLint, Prettier, and `tsc` are all clean.
3. Tests are written alongside and pass; CI is green on all three platforms.
4. The non-negotiable principles above are upheld (fidelity, honest log, no hijacking, gated side effects).
5. Public APIs are documented and any affected docs or specs are updated.
6. A PR is open, scoped to one logical change, with a clear description. It is not merged.

## Agent team operating model

The team is a lead plus three engineers (see `.claude/agents/`). The lead is the orchestrator, architect, and reviewer; it reads specs, breaks work into tasks, sequences them, dispatches engineers, and gatekeeps the definition of done. The three engineers own clear seams:

- **core-engineer** owns the Rust backend: PTY, VT, OSC 133, multiplexing, the store, and search.
- **frontend-engineer** owns the React UI: panes, blocks, the viewer, widgets, formatters, and search UI.
- **ai-engineer** owns the assistant: Agent SDK integration, the two auth lanes, and the approval gate.

Each engineer writes tests alongside their own code. The lead does not write feature code; it plans, reviews, and integrates.

Cost discipline: agent teams cost roughly seven times a single session and inter-agent messages are round trips. Scope a team to one milestone or one vertical slice. Do not run all engineers in parallel on unrelated work. Tier models: Opus for the lead, Sonnet for the engineers.

Hard guardrails for all agents: never merge, never force-push `main`, never commit secrets or credentials, never weaken the safety gate, never make a destructive change without an approved plan, and never cross another engineer's seam without coordinating through the lead.
