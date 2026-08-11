# Shax OSC 133 semantic-prompt integration for bash.
#
# Idempotent: sourcing twice is a no-op. Bails out for non-interactive shells
# so scripts and ssh-non-tty invocations stay quiet.
[[ -n "$SHAX_SHELL_INTEGRATION_LOADED" ]] && return
case "$-" in
  *i*) ;;
  *)   return ;;
esac
SHAX_SHELL_INTEGRATION_LOADED=1

# Base64-encode for safe transport as an OSC param. Always emit (even for
# empty values) so the receiver can distinguish "shell uses our extended
# format" from "bare D / older integration".
_shax_b64() { printf '%s' "$1" | base64 | tr -d '\n' ; }

_shax_emit_d_and_a() {
  local _shax_last_exit=$1
  local _shax_cwd_b64
  _shax_cwd_b64="$(_shax_b64 "$PWD")"
  local _shax_branch=""
  if command -v git >/dev/null 2>&1; then
    _shax_branch="$(command git symbolic-ref --short HEAD 2>/dev/null)"
  fi
  local _shax_branch_b64
  _shax_branch_b64="$(_shax_b64 "$_shax_branch")"
  printf '\033]133;D;%s;cwd=%s;branch=%s\007' \
    "$_shax_last_exit" "$_shax_cwd_b64" "$_shax_branch_b64"
  printf '\033]133;A;cwd=%s;branch=%s\007' "$_shax_cwd_b64" "$_shax_branch_b64"
  printf '\033]133;B\007'
}

# State machine for the DEBUG trap. The trap fires for every simple command
# bash executes — including the body of PROMPT_COMMAND itself, completion
# helpers, etc. We only want to emit OSC 133 C *once* per user-typed
# command, between the prompt being shown and the command starting. The
# common pattern (used by bash-preexec): track whether we're "inside a
# command yet" and flip the flag when the first real DEBUG fires.
_shax_in_command=0

_shax_precmd() {
  # Capture the last command's exit before any of our own commands stomp on $?.
  local _shax_last_exit=$?
  # Only emit D for a block that was actually open. On shell startup, the
  # very first precmd runs with no preceding C — skip the D in that case so
  # we don't synthesise a phantom block.
  if [[ "$_shax_in_command" -eq 1 ]]; then
    _shax_emit_d_and_a "$_shax_last_exit"
  else
    # First prompt of the shell: just emit A + B so the next C inherits cwd.
    local _shax_cwd_b64
    _shax_cwd_b64="$(_shax_b64 "$PWD")"
    local _shax_branch=""
    if command -v git >/dev/null 2>&1; then
      _shax_branch="$(command git symbolic-ref --short HEAD 2>/dev/null)"
    fi
    local _shax_branch_b64
    _shax_branch_b64="$(_shax_b64 "$_shax_branch")"
    printf '\033]133;A;cwd=%s;branch=%s\007' "$_shax_cwd_b64" "$_shax_branch_b64"
    printf '\033]133;B\007'
  fi
  _shax_in_command=0
}

# Determines whether the current DEBUG firing represents the user's command
# starting (in which case we emit C) or some internal machinery we should
# ignore (PROMPT_COMMAND body, completion, PS1 command substitutions, our
# own helpers).
_shax_preexec() {
  # Skip when DEBUG fires inside a subshell. PS1 command substitutions
  # (`$(git branch)` etc.), backticks, `(subshell)` groups, and pipeline
  # children all run with BASH_SUBSHELL > 0, and emitting OSC 133 C for
  # them would create phantom blocks and steal output attribution from
  # the real user command that ran them.
  if [[ "$BASH_SUBSHELL" -gt 0 ]]; then return; fi
  # Completion machinery: COMP_LINE is set during programmable completion.
  if [[ -n "$COMP_LINE" ]]; then return; fi
  # Skip if we're already inside a command — DEBUG fires for every simple
  # command in a chain (`a && b`, `c; d`), and we only want the first.
  if [[ "$_shax_in_command" -eq 1 ]]; then return; fi
  # Skip while PROMPT_COMMAND is running: BASH_COMMAND would be our own
  # helper or whatever else the user wired into PROMPT_COMMAND. We detect
  # this by matching BASH_COMMAND against the (semicolon-split) entries of
  # PROMPT_COMMAND. This mirrors bash-preexec's guard.
  local _cmd="$BASH_COMMAND"
  case ";$PROMPT_COMMAND;" in
    *";$_cmd;"*) return ;;
  esac
  # Skip our own helpers explicitly — these can fire as the first DEBUG
  # after a prompt depending on bash version.
  case "$_cmd" in
    _shax_precmd|_shax_preexec|_shax_emit_d_and_a|_shax_b64) return ;;
  esac
  _shax_in_command=1
  # Base64 the command so multi-line values survive OSC transport
  # (vte's OSC parser drops C0 control bytes inside strings, so a raw
  # multi-line here-doc would arrive at the backend with its LFs
  # stripped). Same encoding as the cwd/branch params on A/D.
  printf '\033]133;C;cmd=%s\007' "$(_shax_b64 "$_cmd")"
}

# ── M12.2 always-assertive hardening (spec §18 D2) ────────────────────────
#
# Runs after the user's rc has been sourced. Unconditional: bare PS1 (Shax
# owns the visible prompt), empty PS2 (no lingering continuation prompt
# bytes). Branched on $SHAX_LINE_EDITING: emacs (default) or vi. The
# undocumented `SHAX_DISABLE_HARDENING=1` env var turns everything off if
# the shim ever misbehaves.
#
# bash has no analog to zsh-syntax-highlighting or zsh-vi-mode worth
# handling specially; the line editor is readline in either mode. Vi
# support here is `set -o vi`, which is minimal but functional.
#
# ORDER MATTERS: this block runs BEFORE the DEBUG trap is installed
# below. Bash fires DEBUG for each simple command including assignments
# and `set` builtins, so if we ran PS1='...' / PS2='...' / set -o emacs
# after the trap was in place, `_shax_preexec` would emit a phantom
# OSC 133 C for each, opening a bogus block that ate the shell's
# startup output. Running assertive setup first keeps DEBUG safely
# scoped to user commands.
if [[ "$SHAX_DISABLE_HARDENING" != "1" ]]; then
  # Bare PS1: single OSC 133 B marker. Precmd below already emits A with
  # cwd + branch on every prompt cycle; PS1 carries only B to close the
  # "prompt-rendering" region so anything after it is user typing.
  # Wrapped in \[...\] so readline's column math ignores it.
  PS1='\[\e]133;B\a\]'
  # PS2 (continuation prompt) cleared so a lingering `> ` doesn't paint
  # bytes we don't own during multi-line commands.
  PS2=''

  if [[ "$SHAX_LINE_EDITING" == "vi" ]]; then
    set -o vi 2>/dev/null
  else
    # Emacs (default). Forces emacs even if the user's rc set vi mode.
    set -o emacs 2>/dev/null
  fi
fi

# Chain into PROMPT_COMMAND without clobbering anything the user already has.
# The `${PROMPT_COMMAND:+; $PROMPT_COMMAND}` form is a no-op when PROMPT_COMMAND
# is unset, otherwise prepends our hook with a `;` separator.
PROMPT_COMMAND="_shax_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
trap '_shax_preexec' DEBUG
