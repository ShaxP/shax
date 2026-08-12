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

# M12.4 language detection — same file-signature check as shax.zsh,
# ported to bash. Uses `[[ -e ]]` for single files and a loop with
# `compgen -G` for the two glob checks (`*.csproj`, `*.xcodeproj`)
# because bash's null-glob is a shopt not a per-command flag. First
# hit wins; empty return = no language detected.
_shax_detect_lang() {
  local _p="$PWD"
  [[ -e "$_p/Cargo.toml" ]] && { printf 'rust'; return; }
  [[ -e "$_p/Package.swift" ]] && { printf 'swift'; return; }
  if compgen -G "$_p/*.xcodeproj" >/dev/null 2>&1 ||
     compgen -G "$_p/*.xcworkspace" >/dev/null 2>&1; then
    printf 'swift'; return
  fi
  [[ -e "$_p/deno.json" || -e "$_p/deno.jsonc" ]] && { printf 'deno'; return; }
  [[ -e "$_p/tsconfig.json" ]] && { printf 'typescript'; return; }
  [[ -e "$_p/package.json" ]] && { printf 'node'; return; }
  [[ -e "$_p/pyproject.toml" || -e "$_p/requirements.txt" || -e "$_p/setup.py" ]] &&
    { printf 'python'; return; }
  [[ -e "$_p/go.mod" ]] && { printf 'go'; return; }
  [[ -e "$_p/Gemfile" ]] && { printf 'ruby'; return; }
  [[ -e "$_p/build.gradle.kts" || -e "$_p/settings.gradle.kts" ]] &&
    { printf 'kotlin'; return; }
  [[ -e "$_p/pom.xml" || -e "$_p/build.gradle" ]] && { printf 'java'; return; }
  if compgen -G "$_p/*.csproj" >/dev/null 2>&1 || [[ -e "$_p/global.json" ]]; then
    printf 'csharp'; return
  fi
  [[ -e "$_p/CMakeLists.txt" || -e "$_p/meson.build" || -e "$_p/configure.ac" ]] &&
    { printf 'c-cpp'; return; }
}

_shax_emit_d_and_a() {
  local _shax_last_exit=$1
  local _shax_cwd_b64
  _shax_cwd_b64="$(_shax_b64 "$PWD")"
  local _shax_branch=""
  local _shax_ahead="" _shax_behind=""
  if command -v git >/dev/null 2>&1; then
    _shax_branch="$(command git symbolic-ref --short HEAD 2>/dev/null)"
    # ahead/behind vs upstream — see shax.zsh for the full explanation
    # of the git rev-list left-right convention.
    local _shax_counts
    _shax_counts="$(command git rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null)"
    if [[ -n "$_shax_counts" ]]; then
      _shax_ahead="${_shax_counts%%$'\t'*}"
      _shax_behind="${_shax_counts##*$'\t'}"
      if [[ "$_shax_ahead" == "0" && "$_shax_behind" == "0" ]]; then
        _shax_ahead=""
        _shax_behind=""
      fi
    fi
  fi
  local _shax_branch_b64
  _shax_branch_b64="$(_shax_b64 "$_shax_branch")"
  local _shax_lang_b64
  _shax_lang_b64="$(_shax_b64 "$(_shax_detect_lang)")"
  printf '\033]133;D;%s;cwd=%s;branch=%s\007' \
    "$_shax_last_exit" "$_shax_cwd_b64" "$_shax_branch_b64"
  printf '\033]133;A;cwd=%s;branch=%s;ahead=%s;behind=%s;lang=%s;user=%s;host=%s\007' \
    "$_shax_cwd_b64" "$_shax_branch_b64" \
    "$_shax_ahead" "$_shax_behind" \
    "$_shax_lang_b64" \
    "$_shax_user_b64" "$_shax_host_b64"
  printf '\033]133;B\007'
}

# M12.4 session-constant identity — computed once at shim source time.
_shax_user_b64="$(_shax_b64 "$(whoami 2>/dev/null)")"
_shax_host_b64="$(_shax_b64 "$(hostname -s 2>/dev/null)")"

# State machine for the DEBUG trap. The trap fires for every simple command
# bash executes — including the body of PROMPT_COMMAND itself, completion
# helpers, etc. We only want to emit OSC 133 C *once* per user-typed
# command, between the prompt being shown and the command starting. The
# common pattern (used by bash-preexec): track whether we're "inside a
# command yet" and flip the flag when the first real DEBUG fires.
_shax_in_command=0

