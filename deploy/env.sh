# Sourced by the launchd jobs. launchd starts a login shell that never reads ~/.zshrc, so nvm and
# Homebrew are not on PATH by default. Keep this file free of anything interactive.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
