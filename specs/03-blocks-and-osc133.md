# 03 Blocks and OSC 133

## The block is the unit

Everything in Shax (rendering, search, the assistant's memory) depends on capturing each command as a structured record. That capture depends on knowing where each command begins and ends, which is what OSC 133 shell integration gives us.

## The block record

```
Block {
  id:          uuid
  pane_id:     uuid          // which pane produced it
  session_id:  uuid          // which session
  command:     string        // the full command line as entered
  argv:        string[]      // parsed argv when available
  cwd:         string        // working directory at run time
  git_branch:  string?       // branch if inside a repo
  host:        string        // local hostname, or remote if known
  exit_code:   int?          // null while running
  started_at:  timestamp
  ended_at:    timestamp?    // null while running
  duration_ms: int?
  output_ref:  OutputRef     // handle to captured stdout+stderr (see storage)
  state:       enum { Running, Completed, Collapsed }
}
```

`output_ref` points to captured bytes rather than inlining them, so large output does not bloat the record. See `05-search-and-data-model.md` for storage and `02-rendering-two-path.md` for how state drives rendering.

## OSC 133 markers

We use the standard semantic prompt sequences, the same ones iTerm2, Warp, and Ghostty use:

- `OSC 133 ; A ST` prompt start
- `OSC 133 ; B ST` prompt end (command input begins)
- `OSC 133 ; C ST` command output begins (preexec)
- `OSC 133 ; D ; <exit> ST` command finished, with exit code

From these the backend bounds each command, captures the output region between C and D, and reads the exit code from D. The cwd, git branch, and argv come from the shell integration script (below) reporting them, typically via additional OSC sequences carrying key-value data.

## Shell integration scripts

Shax ships integration snippets for zsh, bash, and fish that emit the markers:

- zsh: `precmd` emits A and B and reports cwd and git branch; `preexec` emits C with the command line; the exit hook emits D with `$?`.
- bash: the equivalent using `PROMPT_COMMAND` plus the `DEBUG` trap, or `bash-preexec` if present.
- fish: `fish_prompt`, `fish_preexec`, and `fish_postexec` functions.

The scripts must be idempotent and safe to source twice, must not clobber a user's existing hooks (chain, do not overwrite), and must degrade to a plain terminal if Shax is not the host. Installation is offered on first run and documented; the scripts live with the app and are sourced from the user's shell rc.

## Alternate screen

Independently of OSC 133, the backend watches for `?1049h` and `?1049l` to know when a program has taken the alternate screen, so the frontend stays in raw passthrough for that pane. See `02`.

## States

- **Running:** between C and D. The frontend streams output into the block; no formatting yet.
- **Completed:** D received. Now eligible for the rendering ladder.
- **Collapsed:** user-collapsed; output hidden, header and status shown.

## Per-pane capture

Because the hooks run per shell, every block carries its `pane_id` and `session_id`. This is what lets search say "the kubectl you ran in the staging pane," and it is what keeps multiplexed sessions distinct.

## Edge cases to handle and test

- Commands that never emit D (killed shell, crash): mark the block aborted after the shell dies; do not leave it Running forever.
- Multi-line and multi-statement command lines.
- Commands that flip to the alternate screen mid-run, then exit: stay raw, do not retroactively format.
- A user who has not installed shell integration: fall back to a degraded mode where blocks are best-effort, and prompt to install integration.
