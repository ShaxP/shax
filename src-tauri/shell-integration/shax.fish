# Shax OSC 133 semantic-prompt integration for fish.
#
# Idempotent: sourcing twice is a no-op. Uses fish event handlers so we layer
# on top of whatever the user's prompt/preexec/postexec already do —
# fish_preexec and fish_postexec events fire all registered handlers.
if set -q SHAX_SHELL_INTEGRATION_LOADED
  return
end
set -gx SHAX_SHELL_INTEGRATION_LOADED 1

# Base64-encode a value for safe transport as an OSC param.
function _shax_b64
  printf '%s' "$argv" | base64 | tr -d '\n'
end

function _shax_emit_a
  set -l cwd_b64 (_shax_b64 "$PWD")
  set -l branch ''
  if type -q git
    set branch (command git symbolic-ref --short HEAD 2>/dev/null)
  end
  set -l branch_b64 (_shax_b64 "$branch")
  printf '\e]133;A;cwd=%s;branch=%s\a' $cwd_b64 $branch_b64
  printf '\e]133;B\a'
end

function _shax_preexec --on-event fish_preexec
  # Emit A right before C so the new block inherits the post-cd cwd from the
  # previous command. argv on fish_preexec is the command line as typed.
  # Base64 the command so multi-line values (unclosed strings, `\`-continued
  # lines) survive OSC transport — vte's OSC parser silently drops C0
  # control bytes inside OSC strings, which would otherwise flatten a
  # multi-line command to one mashed-together line.
  _shax_emit_a
  set -l cmd_b64 (_shax_b64 "$argv")
  printf '\e]133;C;cmd=%s\a' $cmd_b64
end

function _shax_postexec --on-event fish_postexec
  set -l last_exit $status
  set -l cwd_b64 (_shax_b64 "$PWD")
  set -l branch ''
  if type -q git
    set branch (command git symbolic-ref --short HEAD 2>/dev/null)
  end
  set -l branch_b64 (_shax_b64 "$branch")
  printf '\e]133;D;%s;cwd=%s;branch=%s\a' $last_exit $cwd_b64 $branch_b64
end

# Emit the first A/B at shell startup so the very first command's block
# inherits cwd before any postexec has fired.
_shax_emit_a
