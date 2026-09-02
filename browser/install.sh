#!/usr/bin/env bash
# install.sh, sets up browser in place. Idempotent: safe to re-run.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "browser install"
echo "dir: $DIR"
echo

FAIL=0

# 1. Node, and a version new enough for the browser SDK (Playwright's own
#    driver + this repo's code both assume Node 20+).
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. Install Node.js 20 or newer first (nvm, brew, or" >&2
  echo "       your package manager) and re-run this script." >&2
  exit 1
fi
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: node $(node -v) found, but browser needs Node 20 or newer." >&2
  echo "       Install a newer Node (nvm install 20, brew upgrade node, ...) and re-run." >&2
  exit 1
fi
echo "ok  node: $(command -v node) ($(node -v))"

# 2. npm, ships with node but check explicitly rather than let `npm install`
#    fail with a confusing "command not found".
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found on PATH even though node is present. Reinstall Node.js." >&2
  exit 1
fi
echo "ok  npm: $(command -v npm) ($(npm -v))"

# 3. Dependencies (playwright, ws). `npm install` is itself idempotent, no
#    need to skip it on a re-run.
echo
echo "installing npm dependencies..."
npm install
echo "ok  npm install complete"

# 4. Chromium, the actual browser Playwright drives. This is the step
#    people forget when they only run `npm install` - it downloads a
#    separate ~150MB binary Playwright launches directly, not an npm
#    package, and skipping it fails later with a stack trace at server
#    start time rather than here, at install time, where it's obvious.
echo
echo "installing Chromium for Playwright (skips silently if already present)..."
npx playwright install chromium
echo "ok  chromium install complete"

# 5. cli.js, executable and reachable as a bin entry (`npm link` / `npm i -g`
#    wires this up via package.json's "bin" field; this just confirms the
#    file itself is in the state npm expects).
if [ ! -x cli.js ]; then
  echo "warn  cli.js wasn't executable, fixing" >&2
  chmod +x cli.js
fi
echo "ok  cli.js is executable"

echo
if [ "$FAIL" -ne 0 ]; then
  echo "install finished with errors, see above. Fix them and re-run this script." >&2
  exit 1
fi

echo "install complete. Verify with:"
echo "  cd $DIR"
echo "  ./start.sh"
echo "  node cli.js status"
echo "  node cli.js open 'https://example.com'"
echo "  node cli.js close-session"
echo "  ./stop.sh"
echo
echo "To use it as a global command instead of 'node cli.js':"
echo "  npm link            # from this directory, then run: atlas-browser --help"
