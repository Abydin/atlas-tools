#!/usr/bin/env bash
# install.sh, sets up fetch-media in place. Idempotent: safe to re-run.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "fetch-media install"
echo "dir: $DIR"
echo

# 1. Python 3
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found on PATH. Install Python 3 first." >&2
  exit 1
fi
echo "ok  python3: $(command -v python3) ($(python3 --version 2>&1))"

# 2. yt-dlp, the actual media extractor this script wraps.
if command -v yt-dlp >/dev/null 2>&1; then
  echo "ok  yt-dlp found on PATH: $(command -v yt-dlp)"
elif [ -x "$HOME/.local/bin/yt-dlp" ]; then
  echo "ok  yt-dlp found at ~/.local/bin/yt-dlp"
else
  echo "missing  yt-dlp not found. Installing to ~/.local/bin (pipx if available, else pip --user)."
  if command -v pipx >/dev/null 2>&1; then
    pipx install yt-dlp
  else
    python3 -m pip install --user --upgrade yt-dlp
  fi
  if command -v yt-dlp >/dev/null 2>&1 || [ -x "$HOME/.local/bin/yt-dlp" ]; then
    echo "ok  yt-dlp installed"
  else
    echo "WARNING: yt-dlp install ran but the binary wasn't found on PATH or in ~/.local/bin." >&2
    echo "         Add its install location to PATH, or set ytdlp_path in config.json." >&2
  fi
fi

# 3. node, needed by yt-dlp's YouTube extractor for JS-runtime challenges.
if command -v node >/dev/null 2>&1; then
  echo "ok  node found on PATH: $(command -v node)"
else
  echo "WARNING: node not found. YouTube fetches will likely fail (yt-dlp needs a JS runtime" >&2
  echo "         for YouTube's extractor). Install node (nvm, brew, or your package manager)" >&2
  echo "         and re-run this script, or set node_path in config.json once it's installed." >&2
fi

# 4. config.json, copy the example if one doesn't already exist. Never
#    overwrite an existing config, that's the idempotent part.
if [ -f config.json ]; then
  echo "ok  config.json already exists, leaving it alone"
else
  cp config.example.json config.json
  echo "ok  wrote config.json from config.example.json (defaults, edit as needed)"
fi

echo
echo "install complete. Verify with:"
echo "  python3 $DIR/fetch_media.py 'https://www.youtube.com/watch?v=jNQXAC9IVRw'"
