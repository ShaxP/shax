# Contributor quickstart

Ten minutes from `git clone` to a running dev build. If you'll be extending Shax rather than building it, start at [`community-commands.md`](community-commands.md) or [`community-formatters.md`](community-formatters.md) instead — you don't need a local checkout for that.

## Prerequisites

- **Rust** — the toolchain is pinned in `rust-toolchain.toml` (currently `1.95.0`). Install [rustup](https://rustup.rs); it will read the pin automatically the first time you `cargo` inside the repo.
- **Node** — no `.nvmrc` today. Anything reasonably recent (LTS or newer) works; CI runs on the default runner Node.
- **pnpm** — required (not just preferred). `src-tauri/tauri.conf.json` sets `"beforeDevCommand": "pnpm dev"`, so even if you get `npm install` past the peer-dep checks, `pnpm run tauri:dev` will fail when Tauri tries to invoke pnpm to start the vite dev server. Install with `npm install -g pnpm` (or `corepack enable && corepack prepare pnpm@latest --activate`). The pre-commit hook is [lefthook](https://github.com/evilmartians/lefthook), installed via `pnpm install`'s `prepare` script.
- **`cargo` must be on `PATH` wherever you run `git`.** `lefthook.yml` calls `cargo fmt` (pre-commit) and `cargo clippy` (pre-push) directly. Hooks run through `sh` and read no shell rc file — they only inherit `PATH` from whatever launched `git`. So a toolchain that lives only on an *interactive* shell's `PATH` works fine when you commit from a terminal and fails with `cargo: command not found` the moment you commit from a GUI git client or an editor's built-in git. This bites two setups in particular: rustup installed with `--no-modify-path`, and version managers whose shims aren't exported into the desktop session. Fix it wherever your login/session environment is defined rather than in `~/.bashrc` — a guard like `[[ $- != *i* ]] && return` near the top of an rc file (Omarchy and many distro skeletons ship one) means anything below it never reaches a non-interactive shell. Symlinking the rustup proxies into a directory the session already exports, such as `~/.local/bin`, is one way.
- **Platform tooling for Tauri.** Follow the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.
  - **macOS.** Xcode. CI pins to Xcode 16.x because 26.5 broke the `ort-sys` link path (see `.github/workflows/ci.yml`).
  - **Linux (Ubuntu 22.04+ tested; 24.04 works).** Install:
    ```sh
    sudo apt-get install -y \
      libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libayatana-appindicator3-dev \
      libssl-dev pkg-config
    ```
    `libssl-dev` + `pkg-config` are needed by the `openssl-sys` crate; CI runners have them preinstalled so this trips only fresh Linux boxes. On **Ubuntu ARM64 in Parallels**, the installer sometimes writes `us.archive.ubuntu.com` (the x86 mirror) into `/etc/apt/sources.list`, which 404s for ARM64 packages. Fix with `sudo sed -i 's|http://us.archive.ubuntu.com/ubuntu|http://ports.ubuntu.com/ubuntu-ports|g' /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; sudo apt-get update` before the install.
  - **Linux VM RAM.** The final link step for a debug Shax binary needs ~2–4 GB of RAM (WebKit + GTK + hundreds of Rust crates). Give your VM at least **8 GB** or the linker gets OOM-killed with `collect2: fatal error: ld terminated with signal 9`. If you can't spare the RAM, add an 8 GB swapfile or install `mold` as a lighter linker.

## First build

```sh
git clone https://github.com/ShaxP/shax.git
cd shax
pnpm install               # also installs the lefthook pre-commit hook
pnpm run tauri:dev
```

Expected: a Tauri window opens with a single terminal pane at your default shell. Run any command; you'll see a "block" appear with its output. `⌘⇧P` opens the pane-command palette; `⌘K` opens the assistant.

The first `tauri:dev` is slow — Cargo compiles the whole backend and downloads a MiniLM ONNX model into `src-tauri/assets/`. Subsequent runs are fast. If the model fetch fails with `curl exit code 22 while fetching ... model_quantized.onnx`, HuggingFace rate-limited you (HTTP 429) — retry a minute later.

## The three tests you'll run most

```sh
pnpm test -- --run         # vitest (frontend unit + component)
pnpm run typecheck         # tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
```

Or run everything CI runs, matching `.github/workflows/ci.yml`:

```sh
pnpm run lint
pnpm run format:check
pnpm exec tsc --noEmit
pnpm test -- --run
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Playwright end-to-end tests (`pnpm run test:e2e`) run in CI on Ubuntu only; running them locally is optional.

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
