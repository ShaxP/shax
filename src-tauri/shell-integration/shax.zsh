# Shax OSC 133 semantic prompt integration for zsh.
# Idempotent: sourcing twice is a no-op.
[[ -n "$SHAX_SHELL_INTEGRATION_LOADED" ]] && return
SHAX_SHELL_INTEGRATION_LOADED=1

_shax_osc() { printf '\033]133;%s\007' "$1" }

# Emit D (previous exit), A (prompt start), B (command input start) in precmd.
# We emit B here (not via a PS1 append) because themes like oh-my-zsh and
# powerlevel10k rebuild PROMPT on every precmd, which would drop a PS1-appended
# escape. For our block state machine the precise placement of B is not
# important — only C and D are consumed.
_shax_precmd() {
  local _shax_last_exit=$?
  _shax_osc "D;$_shax_last_exit"
  _shax_osc "A"
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
