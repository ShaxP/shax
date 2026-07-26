# The safety gate

Every shell command that reaches a Shax pane goes through the safety gate before running — whether a user typed it, a widget emitted it (`git status → Restore`), a community palette command returned it (`docs/community-commands.md`), or the assistant proposed it. The gate is the single choke point where "action" turns into "PTY input", and it's un-bypassable by design: that's the fidelity contract from `CLAUDE.md`.

This doc is a reference for extension authors — formatter and command alike — so you can predict what the user will see when your code emits a command. For the internals, see `specs/10-safety-and-permissions.md`. The classifier is `src/safetyGate/policy.ts`; if this doc drifts, that file is the source of truth.

## The three classifications

Every proposed command gets classified as `routine`, `destructive`, or `ai`. The classification drives the gate's UI: silent forward, modal, or *red* modal.

| Class | UI | Triggered by |
|---|---|---|
| `routine` | Silent forward. The command lands in the prompt and runs. | Source is `widget` and the command doesn't match a destructive pattern. Widgets are user-initiated by design; the gate isn't a second confirmation on a click the user already made. |
| `ai` | Modal, neutral styling. `Enter` approves, `Esc` declines. | Source is `palette` or `ai` and the command doesn't match a destructive pattern. Community commands and the assistant always show a modal so the user sees what's about to run. |
| `destructive` | Modal, **red** styling, `Destructive: <reason>` headline. `Enter` approves, `Esc` declines. | The command matches any destructive pattern below, **regardless of source**. A destructive widget emit still gets the red modal; the pattern match wins over the source. |

Precedence: destructive pattern match first, then source. So a widget that emits `rm -rf ./dist` still gets the red gate, even though widget emits are otherwise routine.

## The destructive pattern list

Pulled from `src/safetyGate/policy.ts:122-157`. Order matters — first match wins, so more specific patterns sit above their catch-alls.

| Pattern intent | Reason string | Example that trips it |
|---|---|---|
| `rm -rf` in any flag order, near `/`, `$HOME`, or `~` | `recursive delete near / or $HOME` | `rm -rf /`, `sudo rm -rf $HOME/logs` |
| `rm -rf` with a wildcard | `wildcard force delete` | `rm -rf *` |
| `rm -rf` anywhere else | `recursive force delete` | `rm -rvf ./dist`, `rm --recursive --force /tmp/x` |
| `git push` with `--force`, `--force-with-lease`, or `-f` | `force push` | `git push --force origin main` |
| `git reset` or `git rebase` with `--hard` | `hard reset / rebase — irrecoverable local changes` | `git reset --hard HEAD~1` |
| `git filter-branch` | `history rewrite` | `git filter-branch --tree-filter '...' HEAD` |
| `git filter-repo` | `history rewrite` | `git filter-repo --path secrets --invert-paths` |
| `git clean` with `-f` (and often `-d`) | `untracked-file clean` | `git clean -fd`, `git clean -xdf` |
| `git checkout .` (or `-- .`) | `discard all local changes` | `git checkout .`, `git checkout -- .` |
| `shutdown` / `reboot` / `halt` / `poweroff` (with or without `sudo`) | `system shutdown` | `shutdown -h now`, `sudo reboot` |
| `dd` (with or without `sudo`) | `raw disk write` | `dd if=/dev/zero of=/dev/sda` |
| `mkfs.*` (with or without `sudo`) | `format filesystem` | `sudo mkfs.ext4 /dev/sdb1` |
| `curl` or `wget` piped into `sh` / `bash` / `zsh` (with or without `sudo`) | `piping remote script to a shell` | `curl https://example.com/x \| sh` |
| `sudo -s` | `root shell` | `sudo -s` |
| `sudo su` | `root shell` | `sudo su -` |

The classifier is intentionally over-cautious. Regex intent is captured above — the actual patterns tolerate `sudo` prefixes, `git -C <path>` and `git -c key=val` prefixes, and every reasonable ordering of clustered flags (`-rf`, `-vrf`, `-rvf`, `-r -f`, `--recursive --force`). False positives cost the user one `Enter` press; false negatives are how you delete a hard drive.

## What this means for extension authors

- **You're free to offer destructive actions.** A `git-history-rewrite` community command is fine; the user just sees the red gate before it runs. That's the point of the gate, not a limitation.
- **Don't try to camouflage destructive commands to slip past the classifier.** Building a string that evaluates to `rm -rf /` at runtime through shell expansion is a bug in your add-on, not a feature — the gate sees the literal string you emitted, so evasion also means the user can't audit what's about to happen. Emit the real command; let the gate flag it.
- **The gate cannot be turned off from inside a sandbox.** There's no `permissions` flag, `bypassGate: true` field, or hidden API. The single-choke-point property is the fidelity contract.
- **The gate only sees emitted commands.** Rendered content (formatter output, panel schemas, list-picker values) doesn't pass through the classifier — only the string returned from `buildCommand` or emitted by a widget. So a formatter can render a URL without triggering anything; the user has to actually run a command to reach the gate.

## Related

- `specs/10-safety-and-permissions.md` — internal design of the gate, approval flow, and rejection UX.
- `docs/community-commands.md` — how to emit commands from a community palette add-on.
- `docs/community-formatters.md` — the render-only sandbox that never reaches the gate.
