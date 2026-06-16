# 01 Architecture

## Shape

Shax is a Tauri 2 application. The Rust backend owns everything that must be fast, correct, or close to the operating system. The React frontend owns everything the user sees. They communicate over Tauri commands (request and response) and Tauri channels (streaming, for PTY bytes and events).

```
+-------------------------------------------------------------+
|  React + TypeScript frontend (webview)                      |
|                                                             |
|  Pane tree -> xterm.js instances        Block list (virt.)  |
|  Raw/formatted toggle    Formatters + sandbox    Widgets    |
|  CodeMirror viewer   Markdown/image   Search UI   Assistant |
+----------------------------^--------------------------------+
                             | Tauri commands + channels (per pane_id)
+----------------------------v--------------------------------+
|  Rust backend (src-tauri)                                   |
|                                                             |
|  PTY manager (portable-pty, one per pane)                   |
|  VT layer + OSC 133 capture -> block records                |
|  Multiplexing layout owner (split tree, focus, sessions)    |
|  SQLite store (blocks, output) + search (FTS5, sqlite-vec)  |
|  Agent SDK bridge        Safety / approval gate policy      |
+-------------------------------------------------------------+
```

## Backend responsibilities (src-tauri)

- **PTY manager.** One PTY per pane via `portable-pty`. A reader task streams output bytes to the frontend over a channel keyed by `pane_id`. Writes (keystrokes) come back as commands. Owns winsize and resize, and process-group teardown and reaping.
- **VT and OSC 133 layer.** Parses the stream enough to detect the alternate screen (`?1049h` / `?1049l`) and the OSC 133 prompt and command markers, so it can tell the frontend when to stay in raw passthrough and can assemble block records with command boundaries, exit codes, and timing.
- **Multiplexing layout owner.** Holds the canonical layout as a binary split tree, the focused pane, and the tab set. Persists layout plus per-pane cwd and light state for session restore.
- **Store and search.** SQLite holds blocks and output. FTS5 backs literal search; `sqlite-vec` backs semantic search. An indexing step runs when a block completes.
- **Agent SDK bridge.** Invokes the user's local Claude Agent SDK, applies tool constraints, and routes any side effect through the safety gate policy.
- **Safety gate policy.** Decides which commands need approval and what to show; the frontend renders the dialog.

## Frontend responsibilities (src)

- Renders the pane tree as xterm.js instances and the block list as a virtualized view.
- Owns the raw and formatted toggle, the formatter registry and its worker sandbox, and the interactive widgets.
- Owns the CodeMirror viewer, markdown and image rendering, the search UI, the assistant UI, and settings.
- Owns vim-style navigation and the mode indicator.

## The two key data flows

**Keystroke and live output.** Key in a focused pane goes by command to the backend, into that pane's PTY. Output bytes stream back over the channel and into that pane's xterm instance. While a program owns the alternate screen, this is the whole story; nothing is formatted.

**Command lifecycle.** Shell-integration hooks emit OSC 133 markers around each command. The backend uses them to bound the command, capture stdout and stderr, record the exit code and timing, and produce a block record. The record is stored and indexed, and pushed to the frontend, which decides raw, static-rich, or interactive-widget rendering per `02-rendering-two-path.md`.

## Boundaries

The frontend never reaches past the IPC contract into operating-system state. The backend never renders. Side effects are always visible commands plus the approval gate. These boundaries are what keep the fidelity contract and the honest log enforceable.
