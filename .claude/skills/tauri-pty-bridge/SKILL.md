---
name: tauri-pty-bridge
description: Use when wiring PTYs to the frontend in Shax: creating per-pane PTYs with portable-pty, streaming output over Tauri channels, sending keystrokes, propagating resize and winsize, and tearing down and reaping processes cleanly. For the core engineer at M1 and M2.
---

# Tauri PTY bridge

How the Rust backend owns PTYs and talks to the React frontend without blocking or leaking.

## One PTY per pane

Each pane has its own PTY pair from `portable-pty`. Keep a registry keyed by `pane_id` holding the master, the writer, the child process handle, and the current rows and cols.

## Streaming output

Spawn a reader task per pane that reads from the PTY master in a loop and forwards bytes to the frontend over a Tauri channel tagged with the `pane_id`. Do the blocking read on a dedicated thread (PTY reads are blocking) and hand bytes to the async side; never block the tokio runtime on the read. Forward raw bytes; the frontend's xterm instance interprets them.

## Sending keystrokes

A Tauri command takes `pane_id` and the input bytes and writes them to that pane's PTY writer. Keep writes ordered per pane.

## Resize and winsize

This is the most common correctness bug. When the frontend's fit addon computes new cols and rows (on divider move or window resize), it calls a command that does `pty.resize(PtySize { rows, cols, .. })` for that pane. If you skip this, full-screen TUIs (vim, htop, less) render garbage. Debounce rapid resizes, but always apply the final size.

## Teardown and reaping

Closing a pane must kill the child's whole process group and reap it, or you accumulate zombies. Run the same path when the shell exits on its own (the reader hits EOF or the child exits): stop the reader task, drop the PTY, remove the registry entry, and tell the mux layer to collapse the node. On app shutdown, tear down every pane.

## Backpressure and large output

A command can produce output faster than the frontend renders. Bound the channel and let the reader feel backpressure, or coalesce, rather than buffering unboundedly. For capture (the block's stored output), cap per-block size and spill to disk for the overflow; never hold a 2 GB file in memory.

## Alt-screen signal

While forwarding bytes, the VT layer flags `?1049h` and `?1049l` so the frontend knows to stay in raw passthrough for that pane. Keep this independent of OSC 133 capture.

## Test

PTY lifecycle (spawn, read, write, exit), resize propagation (assert the child sees the new winsize, for example via a `stty size` round-trip), and reaping (no lingering processes after close).
