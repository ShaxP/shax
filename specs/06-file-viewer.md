# 06 File and content viewer

When a completed block shows file contents, or the user opens a file from a widget, Shax renders a rich, navigable viewer instead of flat text. One library does almost all of it.

## The viewer

A read-only CodeMirror 6 instance provides, out of the box:

- syntax highlighting via the `@codemirror/lang-*` grammars,
- a line-number gutter,
- virtualized scrolling that survives large files,
- an in-content search panel,
- vim keybindings via `@replit/codemirror-vim`, with a visible mode indicator.

If we later want VS Code-grade colors specifically, pre-highlight display-only blocks with Shiki and reserve CodeMirror for the navigable viewer. Start with CodeMirror alone; add Shiki only if the colors are not good enough.

## What triggers the viewer

- The static formatter for non-interactive file dumps (`cat`, `bat`) that print and exit, so we can capture them.
- A click on a filename in an `ls` widget or other file reference, opening that file in the viewer.

The viewer is additive. It is the formatter for completed `cat`-style output and a first-class open action. It never replaces interactive programs.

## Do not hijack less or vim

Rewriting the user's interactive commands is the dangerous path. Real `less` stays `less` and real `vim` stays `vim`, on the raw path. The viewer formats non-interactive dumps and opens files on demand; it does not intercept input-owning programs.

## Markdown

Render `.md` with `react-markdown` (remark). Markdown can embed raw HTML, so sanitize the rendered output with DOMPurify before it touches the DOM. This is a real injection surface in a webview, not a theoretical one.

## Images

Render png, jpeg, and gif as a plain image element inside a block; gif animates for free. When a command's target is binary (detected by magic bytes or extension), detect it and offer to view rather than spewing bytes into the grid.

SVG is special: it can carry `<script>` and `<foreignObject>`. Sanitize and sandbox SVG (strip scripts and event handlers) before rendering. A malicious file the user views must never run code in the app's context.

## Big files

Cap and virtualize. CodeMirror virtualizes the viewer; for very large files, stream from the backend rather than buffering the whole file, and show a clear "truncated, view raw or open fully" affordance.

## Vim navigation, two scopes

Keep these distinct (see also `08`): inside a viewer block, `@replit/codemirror-vim` handles movement and search; across the session, a separate terminal-level normal mode moves between blocks and through scrollback. The keybindings should feel consistent (`j`, `k`, `gg`, `G`, `/`).

## Out of scope for now

Rich rendering of remote files over SSH, and the Kitty graphics protocol or Sixel inline images from remote programs. The local "open a file" path covers the common case; remote is a later milestone.
