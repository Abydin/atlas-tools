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

# Poll for up to ~5s rather than a single fixed sleep: the browser launch
# (Chromium startup, or a clean failure when Chromium isn't installed) can
# take longer than 1s, and a too-short check here has reported "started"
# right before the process died - a silent half-work first-run experience.
for _ in 1 2 3 4 5; do
  sleep 1
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    break
  fi
done

if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "atlas-browser started (pid $(cat "$PIDFILE"), port $PORT)"
else
  rm -f "$PIDFILE"
  echo "atlas-browser failed to start. Last lines of logs/server.log:" >&2
  tail -n 10 logs/server.log >&2 2>/dev/null || true
  exit 1
fi
