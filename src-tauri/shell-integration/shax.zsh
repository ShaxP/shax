# Shax OSC 133 semantic prompt integration for zsh.
# Idempotent: sourcing twice is a no-op.
[[ -n "$SHAX_SHELL_INTEGRATION_LOADED" ]] && return
SHAX_SHELL_INTEGRATION_LOADED=1

_shax_osc() { printf '\033]133;%s\007' "$1" }

_shax_precmd() {
  local _shax_last_exit=$?
  _shax_osc "D;$_shax_last_exit"
  _shax_osc "A"
}

_shax_preexec() {
  _shax_osc "C"
}

autoload -Uz add-zsh-hook 2>/dev/null
add-zsh-hook precmd _shax_precmd
add-zsh-hook preexec _shax_preexec

# Append B emission at the end of the prompt. %{...%} tells zsh this output
# occupies zero columns so the cursor math stays correct.
PS1="${PS1}%{$(printf '\033]133;B\007')%}"
