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

# M12.4 language detection — same file-signature check as shax.zsh /
# shax.bash, ported to fish. First hit wins; empty return = no language
# detected. See specs/18-prompt-overhaul.md for the full table.
function _shax_detect_lang
  set -l p $PWD
  if test -e "$p/Cargo.toml"
    echo -n rust; return
  end
  if test -e "$p/Package.swift"
    echo -n swift; return
  end
  # `count $p/*.xcodeproj` yields 0 when the glob doesn't match (fish's
  # default when no files match a glob passed to a command).
  if count $p/*.xcodeproj >/dev/null 2>&1
    if count $p/*.xcodeproj >/dev/null
      echo -n swift; return
    end
  end
  if test -e "$p/deno.json" -o -e "$p/deno.jsonc"
    echo -n deno; return
  end
  if test -e "$p/tsconfig.json"
    echo -n typescript; return
  end
  if test -e "$p/package.json"
    echo -n node; return
  end
  if test -e "$p/pyproject.toml" -o -e "$p/requirements.txt" -o -e "$p/setup.py"
    echo -n python; return
  end
  if test -e "$p/go.mod"
    echo -n go; return
  end
  if test -e "$p/Gemfile"
    echo -n ruby; return
  end
  if test -e "$p/build.gradle.kts" -o -e "$p/settings.gradle.kts"
    echo -n kotlin; return
  end
  if test -e "$p/pom.xml" -o -e "$p/build.gradle"
    echo -n java; return
  end
  if count $p/*.csproj >/dev/null 2>&1; or test -e "$p/global.json"
    if count $p/*.csproj >/dev/null
      echo -n csharp; return
    end
    if test -e "$p/global.json"
      echo -n csharp; return
    end
  end
  if test -e "$p/CMakeLists.txt" -o -e "$p/meson.build" -o -e "$p/configure.ac"
    echo -n c-cpp; return
  end
end

# M12.4 session-constant identity — computed once at shim source time.
set -g _shax_user_b64 (_shax_b64 (whoami 2>/dev/null))
set -g _shax_host_b64 (_shax_b64 (hostname -s 2>/dev/null))

function _shax_emit_a
  set -l cwd_b64 (_shax_b64 "$PWD")
  set -l branch ''
  set -l ahead ''
  set -l behind ''
  if type -q git
    set branch (command git symbolic-ref --short HEAD 2>/dev/null)
    # ahead/behind vs upstream — mirrors shax.zsh's logic.
    set -l counts (command git rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null)
    if test -n "$counts"
      # `git rev-list --left-right --count` outputs one line with a tab
      # separator: "<ahead>\t<behind>".
      set -l parts (string split \t -- $counts)
      set ahead $parts[1]
      set behind $parts[2]
      if test "$ahead" = "0" -a "$behind" = "0"
        set ahead ''
        set behind ''
      end
    end
  end
  set -l branch_b64 (_shax_b64 "$branch")
  set -l lang_b64 (_shax_b64 (_shax_detect_lang))
  printf '\e]133;A;cwd=%s;branch=%s;ahead=%s;behind=%s;lang=%s;user=%s;host=%s\a' \
    $cwd_b64 $branch_b64 $ahead $behind $lang_b64 $_shax_user_b64 $_shax_host_b64
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
