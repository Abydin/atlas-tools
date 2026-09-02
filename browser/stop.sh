#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
PIDFILE="state/server.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")"
  rm -f "$PIDFILE"
  echo "atlas-browser stopped"
else
  echo "atlas-browser not running"
fi
