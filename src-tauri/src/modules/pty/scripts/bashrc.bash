# termigo-shell-integration (bashrc)
#
# Differences vs zsh integration:
# - We emulate login-shell init manually (/etc/profile, profile files) because
#   bash ignores --rcfile when started with -l.
# - Pre-exec marker uses PS0 (bash 4.4+). On older bash (macOS default 3.2) we
#   skip it — a fragile DEBUG-trap alternative would clobber the user's own
#   traps and interact badly with debuggers.

if [ -z "$__TERMIGO_HOOKS_LOADED" ]; then
  __TERMIGO_HOOKS_LOADED=1

  [ -f /etc/profile ] && source /etc/profile
  [ -f /etc/bashrc ] && source /etc/bashrc
  if [ -f "$HOME/.bash_profile" ]; then
    source "$HOME/.bash_profile"
  elif [ -f "$HOME/.bash_login" ]; then
    source "$HOME/.bash_login"
  elif [ -f "$HOME/.profile" ]; then
    source "$HOME/.profile"
  fi
  # .bashrc may have been sourced already by .bash_profile; sourcing again is
  # safe for idempotent rc files (the common case). If yours has side effects
  # on reload, guard with a flag.
  [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

  if [ -n "$TERMIGO_CLI" ] && [ -x "$TERMIGO_CLI" ]; then
    termigo() {
      command "$TERMIGO_CLI" "$@"
    }
  fi

  _termigo_urlencode() {
    local LC_ALL=C s="$1" i c
    for (( i=0; i<${#s}; i++ )); do
      c="${s:i:1}"
      case "$c" in
        [a-zA-Z0-9/._~-]) printf '%s' "$c" ;;
        *) printf '%%%02X' "'$c" ;;
      esac
    done
  }

  _termigo_precmd() {
    local _termigo_ret=$?
    printf '\e]133;D;%s\e\\' "$_termigo_ret"
    # No tmux DCS wrapping here. Termigo forces TERM=xterm-256color, so tmux
    # passes OSC straight through, and wrapping it in `\ePtmux;...\e\\` made
    # the sequence unreachable: xterm.js has no DCS unwrapper, so the OSC 7
    # never arrived and tab.cwd, the explorer root and the AI's cwd all froze
    # on the launch directory for every pane inside tmux.
    printf '\e]7;file://%s%s\e\\' "${HOSTNAME:-$(uname -n 2>/dev/null)}" "$(_termigo_urlencode "$PWD")"
    if [ -n "$TERMIGO_BLOCKS" ]; then
      # Host renders its own input bar: suppress the shell prompt (B marker
      # only) and reserve header/gap rows, mirroring the zsh integration.
      if [ -n "$_termigo_block_seen" ]; then
        PS1='\n\n\[\e]133;B\e\\\]'
      else
        PS1='\n\[\e]133;B\e\\\]'
      fi
    elif [ -z "$__TERMIGO_PS1_INJECTED" ]; then
      PS1='\[\e]133;B\e\\\]'"$PS1"
      __TERMIGO_PS1_INJECTED=1
    fi
    printf '\e]133;A\e\\'
  }

  # bash 5.1+ allows PROMPT_COMMAND to be an ARRAY, executed element by
  # element. A plain string expansion only ever sees element 0, so prepending
  # as a string dropped every other hook and silently demoted the array to a
  # scalar. Prepend as an element when there is more than one.
  if [ "${#PROMPT_COMMAND[@]}" -gt 1 ]; then
    [ "${PROMPT_COMMAND[0]:-}" = "_termigo_precmd" ] || \
      PROMPT_COMMAND=(_termigo_precmd "${PROMPT_COMMAND[@]}")
  else
    case ":${PROMPT_COMMAND:-}:" in
      *":_termigo_precmd:"*) ;;
      *) PROMPT_COMMAND="_termigo_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
    esac
  fi

  # Pre-exec marker via PS0 (bash 4.4+). PS0 is expanded just before a command
  # runs — cleaner than a DEBUG trap, which would clobber user traps and fire
  # on every command including inside PROMPT_COMMAND.
  if [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] \
     || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; }; then
    if [ -n "$TERMIGO_BLOCKS" ]; then
      # PS0 only expands, never executes: the arithmetic inside the array
      # subscript sets the seen flag while the unset array expands to nothing.
      PS0='\[\e]133;C\e\\\]${_termigo_noop[$((_termigo_block_seen=1))]}'"${PS0:-}"
    else
      PS0='\[\e]133;C\e\\\]'"${PS0:-}"
    fi
  fi

  _termigo_precmd
fi
:
