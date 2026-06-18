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
  printf '\033]133;C;%s\007' "$_cmd"
}

# Chain into PROMPT_COMMAND without clobbering anything the user already has.
# The `${PROMPT_COMMAND:+; $PROMPT_COMMAND}` form is a no-op when PROMPT_COMMAND
# is unset, otherwise prepends our hook with a `;` separator.
PROMPT_COMMAND="_shax_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
trap '_shax_preexec' DEBUG
