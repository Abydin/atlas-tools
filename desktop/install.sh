#!/usr/bin/env bash
# install.sh, sets up desktop in place. Idempotent: safe to re-run.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "desktop install"
echo "dir: $DIR"
echo

FAIL=0

# 0. macOS only, this whole tool is built on the Accessibility API.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: desktop is macOS-only (uses the Accessibility API via System Events)." >&2
  exit 1
fi
echo "ok  macOS: $(sw_vers -productVersion 2>/dev/null || echo unknown)"

# 1. python3, the CLI's shebang targets the system interpreter specifically
#    (/usr/bin/python3), see the header comment in `desktop` for why: a
#    Homebrew python3 has bitten this exact tool with ScriptingBridge/AppleEvent
#    bridging bugs before. Just check something is present here; the shebang
#    itself pins the interpreter when the script is run directly.
if command -v python3 >/dev/null 2>&1; then
  echo "ok  python3: $(command -v python3) ($(python3 --version 2>&1))"
else
  echo "ERROR: python3 not found. desktop's shebang is /usr/bin/python3, which ships with" >&2
  echo "       macOS, if that's missing something is unusual about this machine." >&2
  FAIL=1
fi

# 2. node, needed by _ax.js/_key.js? No: those run under osascript's own
#    JavaScript engine (JXA), not node. Nothing in this tool needs a node
#    runtime. Left out deliberately, see the package.json note in README.md
#    for why this tool has no npm dependency at all.

# 3. cliclick, the ONLY input-injection primitive this tool uses for a real
#    OS click or keystroke (native `type`/`key`, and every web-layer real
#    click via real_click_verified). Without it, every command that clicks
#    or types returns a clean {"error": "cliclick not found..."} rather than
#    doing nothing silently, but let's not make the user discover that on
#    their first real command.
if command -v cliclick >/dev/null 2>&1; then
  echo "ok  cliclick: $(command -v cliclick) ($(cliclick -V 2>&1 | head -1))"
else
  echo "missing  cliclick not found. Installing via Homebrew."
  if command -v brew >/dev/null 2>&1; then
    brew install cliclick
  else
    echo "ERROR: Homebrew not found, and cliclick has no other supported install path here." >&2
    echo "       Install Homebrew (https://brew.sh) then run: brew install cliclick" >&2
    FAIL=1
  fi
  if command -v cliclick >/dev/null 2>&1; then
    echo "ok  cliclick installed: $(command -v cliclick)"
  else
    echo "WARNING: cliclick install ran but the binary wasn't found on PATH afterward." >&2
    echo "         Open a new shell (Homebrew's bin dir may not be on PATH yet) and re-run" >&2
    echo "         this script, or run: brew install cliclick" >&2
    FAIL=1
  fi
fi

# 4. desktop, _ax.js, _key.js executable / present.
if [ ! -f desktop ] || [ ! -f _ax.js ] || [ ! -f _key.js ]; then
  echo "ERROR: desktop, _ax.js, or _key.js missing from $DIR, this doesn't look like a" >&2
  echo "       complete checkout of the desktop/ directory." >&2
  FAIL=1
else
  chmod +x desktop
  if [ -x desktop ]; then
    echo "ok  desktop is executable"
  else
    echo "ERROR: chmod +x desktop ran but the file still isn't executable." >&2
    FAIL=1
  fi
fi

# 5. Accessibility permission. This is the single worst failure mode this
#    tool has: without it, System Events returns an empty AX tree and
#    every click silently does nothing, no crash, no obvious error, just a
#    tool that "doesn't work". Probe with a real AX call (`windows`, not
#    `list-apps`, list-apps only needs NSWorkspace and doesn't touch
#    System Events at all, so it would pass even with zero AX permission
#    and give a false all-clear here).
echo
echo "checking Accessibility permission (probing System Events)..."
AX_PROBE="$("$DIR/desktop" windows 2>&1 || true)"
if echo "$AX_PROBE" | grep -q "Accessibility permission is not granted"; then
  echo "MISSING  Accessibility permission is not granted to this terminal app." >&2
  echo "         Fix: System Settings > Privacy & Security > Accessibility, enable" >&2
  echo "         the terminal app you're running this install from (Terminal, iTerm2," >&2
  echo "         VS Code, etc.). If it's already listed and checked, remove it and" >&2
  echo "         re-add it (macOS sometimes needs that after an app/OS update)." >&2
  echo "         Every native-layer command (windows/find/click/type/key/scroll) needs" >&2
  echo "         this, so nothing past this point will work until it's granted." >&2
  FAIL=1
elif echo "$AX_PROBE" | grep -q '"error"'; then
  echo "warn  \`desktop windows\` returned an error that isn't the Accessibility check," >&2
  echo "      not necessarily fatal (e.g. no frontmost app during install), showing it:" >&2
  echo "$AX_PROBE" >&2
else
  echo "ok  Accessibility permission granted, System Events responded"
fi

# 6. Calibration. Deliberately NOT auto-run here, `calibrate` needs a real
#    browser window open and focused, which install.sh shouldn't assume.
#    Just tell the user it's a separate, required, one-time step for the
#    web layer, so it's not a surprise the first time `dom`/`fill`/`select`
#    warns about it.
echo
echo "note  .calibration.json is not shipped (machine/display specific). The native"
echo "      layer (find/click/type/key/...) works without it. The web layer"
echo "      (dom/fill/select) works without it too but with an uncalibrated coordinate"
echo "      guess, run \`./desktop calibrate --app Arc\` once per machine/display before"
echo "      relying on web-layer clicks."

echo
if [ "$FAIL" -ne 0 ]; then
  echo "install finished with errors, see above. Fix them and re-run this script." >&2
  exit 1
fi

echo "install complete. Verify with:"
echo "  $DIR/desktop list-apps"
echo "  $DIR/desktop windows"
echo "  $DIR/desktop calibrate --app Arc      # one-time, web layer only"
