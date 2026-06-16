# 11 Tech stack and conventions

Concrete choices. Pin versions in the lockfiles; the names below are the intended dependencies.

## Runtime stack

- **Shell:** Tauri 2 (Rust host, webview frontend), packaged for macOS, Windows, and Linux.
- **Backend (Rust):**
  - `portable-pty` for PTYs.
  - a VT parser (`vte`) for the escape and OSC 133 handling; consider `alacritty_terminal` only if a single-renderer model is needed later.
  - `rusqlite` with bundled SQLite (FTS5 enabled) plus `sqlite-vec` for embeddings.
  - `tokio` for async, `serde` for IPC payloads, `thiserror` for library errors, `anyhow` at app edges, `uuid`, `time` or `chrono`.
- **Frontend (TypeScript, React):**
  - React 18+ with strict TypeScript, built with Vite.
  - `xterm.js` plus the fit addon for terminal rendering.
  - CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/lang-*`) plus `@replit/codemirror-vim` for the viewer.
  - `react-markdown` with `remark` plugins, and `dompurify` for sanitizing rendered markdown and SVG.
- **AI:** the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), driven locally; see `09`.

## Tooling

- **Package manager:** pnpm.
- **Rust:** `rustfmt`, `clippy` (CI runs `-D warnings`), pinned via `rust-toolchain.toml`.
- **TypeScript:** ESLint, Prettier, `tsc --noEmit` for typecheck. Node pinned via Volta (or `.nvmrc`).
- **Tests:** Rust built-in test framework (and `cargo nextest` if useful); Vitest for frontend unit tests; Playwright for end-to-end UI flows.
- **Hooks:** lefthook (or husky) with lint-staged running fmt, lint, and typecheck on staged files. Tests run in CI.

## Repository layout

```
shax/
  src-tauri/
    src/
      pty/            PTY manager, reader tasks, resize, reaping
      vt/             escape and OSC 133 parsing, alt-screen detection
      blocks/         block assembly and lifecycle
      mux/            layout tree, focus, tabs, session restore
      store/          SQLite schema, migrations, output storage
      search/         FTS5 and sqlite-vec queries, indexing
      agent/          Agent SDK bridge
      safety/         approval-gate policy
      ipc/            Tauri commands and channels
    Cargo.toml
  src/
    panes/            pane tree, xterm instances, tabs
    blocks/           block list, block view, raw/formatted toggle
    viewer/           CodeMirror viewer, markdown, images
    formatters/       registry, sandbox, built-ins
    widgets/          git diff, git status, ls
    search/           search UI
    assistant/        assistant UI, approval dialog
    settings/         settings including auth lanes
    lib/              shared types (IPC contract mirrors), utils
  specs/
  docs/
  .claude/
  .github/
```

## Conventions

- **Naming:** Rust `snake_case` items and `CamelCase` types; TypeScript `camelCase` values and `PascalCase` components and types. Names describe intent.
- **IPC contract:** define payload types once and mirror them on both sides. Treat the contract as an interface to agree before implementing across the seam.
- **Errors:** Rust returns `Result` with typed errors; the frontend handles failure explicitly and never swallows errors silently.
- **Logging:** structured, leveled, local. Never log secrets, credentials, or full command output by default.
- **Comments and docs:** public Rust items get `///`; comments explain why. Specs are the source of truth for behavior; if code must diverge, update the spec in the same PR.
