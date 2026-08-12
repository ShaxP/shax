# Shax OSC 133 semantic prompt integration for zsh.
# Idempotent: sourcing twice is a no-op.
[[ -n "$SHAX_SHELL_INTEGRATION_LOADED" ]] && return
SHAX_SHELL_INTEGRATION_LOADED=1

# ── OSC 133 emitters + hooks (unchanged from pre-M12.2) ────────────────────

_shax_osc() { printf '\033]133;%s\007' "$1" }

# Base64-encode an arbitrary string for safe transport as an OSC 133;A param.
# Values may contain `;`, `=`, or non-ASCII — we don't want the receiver to
# split them — so we always encode. `tr -d '\n'` strips the wrap that some
# `base64` builds insert.
_shax_b64() { printf '%s' "$1" | base64 | tr -d '\n' }

# Emit D (previous exit) and A (prompt start with cwd + branch) in precmd,
# then ensure B (command input start) is appended to PROMPT so it lands at
# the END of PS1 rendering rather than the start.
#
# Why B-in-PROMPT instead of B-in-precmd: M1.9's PromptStrip needs to
# distinguish PS1 rendering from user-typing echo. PS1 bytes arrive between
# OSC 133 A and B; user-typing bytes arrive between B and the next C. If B
# fires in precmd (before zsh prints PROMPT), every byte of PS1 — including
# customisations like clock icons and hostnames — flows into the strip's
# input stream. Appending B to PROMPT makes it the very last thing PS1
# renders, so anything after B is purely the user's typing.
#
# In M12.2's always-assertive mode, PROMPT is reset every precmd to a bare
# B marker so nothing except the marker paints. This append still fires as
# a safety net in case anything else re-appends to PROMPT after our reset.
#
# M12.4: identity is emitted on every A too. `whoami` / `hostname -s`
# don't change during a session (Shax doesn't track sudo / SSH), so we
# compute them once at shim source time (below, near the hooks
# registration) and cache in module-level vars. Cheaper than a fork
# per prompt cycle.
#
# M12.4: git ahead/behind vs upstream and detected primary language
# for the cwd are also part of A. Both are computed on demand each
# precmd — `git rev-list` is fast on small repos and only runs when
# an upstream is set, and language detection is a handful of `[[ -e ]]`
# probes per candidate file.
_shax_precmd() {
  # Capture $? before any subsequent command can stomp on it.
  local _shax_last_exit=$?
  local _shax_cwd_b64
  _shax_cwd_b64="$(_shax_b64 "$PWD")"
  local _shax_branch=""
  local _shax_ahead="" _shax_behind=""
  if command -v git >/dev/null 2>&1; then
    _shax_branch="$(command git symbolic-ref --short HEAD 2>/dev/null)"
    # Ahead/behind vs upstream — only when the current branch has one
    # configured. `git rev-list --left-right --count HEAD...@{u}` yields
    # `<behind>\t<ahead>` on one line. `2>/dev/null` swallows the
    # "no upstream" error so a detached HEAD or fresh branch stays quiet.
    local _shax_counts
    _shax_counts="$(command git rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null)"
    if [[ -n "$_shax_counts" ]]; then
      # Format is "<ahead>\t<behind>" — HEAD is the left side of the
      # `...`, so the LEFT count is commits on our side (ahead), the
      # RIGHT count is commits on their side (behind).
      _shax_ahead="${_shax_counts%%$'\t'*}"
      _shax_behind="${_shax_counts##*$'\t'}"
      # Both zero → suppress both (frontend renders the chip only when
      # at least one is non-zero, and dropping the params keeps the
      # OSC line short).
      if [[ "$_shax_ahead" == "0" && "$_shax_behind" == "0" ]]; then
        _shax_ahead=""
        _shax_behind=""
      fi
    fi
  fi
  local _shax_branch_b64
  _shax_branch_b64="$(_shax_b64 "$_shax_branch")"
  local _shax_lang
  _shax_lang="$(_shax_detect_lang)"
  local _shax_lang_b64
  _shax_lang_b64="$(_shax_b64 "$_shax_lang")"

  # D marks the previous block's finish. Include cwd/branch so it's
  # tagged with the directory the command ENDED in (M9-era behaviour).
  printf '\033]133;D;%s;cwd=%s;branch=%s\007' \
    "$_shax_last_exit" "$_shax_cwd_b64" "$_shax_branch_b64"
  # A marks the new prompt. All the pane-context params live here:
  # cwd, branch, ahead/behind (when non-zero), detected lang, plus
  # the session-constant user/host (already cached below).
  printf '\033]133;A;cwd=%s;branch=%s;ahead=%s;behind=%s;lang=%s;user=%s;host=%s\007' \
    "$_shax_cwd_b64" "$_shax_branch_b64" \
    "$_shax_ahead" "$_shax_behind" \
    "$_shax_lang_b64" \
    "$_shax_user_b64" "$_shax_host_b64"

  if [[ "$PROMPT" != *$'\e]133;B\a'* ]]; then
    PROMPT="${PROMPT}"$'%{\e]133;B\a%}'
  fi
}