_shax_precmd() {
  # Exit code of the last user command, captured by our PROMPT_COMMAND
  # wrapper before any of our own commands could stomp on $?. Required
  # (positional) so we always emit the right value on OSC 133 D.
  local _shax_last_exit="$1"
  # Only emit D for a block that was actually open. On shell startup, the
  # very first precmd runs with no preceding C — skip the D in that case so
  # we don't synthesise a phantom block.
  if [[ "$_shax_in_command" -eq 1 ]]; then
    _shax_emit_d_and_a "$_shax_last_exit"
  else
    # First prompt of the shell: emit A + B (no D — there's no previous
    # block to close). Same params as _shax_emit_d_and_a's A branch so
    # the frontend gets user/host/lang/etc. from the very first prompt.
    local _shax_cwd_b64
    _shax_cwd_b64="$(_shax_b64 "$PWD")"
    local _shax_branch=""
    local _shax_ahead="" _shax_behind=""
    if command -v git >/dev/null 2>&1; then
      _shax_branch="$(command git symbolic-ref --short HEAD 2>/dev/null)"
      local _shax_counts
      _shax_counts="$(command git rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null)"
      if [[ -n "$_shax_counts" ]]; then
        _shax_ahead="${_shax_counts%%$'\t'*}"
        _shax_behind="${_shax_counts##*$'\t'}"
        if [[ "$_shax_ahead" == "0" && "$_shax_behind" == "0" ]]; then
          _shax_ahead=""
          _shax_behind=""
        fi
      fi
    fi
    local _shax_branch_b64
    _shax_branch_b64="$(_shax_b64 "$_shax_branch")"
    local _shax_lang_b64
    _shax_lang_b64="$(_shax_b64 "$(_shax_detect_lang)")"
    printf '\033]133;A;cwd=%s;branch=%s;ahead=%s;behind=%s;lang=%s;user=%s;host=%s\007' \
      "$_shax_cwd_b64" "$_shax_branch_b64" \
      "$_shax_ahead" "$_shax_behind" \
      "$_shax_lang_b64" \
      "$_shax_user_b64" "$_shax_host_b64"
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
  # Skip anything that runs (directly or transitively) inside our
  # PROMPT_COMMAND wrapper. This catches every phantom-block source
  # in one rule:
  #   - our own _shax_precmd body,
  #   - Fedora / distro PROMPT_COMMAND helpers (e.g. `__vte_prompt_command`
  #     whose body runs `printf "\033]0;%s@%s:%s\007" …` to set the title —
  #     the bug this guard exists for),
  #   - any user-added chpwd/precmd/statusline hook.
  # bash's FUNCNAME array exposes the live call stack when DEBUG fires;
  # the wrapper is on it whenever we're inside PROMPT_COMMAND execution,
  # at any nesting depth. The older `case ";$PROMPT_COMMAND;"` guard only
  # matched top-level entries and missed nested printfs — that's what
  # opened the never-closing phantom block on Fedora.
  local _f
  for _f in "${FUNCNAME[@]}"; do
    if [[ "$_f" == "_shax_prompt_command_wrapper" ]]; then
      return
    fi
  done
  local _cmd="$BASH_COMMAND"
  # Skip our own helpers explicitly — the wrapper name catches nested
  # invocations, but the wrapper itself is called by bash *before* it
  # appears in FUNCNAME (DEBUG fires for the function name as bash is
  # about to invoke it). Ditto for the standalone helpers if they ever
  # get called from a non-wrapper context.
  case "$_cmd" in
    _shax_prompt_command_wrapper|_shax_precmd|_shax_preexec) return ;;
    _shax_emit_d_and_a|_shax_b64|_shax_detect_lang) return ;;
  esac
  _shax_in_command=1
  # Base64 the command so multi-line values survive OSC transport
  # (vte's OSC parser drops C0 control bytes inside strings, so a raw
  # multi-line here-doc would arrive at the backend with its LFs
  # stripped). Same encoding as the cwd/branch params on A/D.
  printf '\033]133;C;cmd=%s\007' "$(_shax_b64 "$_cmd")"
}

# Single-entry PROMPT_COMMAND wrapper. Bash calls this once per prompt
# cycle; we then invoke our precmd, then eval whatever the user/distro
# had in PROMPT_COMMAND before we chained in. Wrapping everything under
# one function name is what lets `_shax_preexec` recognise "I'm inside
# PROMPT_COMMAND" via FUNCNAME (see the loop above).
_shax_prompt_command_wrapper() {
  # Must be the very first line: preserves the exit code of the last
  # user command so we can hand it to _shax_precmd for OSC 133 D.
  local _shax_last_exit=$?
  _shax_precmd "$_shax_last_exit"
  # Run the previously-installed PROMPT_COMMAND (empty on a bare shell,
  # populated on Fedora / distros with a title-setting helper). We use
  # `eval` because the string can be any bash compound command.
  if [[ -n "$_shax_previous_prompt_command" ]]; then
    eval "$_shax_previous_prompt_command"
  fi
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

# Chain into PROMPT_COMMAND via a single-function wrapper. The wrapper
# stores whatever the user / distro had in PROMPT_COMMAND into
# `_shax_previous_prompt_command` and reinstalls PROMPT_COMMAND as just
# our wrapper name. That gives us two things at once:
#
#   1. We can find "am I inside PROMPT_COMMAND right now?" by scanning
#      FUNCNAME for the wrapper — this catches nested printfs / helpers
#      like Fedora's `__vte_prompt_command` body that the older
#      semicolon-split PROMPT_COMMAND string match missed.
#   2. Same ordering guarantee as before: our precmd runs first, then
#      the user's / distro's stuff.
#
# PROMPT_COMMAND can be a scalar string (any bash version) or an array
# of separate commands (bash 5.1+). Handle both by joining any array
# with `; ` before stashing as a scalar to feed `eval` in the wrapper.
if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then
  _shax_previous_prompt_command="$(printf '%s; ' "${PROMPT_COMMAND[@]}")"
else
  _shax_previous_prompt_command="$PROMPT_COMMAND"
fi
PROMPT_COMMAND='_shax_prompt_command_wrapper'
trap '_shax_preexec' DEBUG
