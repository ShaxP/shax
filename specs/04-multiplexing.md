# 04 Multiplexing

Native, local multiplexing: panes, splits, tabs, and layout restore. We do not build a detachable client/server like tmux. For remote persistence, users run tmux over SSH and we stay out of its way.

## Layout model

The layout is a binary split tree:

```
Node = Split { direction: Horizontal | Vertical, ratio: float, a: Node, b: Node }
     | Leaf  { pane_id: uuid }
```

A tab holds one tree. The backend owns the canonical tree, the focused `pane_id`, and the tab set. The frontend renders it and sends layout intents (split, close, focus, resize a divider, switch tab) back as commands.

## Panes and PTYs

One PTY per pane via `portable-pty`. Each pane has a reader task streaming bytes to the frontend over a channel keyed by `pane_id`, and accepts writes (keystrokes) the same way. A pane is backed by exactly one shell process.

## The things that actually bite, in order

1. **Resize and winsize.** When a divider moves or the window resizes, the frontend computes new cols and rows (xterm fit addon) and the backend must call `pty.resize` for that pane. Without this, full-screen TUIs (vim, htop, less) render garbage. Test this explicitly.
2. **Process reaping.** Closing a pane kills the child's whole process group and reaps it; no zombies. The same teardown path runs when the user types `exit` and the shell dies on its own: collapse the node, free the pane, rebalance the tree.
3. **Layout as state.** Since there is no detach, persist the tree plus each pane's cwd and light state so reopening rebuilds the same layout. This is session restore without a tmux server. Do not persist live process state; restored panes start fresh shells in the saved cwd.
4. **Focus.** Exactly one pane is focused; keystrokes and the prompt's vim mode apply to it. Splitting focuses the new pane. Closing focuses a sensible neighbor.

## Tabs

Tabs are independent layout trees. Switching tabs changes which tree renders; background tabs keep their PTYs alive.

## Performance fork

One xterm.js instance per pane is the fast path and is fine for a handful of panes. Only if we ever need dozens of panes do we move to a single-renderer model (an `alacritty_terminal` grid behind one WebGL surface). Start with xterm-per-pane; revisit only if it bites.

## Coexisting with tmux

If a pane is running tmux (typically inside an SSH session), do not nest Shax features awkwardly inside it. Detect it where feasible and behave as a plain terminal for that pane. Remote rich rendering is a later milestone.

## AI and multiplexing

The assistant can request its own pane to run work beside the user (see `09`). That pane is a normal pane in the tree; the assistant acts in it through visible commands behind the approval gate. Search spans every pane and session.
