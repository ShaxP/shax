# Shax OSC 133 semantic prompt integration for zsh.
# Idempotent: sourcing twice is a no-op.
[[ -n "$SHAX_SHELL_INTEGRATION_LOADED" ]] && return
SHAX_SHELL_INTEGRATION_LOADED=1

_shax_osc() { printf '\033]133;%s\007' "$1" }

# Base64-encode an arbitrary string for safe transport as an OSC 133;A param.
# Values may contain `;`, `=`, or non-ASCII — we don't want the receiver to
# split them — so we always encode. `tr -d '\n'` strips the wrap that some
# `base64` builds insert.
_shax_b64() { printf '%s' "$1" | base64 | tr -d '\n' }

# Emit D (previous exit), A (prompt start with cwd + branch), B (command
# input start) in precmd.
#
# We emit B here (not via a PS1 append) because themes like oh-my-zsh and
# powerlevel10k rebuild PROMPT on every precmd, which would drop a PS1-appended
# escape. For our block state machine the precise placement of B is not
# important — only C and D are consumed.
_shax_precmd() {
  # Capture $? before any subsequent command can stomp on it.
  local _shax_last_exit=$?
  # Capture cwd + branch first so we can attach them to BOTH the just-closed
  # block (via OSC 133 D extended params) and the upcoming prompt (via A).
  # Attaching to D is what lets `cd X && ls` show X — the directory the
  # command ended in — rather than the previous prompt's directory.
  local _shax_cwd_b64
  _shax_cwd_b64="$(_shax_b64 "$PWD")"
  local _shax_branch=""
  # `command git` skips any user alias; `2>/dev/null` swallows the "not a git
  # repo" error. Empty string when not in a repo or git is missing.
  if command -v git >/dev/null 2>&1; then
    _shax_branch="$(command git symbolic-ref --short HEAD 2>/dev/null)"
  fi
  local _shax_branch_b64
  _shax_branch_b64="$(_shax_b64 "$_shax_branch")"
  printf '\033]133;D;%s;cwd=%s;branch=%s\007' \
    "$_shax_last_exit" "$_shax_cwd_b64" "$_shax_branch_b64"
  printf '\033]133;A;cwd=%s;branch=%s\007' "$_shax_cwd_b64" "$_shax_branch_b64"
  _shax_osc "B"
}

_shax_preexec() {
  # $1 is the command line as typed (preexec convention). We emit it as a
  # third OSC 133;C parameter so the backend can attach it to the block. The
  # OSC 133 spec lets parsers ignore unknown trailing params, so this stays
  # compatible with consumers that only understand bare `C`.
  printf '\033]133;C;%s\007' "$1"
}

autoload -Uz add-zsh-hook 2>/dev/null
add-zsh-hook precmd _shax_precmd
add-zsh-hook preexec _shax_preexec
