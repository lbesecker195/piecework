#!/bin/zsh
# One pass of the house worker. Quiet and free when nothing is assigned; when an assignment exists it
# runs Claude Code headless against the repo for one contract. Safe from launchd every couple of minutes.
set -uo pipefail
REPO="${0:A:h:h}"
cd "$REPO" || exit 1
source "$REPO/deploy/env.sh"
mkdir -p data/logs
LOCK="$REPO/data/worker.lock"
if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT
elif kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then echo "$(date -u +%FT%TZ) worker still busy; skipping"; exit 0
else rm -rf "$LOCK"; mkdir "$LOCK" && echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT; fi
set -a; [ -f .env ] && source .env; set +a
export PIECEWORK_URL="${PIECEWORK_URL:-http://localhost:${PORT:-4020}}"
[ -n "${WORKER_KEY:-}" ] || { echo "$(date -u +%FT%TZ) WORKER_KEY not set in .env"; exit 0; }
WORKER_NAME="${WORKER_NAME:-house-1}"
node --disable-warning=ExperimentalWarning tools/worker.js ensure-joined 2>&1 | grep -v "^seated$" | sed "s/^/$(date -u +%FT%TZ) /"

ASSIGNMENT="$(node --disable-warning=ExperimentalWarning tools/worker.js current 2>&1)"; code=$?
if [ $code -eq 3 ]; then echo "$(date -u +%FT%TZ) quiet"; exit 0; fi
if [ $code -ne 0 ]; then echo "$(date -u +%FT%TZ) cannot check assignments: $ASSIGNMENT"; exit 0; fi

AID="$(printf '%s' "$ASSIGNMENT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
WORKDIR="$HOME/piecework-work/assignment-$AID"; mkdir -p "$WORKDIR"
AFILE="$WORKDIR/assignment.json"; printf '%s\n' "$ASSIGNMENT" > "$AFILE"
PROMPT="$(sed -e "s|__WORKER__|$WORKER_NAME|g" -e "s|__ASSIGNMENT_FILE__|$AFILE|g" -e "s|__WORKDIR__|$WORKDIR|g" -e "s|__REPO__|$REPO|g" deploy/worker-prompt.md)"
LOG="data/logs/worker-$(date -u +%F).log"
echo "$(date -u +%FT%TZ) assignment $AID: starting a house worker run (log $LOG)"
(
  cd "$WORKDIR" && claude -p "$PROMPT" --output-format text --max-turns "${WORKER_MAX_TURNS:-120}" \
    --allowedTools "Bash,Read,Edit,Write,Glob,Grep" 2>&1
) | tee -a "$LOG" &
CLAUDE_PID=$!
# Hard stop shortly before the platform clock would expire anyway.
( sleep "${WORKER_WALL_SECONDS:-560}"; kill $CLAUDE_PID 2>/dev/null && echo "$(date -u +%FT%TZ) assignment $AID: wall clock hit, run stopped" ) &
KILLER=$!
wait $CLAUDE_PID 2>/dev/null; kill $KILLER 2>/dev/null
echo "$(date -u +%FT%TZ) assignment $AID: run finished"