# M12.4 language detection. First-hit-wins ordered check against the
# well-known project files listed in specs/18-prompt-overhaul.md. Uses
# `[[ -e ]]` for single files (one `stat` each) and `(N)` glob-null for
# the two pattern checks (`*.csproj`, `*.xcodeproj`), so failure to
# match is a silent no-op — no error message, no path expansion.
#
# Empty return means "no language detected"; the shim then sends
# `lang=` (empty base64) and the frontend renders no icon.
_shax_detect_lang() {
  emulate -L zsh
  setopt local_options null_glob
  local _p="$PWD"
  # Order matters — most-specific first, so tsconfig wins over
  # package.json (typescript beats node) and build.gradle.kts wins
  # over build.gradle (kotlin beats java).
  [[ -e "$_p/Cargo.toml" ]] && { print -- rust; return }
  [[ -e "$_p/Package.swift" ]] && { print -- swift; return }
  local _xcode=("$_p"/*.xcodeproj(N) "$_p"/*.xcworkspace(N))
  (( ${#_xcode} > 0 )) && { print -- swift; return }
  [[ -e "$_p/deno.json" || -e "$_p/deno.jsonc" ]] && { print -- deno; return }
  [[ -e "$_p/tsconfig.json" ]] && { print -- typescript; return }
  [[ -e "$_p/package.json" ]] && { print -- node; return }
  [[ -e "$_p/pyproject.toml" || -e "$_p/requirements.txt" || -e "$_p/setup.py" ]] &&
    { print -- python; return }
  [[ -e "$_p/go.mod" ]] && { print -- go; return }
  [[ -e "$_p/Gemfile" ]] && { print -- ruby; return }
  [[ -e "$_p/build.gradle.kts" || -e "$_p/settings.gradle.kts" ]] &&
    { print -- kotlin; return }
  [[ -e "$_p/pom.xml" || -e "$_p/build.gradle" ]] && { print -- java; return }
  local _csproj=("$_p"/*.csproj(N))
  if (( ${#_csproj} > 0 )) || [[ -e "$_p/global.json" ]]; then
    print -- csharp
    return
  fi
  [[ -e "$_p/CMakeLists.txt" || -e "$_p/meson.build" || -e "$_p/configure.ac" ]] &&
    { print -- c-cpp; return }
  print --
}

# M12.4 session-constant identity — computed once, sent on every A.
# `whoami` / `hostname -s` don't change during a session (we don't
# track sudo / SSH), and forking twice per prompt would add ~2ms of
# subshell overhead for no new information.
_shax_user_b64="$(_shax_b64 "$(whoami 2>/dev/null)")"
_shax_host_b64="$(_shax_b64 "$(hostname -s 2>/dev/null)")"

_shax_preexec() {
  # $1 is the command line as typed (preexec convention). Base64 the
  # value so multi-line commands (unclosed-quote continuations, here-
  # docs, `\`-continuations) survive OSC transport — the vte OSC parser
  # silently drops C0 control bytes (LF, CR, etc.) inside OSC strings,
  # so a raw multi-line command arrives at the backend with its LFs
  # stripped and the block header shows a mashed-together single line.
  # The `cmd=<b64>` form uses the same encoding as the cwd/branch
  # params on A/D. Non-Shax OSC 133 receivers ignore unknown keys.
  printf '\033]133;C;cmd=%s\007' "$(_shax_b64 "$1")"
}

autoload -Uz add-zsh-hook 2>/dev/null
add-zsh-hook precmd _shax_precmd
add-zsh-hook preexec _shax_preexec

# ── M12.2 always-assertive hardening (spec §18 D2) ────────────────────────
#
# Runs after the user's rc has been sourced. Three unconditional overrides
# (Shax owns the visible prompt and doesn't let anything paint over it):
#
#   1. PROMPT / RPROMPT reset every prompt to a bare OSC 133 B marker so
#      starship / p10k / any custom PS1 doesn't render into the strip.
#   2. `zsh-syntax-highlighting` no-op'd (function overridden, highlighter
#      list cleared) so it doesn't compete with Shax's M12.5 tokenizer for
#      the character grid.
#   3. Continuation prompts (PROMPT2/3/4) cleared so they don't paint bytes
#      we don't own during multi-line commands.
#
# Then one branched override, driven by `$SHAX_LINE_EDITING` (emacs default,
# vi opt-in): the user's chosen line-editing mode. The undocumented
# `SHAX_DISABLE_HARDENING=1` env var is a safety valve that turns
# everything off if the shim ever misbehaves.
if [[ "$SHAX_DISABLE_HARDENING" != "1" ]]; then
  # Silence zsh-syntax-highlighting if it's installed. We can't safely
  # `unfunction _zsh_highlight` — the plugin hooks multiple ZLE widgets
  # (zle-line-init, zle-line-pre-redraw, etc.) by name and their
  # wrappers call `_zsh_highlight` on every keystroke; removing the
  # function leaves the wrappers erroring. Override with a no-op body
  # and clear the highlighter list so the internal loop has nothing to
  # iterate. The wrappers keep working, they just do nothing visible.
  if (( ${+functions[_zsh_highlight]} )); then
    _zsh_highlight() { : }
    ZSH_HIGHLIGHT_HIGHLIGHTERS=()
  fi

  # Force PROMPT / RPROMPT to bare markers on every prompt cycle. A
  # one-shot assignment isn't enough: themes like oh-my-zsh and
  # powerlevel10k rebuild PROMPT inside their own precmd hooks, so we
  # need a precmd of our own that runs *after* theirs. add-zsh-hook
  # keeps hooks in registration order, and this hook is registered
  # here (after the user's rc has sourced their theme), so it wins.
  #
  # PROMPT carries only the OSC 133 B marker (precmd above emitted A
  # with cwd + branch); anything after B is user typing. `%{...%}`
  # marks the escape as zero-width so column math stays correct.
  # RPROMPT is cleared so a right-side prompt doesn't compete with
  # Shax's own header row (M12.4). PROMPT2..4 cleared so continuation
  # / select / execution-trace prompts don't paint bytes we don't own.
  _shax_reset_prompt() {
    PROMPT=$'%{\e]133;B\a%}'
    RPROMPT=''
    PROMPT2=''
    PROMPT3=''
    PROMPT4=''
  }
  add-zsh-hook precmd _shax_reset_prompt
  # Also set once at source-time so the very first prompt paints bare
  # even if a race puts a rebuild between the last precmd and PS1
  # rendering.
  _shax_reset_prompt

  # ── Line editing: emacs vs vi ────────────────────────────────────
  #
  # Branches on $SHAX_LINE_EDITING (default "emacs" for a fresh install).
  # Emacs: forced against any plugin that tries to install vi keys.
  # Vi: source Shax's bundled zsh-vi-mode (unless user's rc has already
  # loaded a copy) and register a zle-keymap-select widget that emits
  # OSC 133;M so the statusline can render the two-chip pill.
  if [[ "$SHAX_LINE_EDITING" == "vi" ]]; then
    # Source Shax's bundled zsh-vi-mode v0.12.0 unless the user's rc
    # has already loaded a copy. Function-name check is more reliable
    # than $ZVM_VERSION (older releases don't export it).
    if ! (( ${+functions[zvm_init]} )); then
      if [[ -f "$SHAX_INTEGRATION_DIR/zsh-vi-mode.zsh" ]]; then
        source "$SHAX_INTEGRATION_DIR/zsh-vi-mode.zsh"
      fi
    fi
    # Fallback: source-time `bindkey -v` in case zsh-vi-mode failed to
    # load. Zsh's built-in vi is minimal but functional.
    bindkey -v 2>/dev/null

    # Emit OSC 133;M on every keymap change so the frontend statusline
    # can drive the vi sub-chip (INSERT / NORMAL / VISUAL). We chain
    # onto any existing zle-keymap-select widget so the plugin's setup
    # (cursor shape, etc.) still runs.
    #
    # Caveat this handles: zsh-vi-mode's *visual* mode does NOT change
    # $KEYMAP — the plugin stays in the vicmd keymap and tracks
    # visual state internally via $ZVM_MODE. So zle-keymap-select
    # alone misses visual entry / exit. We register a second signal
    # further down that hooks zvm's own mode-select callback and
    # emits with the resolved zvm mode — that's the one that catches
    # visual reliably. When both fire (mode transitions that cross
    # keymap boundaries too, like normal ↔ insert), the zvm hook
    # fires SECOND, so its emission wins.
    _shax_original_keymap_select="${widgets[zle-keymap-select]#user:}"
    if [[ "$_shax_original_keymap_select" == "$widgets[zle-keymap-select]" ]]; then
      _shax_original_keymap_select=""
    fi
    _shax_emit_keymap() {
      if [[ -n "$_shax_original_keymap_select" ]] &&
         (( ${+functions[$_shax_original_keymap_select]} )); then
        "$_shax_original_keymap_select"
      fi
      printf '\033]133;M;%s\007' "$KEYMAP"
    }
    zle -N zle-keymap-select _shax_emit_keymap

    # zsh-vi-mode integration: hook its `zvm_after_select_vi_mode`
    # callback so visual mode (which the plugin implements without
    # a KEYMAP switch) reaches the frontend. Runs after any keymap
    # signal above, so its emit is what the frontend lands on.
    #
    # The plugin's mode codes are single-letter tokens (`i` insert,
    # `n` normal, `v` visual, `vl` visual-line, `r` replace). Map
    # to the standard zsh keymap names the frontend already
    # understands (viins / vicmd / visual). Visual-line collapses
    # into `visual` — no separate frontend label. Replace falls
    # under `vicmd` (the frontend renders NORMAL).
    if (( ${+zvm_after_select_vi_mode_commands} )); then
      _shax_emit_zvm_mode() {
        case "$ZVM_MODE" in
          "$ZVM_MODE_INSERT") printf '\033]133;M;%s\007' viins ;;
          "$ZVM_MODE_NORMAL") printf '\033]133;M;%s\007' vicmd ;;
          "$ZVM_MODE_VISUAL"|"$ZVM_MODE_VISUAL_LINE") printf '\033]133;M;%s\007' visual ;;
          "$ZVM_MODE_REPLACE") printf '\033]133;M;%s\007' vicmd ;;
        esac
      }
      zvm_after_select_vi_mode_commands+=(_shax_emit_zvm_mode)
    fi

    # Prime the frontend on the very first prompt with the starting
    # keymap so the pill isn't blank until the user first switches
    # modes. `main` maps to viins for vi users.
    _shax_prime_keymap() {
      printf '\033]133;M;%s\007' "${KEYMAP:-main}"
      add-zsh-hook -d precmd _shax_prime_keymap
      unfunction _shax_prime_keymap
    }
    add-zsh-hook precmd _shax_prime_keymap
  else
    # Emacs (default). Defence in depth against deferred-init vi-mode
    # plugins like zsh-vi-mode, which the user might have installed
    # but doesn't want active (Shax preference wins over rc).
    bindkey -e 2>/dev/null

    # Re-force emacs on every prompt cycle. Some plugins do their
    # vi-mode setup deferred inside a precmd hook after the shim's
    # source-time bindkey -e ran. Because our hook was registered
    # last, we run after theirs.
    _shax_reforce_emacs() { bindkey -e 2>/dev/null }
    add-zsh-hook precmd _shax_reforce_emacs

    # Chain a `zle-line-init` widget in front of whatever the user's
    # plugins installed. `zle-line-init` fires when ZLE starts editing
    # a new line — right after precmd, right before the user types —
    # and it's where plugins like zsh-vi-mode install their keymap
    # switch. Running last here lets us undo the plugin's `zle -K viins`
    # style switch and land the editor in the emacs (main) keymap.
    _shax_original_line_init="${widgets[zle-line-init]#user:}"
    if [[ "$_shax_original_line_init" == "$widgets[zle-line-init]" ]]; then
      _shax_original_line_init=""
    fi
    _shax_force_emacs_line_init() {
      if [[ -n "$_shax_original_line_init" ]] &&
         (( ${+functions[$_shax_original_line_init]} )); then
        "$_shax_original_line_init"
      fi
      bindkey -e 2>/dev/null
      zle -K main 2>/dev/null
    }
    zle -N zle-line-init _shax_force_emacs_line_init
  fi
fi
