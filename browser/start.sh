#!/bin/bash
# Starts the Atlas browser service in the background if it isn't already
# running. Logs to logs/server.log, PID to state/server.pid.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p logs state
PIDFILE="state/server.pid"
PORT="${ATLAS_BROWSER_PORT:-8781}"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "atlas-browser already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

nohup node server.js "$PORT" >> logs/server.log 2>&1 &
echo $! > "$PIDFILE"
sleep 1
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "atlas-browser started (pid $(cat "$PIDFILE"), port $PORT)"
else
  echo "atlas-browser failed to start, see logs/server.log"
  exit 1
fi
