#!/bin/zsh
# One scheduled pass of the Git Master. Cheap when quiet: checks the queue with a plain script and
# only starts Claude Code when something is waiting. Safe to run from launchd every few minutes.
set -uo pipefail
REPO="${0:A:h:h}"
cd "$REPO" || exit 1
source "$REPO/deploy/env.sh"
mkdir -p data/logs
LOCK="$REPO/data/ops.lock"
if mkdir "$LOCK" 2>/dev/null; then
  echo $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
elif kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) another pass is still running; skipping"; exit 0
else
  rm -rf "$LOCK"; mkdir "$LOCK" && echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT
fi
set -a; [ -f .env ] && source .env; set +a
export PIECEWORK_URL="${PIECEWORK_URL:-http://localhost:${PORT:-4020}}"

PENDING="$(node --disable-warning=ExperimentalWarning tools/ops.js pending 2>&1)" || { echo "$(date -u +%FT%TZ) server unreachable: $PENDING"; exit 0; }
if [ "$PENDING" = "0" ]; then echo "$(date -u +%FT%TZ) quiet"; exit 0; fi

echo "$(date -u +%FT%TZ) $PENDING item(s) waiting; starting a Git Master pass"
claude -p "$(cat deploy/ops-prompt.md)" \
  --output-format text \
  --max-turns "${OPS_MAX_TURNS:-60}" \
  --allowedTools "Skill,Read,Bash(npm run ops:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh api repos/*)" \
  2>&1 | tee -a "data/logs/ops-$(date -u +%F).log"
echo "$(date -u +%FT%TZ) pass finished"
