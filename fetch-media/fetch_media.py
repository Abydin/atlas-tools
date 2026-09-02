#!/usr/bin/env python3
"""
fetch_media.py, given a video/audio/social URL, return its metadata + transcript.

This wraps yt-dlp so you never have to say "I can't watch videos" to a model
that's supposed to answer questions about one. yt-dlp does the real work; this
script just supplies the right incantation (a JS runtime for YouTube, auto
subtitles first then manual subtitles, an optional browser-cookie retry for
auth-gated content) and returns clean, deduped transcript text.

Usage:
    python3 fetch_media.py <url> [--cookies chrome|safari|firefox]

Prints: TITLE / CHANNEL / DURATION, then the cleaned transcript text (or a
clear, honest reason it could not be fetched, e.g. private / deleted /
region-locked / needs login).

Config: reads config.json next to this script if present (copy
config.example.json to config.json and edit), otherwise falls back to sane
defaults. See config.example.json for every setting.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from safety import sanitize_untrusted

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

_DEFAULTS = {
    "ytdlp_path": "~/.local/bin/yt-dlp",
    "node_path": None,
    "timeout_seconds": 120,
    "auto_retry_with_cookies": False,
    "default_cookies_browser": "chrome",
}


def _load_config():
    cfg = dict(_DEFAULTS)
    cfg_path = os.path.join(SCRIPT_DIR, "config.json")
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except (OSError, json.JSONDecodeError) as e:
            print(f"warning: could not read config.json ({e}), using defaults", file=sys.stderr)
    return cfg


CONFIG = _load_config()


def _resolve_ytdlp(cfg):
    """Prefer the configured path if it exists; otherwise fall back to
    whatever `yt-dlp` resolves to on PATH, so a fresh machine without the
    configured path still works as long as yt-dlp is installed some other
    way (pipx, brew, pip --user)."""
    configured = os.path.expanduser(cfg.get("ytdlp_path") or "")
    if configured and os.path.exists(configured):
        return configured
    found = subprocess.run(["bash", "-lc", "command -v yt-dlp"],
                            capture_output=True, text=True).stdout.strip()
    return found or "yt-dlp"


def _resolve_node(cfg):
    """yt-dlp's YouTube extractor needs a JS runtime. Use the configured path
    if given, otherwise whatever `node` resolves to on PATH (a login shell,
    so nvm/asdf shims are picked up)."""
    if cfg.get("node_path"):
        return os.path.expanduser(cfg["node_path"])
    return subprocess.run(["bash", "-lc", "command -v node"],
                           capture_output=True, text=True).stdout.strip()


YTDLP = _resolve_ytdlp(CONFIG)
NODE = _resolve_node(CONFIG)
JS_ARGS = ["--js-runtimes", f"node:{NODE}"] if NODE else []
TIMEOUT = CONFIG.get("timeout_seconds", 120)


def _run(args):
    return subprocess.run([YTDLP, *JS_ARGS, *args], capture_output=True, text=True, timeout=TIMEOUT)


def _clean_vtt(path):
    """VTT -> plain deduped transcript text."""
    out, seen = [], set()
    for line in open(path, encoding="utf-8", errors="ignore"):
        line = line.rstrip("\n")
        if (not line or line.startswith(("WEBVTT", "Kind:", "Language:"))
                or "-->" in line or re.match(r"^\d+$", line)):
            continue
        line = re.sub(r"<[^>]*>", "", line).strip()
        if line and line not in seen:
            seen.add(line)
            out.append(line)
    return "\n".join(out)


def fetch_structured(url, cookies=None):
    """Core fetch, returns a plain dict (no fencing/formatting) so callers
    that want structured fields don't have to re-parse the stdout-formatted
    string. fetch() below wraps this into the printed output."""
    cookie_args = ["--cookies-from-browser", cookies] if cookies else []

    meta = _run(["--skip-download", "--print", "%(title)s\n%(channel|uploader)s\n%(duration>%H:%M:%S)s", *cookie_args, url])
    if meta.returncode != 0 or not meta.stdout.strip():
        err = (meta.stderr or "").strip().splitlines()
        reason = next((l for l in err if "ERROR" in l), err[-1] if err else "unknown error")
        # auth-gated? retry once with a browser-cookie jar, if configured to.
        if not cookies and CONFIG.get("auto_retry_with_cookies") and re.search(r"\bprivate\b|\bsign in\b|\blogin\b|\bmembers\b|\bage[- ]restrict", reason, re.I):
            return fetch_structured(url, cookies=CONFIG.get("default_cookies_browser", "chrome"))
        return {"ok": False, "reason": reason, "title": None, "channel": None,
                "duration": None, "transcript": None}

    title, channel, dur = (meta.stdout.strip().split("\n") + ["", "", ""])[:3]

    with tempfile.TemporaryDirectory() as td:
        tmpl = os.path.join(td, "cap.%(ext)s")
        # auto-subs first, then manual subs
        for sub_flag in ("--write-auto-subs", "--write-subs"):
            _run(["--skip-download", sub_flag, "--sub-lang", "en.*", "--sub-format", "vtt",
                  "-o", tmpl, *cookie_args, url])
            vtts = glob.glob(os.path.join(td, "*.vtt"))
            if vtts:
                text = _clean_vtt(vtts[0])
                if text:
                    return {"ok": True, "title": title, "channel": channel,
                            "duration": dur, "transcript": text}
    return {"ok": True, "title": title, "channel": channel, "duration": dur, "transcript": None}


def fetch(url, cookies=None):
    d = fetch_structured(url, cookies=cookies)
    if not d["ok"]:
        # `reason` comes from yt-dlp stderr, which is partly site-influenced (error
        # text can echo page content), so it's untrusted the same as a transcript.
        # The surrounding guidance is our own trusted instruction and stays
        # outside the fence.
        fenced_reason = sanitize_untrusted(d["reason"], source=f"fetched-media-error:{url}")
        return (f"COULD NOT FETCH via yt-dlp:\n{fenced_reason}\n"
                "This is likely private, deleted, region-locked, or login-gated. "
                "Retry with --cookies chrome|safari|firefox if it needs a logged-in "
                "session, or open the URL in a browser and read the page directly.")

    header = f"TITLE: {d['title']}\nCHANNEL: {d['channel']}\nDURATION: {d['duration']}\n"
    if d["transcript"]:
        content = header + "\nTRANSCRIPT:\n" + d["transcript"]
        return sanitize_untrusted(content, source=f"fetched-media:{url}")
    content = (header + "\nNo captions/transcript available for this one. "
               "The metadata above is still usable; there's just no text track "
               "to extract.")
    return sanitize_untrusted(content, source=f"fetched-media:{url}")


def _flag_val(name):
    if name not in sys.argv:
        return None
    index = sys.argv.index(name)
    if index + 1 >= len(sys.argv) or sys.argv[index + 1].startswith("--"):
        print(f"error: {name} requires a value", file=sys.stderr)
        print("usage: fetch_media.py <url> [--cookies chrome|safari|firefox]", file=sys.stderr)
        sys.exit(1)
    return sys.argv[index + 1]


if __name__ == "__main__":
    ck = _flag_val("--cookies")
    args = [a for a in sys.argv[1:] if not a.startswith("--") and a != ck]
    if not args:
        print("usage: fetch_media.py <url> [--cookies chrome|safari|firefox]", file=sys.stderr)
        sys.exit(1)
    url = args[0]
    result = fetch(url, cookies=ck)
    print(result)
    sys.exit(0 if not result.startswith("COULD NOT FETCH") else 1)
