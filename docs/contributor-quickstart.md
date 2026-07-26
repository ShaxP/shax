# Contributor quickstart

Ten minutes from `git clone` to a running dev build. If you'll be extending Shax rather than building it, start at [`community-commands.md`](community-commands.md) or [`community-formatters.md`](community-formatters.md) instead — you don't need a local checkout for that.

## Prerequisites

- **Rust** — the toolchain is pinned in `rust-toolchain.toml` (currently `1.95.0`). Install [rustup](https://rustup.rs); it will read the pin automatically the first time you `cargo` inside the repo.
- **Node** — no `.nvmrc` today. Anything reasonably recent (LTS or newer) works; CI runs on the default runner Node.
- **pnpm or npm** — the pre-commit hook is [lefthook](https://github.com/evilmartians/lefthook), installed via `npm install`'s `prepare` script. `npm` is fine; `pnpm` works if you prefer.
- **Platform tooling for Tauri.** Follow the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. On macOS this is Xcode; CI pins to Xcode 16.x because 26.5 broke the `ort-sys` link path (see `.github/workflows/ci.yml`). On Linux you need `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libayatana-appindicator3-dev`.

## First build

```sh
git clone https://github.com/ShaxP/shax.git
cd shax
npm install                # also installs the lefthook pre-commit hook
npm run tauri:dev
```

Expected: a Tauri window opens with a single terminal pane at your default shell. Run any command; you'll see a "block" appear with its output. `⌘⇧P` opens the pane-command palette; `⌘K` opens the assistant.

The first `tauri:dev` is slow — Cargo compiles the whole backend and downloads a MiniLM ONNX model into `src-tauri/assets/`. Subsequent runs are fast.

## The three tests you'll run most

```sh
npm test -- --run          # vitest (frontend unit + component)
npm run typecheck          # tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
```

Or run everything CI runs, matching `.github/workflows/ci.yml`:

```sh
npm run lint
npm run format:check
npx tsc --noEmit
npm test -- --run
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Playwright end-to-end tests (`npm run test:e2e`) run in CI on Ubuntu only; running them locally is optional.

## Try a community add-on

The pane-command sandbox is the best-scoped feature to poke at. Copy the `mkdir` sample out of [`community-commands.md`](community-commands.md#a-complete-example--mkdir) into `~/.config/shax/commands/mkdir/`, then in the running app press `⌘⇧P` → **Reload community commands**. Your entry appears in the **Custom** group with a magenta *community* pill.

If it doesn't show up: DevTools console has the answer. `Cmd+Option+I` opens it; look for lines matching `community command "<name>": ...`.

## Where to look next

- **`specs/00-overview.md` → `specs/12-roadmap-milestones.md`.** The product spec, in order. Every PR body links the spec section it implements.
- **`CLAUDE.md`.** The contract every agent (and every contributor) inherits. Non-negotiables, testing policy, definition of done.
- **`docs/branching-and-workflow.md`.** How branches, commits, and PRs are structured. Read before opening your first PR.
- **`.claude/agents/`.** The agent operating model — one lead, three engineers. Useful even if you're a human contributor; it maps the seams (core → backend, frontend → UI, ai → assistant) that the codebase is organised around.

## Making your first PR

- Branch off `main` with a Conventional-Commits-style name: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`.
- One logical change per PR. If you can't describe it in a sentence, split it.
- Link the spec section in the PR description.
- CI must be green on all three OS runners before review.
- Squash-merge; keep `main` linear.

Full rules in [`branching-and-workflow.md`](branching-and-workflow.md).
