# termigo-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _termigo_user_zdotdir="${TERMIGO_USER_ZDOTDIR:-$HOME}"
  [ -f "$_termigo_user_zdotdir/.zprofile" ] && source "$_termigo_user_zdotdir/.zprofile"
  unset _termigo_user_zdotdir
}
:
