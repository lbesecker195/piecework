#!/bin/zsh
# Install (or remove) the two launchd agents on this Mac. Run as the user who will stay logged in.
#   deploy/install.sh              install/refresh both agents (ops pass every 10 minutes)
#   deploy/install.sh --interval 300
#   deploy/install.sh --remove
#   deploy/install.sh --dry-run    render the plists to a temp dir and lint them; touch nothing
set -euo pipefail
REPO="${0:A:h:h}"
INTERVAL=600; MODE=install; OUT="$HOME/Library/LaunchAgents"
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2;;
    --remove) MODE=remove; shift;;
    --dry-run) MODE=dry; OUT="$(mktemp -d)"; shift;;
    *) echo "unknown option $1"; exit 2;;
  esac
done
LABELS=(com.piecework.server com.piecework.ops)

if [ "$MODE" = remove ]; then
  for label in $LABELS; do launchctl bootout "gui/$UID/$label" 2>/dev/null || true; rm -f "$OUT/$label.plist"; done
  echo "removed"; exit 0
fi

mkdir -p "$OUT" "$REPO/data/logs"
for label in $LABELS; do
  sed -e "s|__REPO__|$REPO|g" -e "s|__INTERVAL__|$INTERVAL|g" "$REPO/deploy/$label.plist" > "$OUT/$label.plist"
  plutil -lint "$OUT/$label.plist"
done
chmod +x "$REPO/deploy/ops-pass.sh"

if [ "$MODE" = dry ]; then echo "rendered to $OUT (nothing installed)"; exit 0; fi

for cmd in node gh claude; do command -v "$cmd" >/dev/null || { echo "missing: $cmd (see deploy/README.md)"; exit 1; }; done
[ -f "$REPO/.env" ] || echo "note: no .env in $REPO; server runs in test mode on port 4020"
for label in $LABELS; do
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$OUT/$label.plist"
done
launchctl kickstart -k "gui/$UID/com.piecework.server"
echo "installed. logs: $REPO/data/logs/  status: launchctl list | grep piecework"
