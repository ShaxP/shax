# 10 Safety and permissions

The moment widgets and the assistant can run commands, safety becomes a core feature, not a nag. This is a trust contract.

## The approval gate

Every side-effectful command, whether initiated by an interactive widget (`08`), the assistant (`09`), or the pane command palette (`14`), passes through one gate before it runs. The gate:

- shows the exact command that will run,
- shows what it will affect (the cwd, the files or refs touched, the pane),
- offers approve or decline,
- and runs the command visibly in the prompt only after approval.

This is wired through the Agent SDK `canUseTool` callback for assistant actions and through the same policy for widget actions, so there is a single chokepoint.

### Where the gate renders

The gate is source-aware — the *policy* is one, the *rendering surface* is chosen to match the source:

- **Widget or palette** proposals render a modal. Those surfaces have no in-flow home for an approval control, and their user is looking at the terminal, not a chat.
- **Assistant** proposals render inline as the APPROVAL REQUIRED card in the conversation. Approve and Decline live on the card. The safety policy and chokepoint are unchanged — only the rendering surface differs.

The single-chokepoint property still holds: every command flows through the same classification and the same approve / decline exit, regardless of where the buttons are drawn.

## What counts as side-effectful

Anything that changes state outside reading: writes, deletes, moves, `git add` and `git checkout` and `git push`, package installs, `cd` (state change, low risk, but still a visible command), network mutations, and anything the assistant proposes in goal mode. Pure reads (an `ls` probe, a `git status` probe, a `git diff`) do not need approval.

## Destructive-pattern detection

The policy flags and requires explicit, deliberate confirmation for dangerous patterns: recursive deletes, `rm -rf` near `/` or `$HOME`, force-push, history rewrites, and commands run in a production context. These get a stronger confirmation than routine actions, with the danger called out plainly.

## Dry-run and explain-before-execute

Where a command supports it, offer a dry-run or an explanation of what it will do before running. The default posture is explain-then-confirm, not run-then-apologize.

## The visible-command principle is part of safety

Because every action becomes a real command in the prompt, there is never a hidden mutation to audit. The log is the audit trail. Do not add any path that mutates state without leaving a visible command.

## Formatter and pane-command sandbox

Community formatters (`07`) and community pane commands (`14`) both run in a worker sandbox with a restricted API and no ambient filesystem or network access. The two share the same trust model: the only way an extension can "do" anything is to *propose* a rendered view (formatters) or a shell command string (commands) that the user sees before it acts. This is a security boundary; treat a bypass as a vulnerability.

## Privacy and local-first

- No account required to use the terminal.
- History lives on the user's machine. No telemetry without explicit opt-in.
- Never handle, store, or log Claude credentials (`09`).
- Filter secrets out of any context handed to a formatter or the assistant (environment variables, tokens).

## Do not weaken any of this

Agents and contributors must not relax the gate, the sandbox, or the credential rule to make a feature easier. If a feature seems to require it, that is a design problem to escalate, not a rule to bend.
