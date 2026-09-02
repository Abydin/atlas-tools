# fetch-media

Wraps [yt-dlp](https://github.com/yt-dlp/yt-dlp) to return a title and transcript for
a video, audio, or social media URL. Point it at a YouTube link, a podcast episode, a
TikTok, an Instagram Reel, whatever yt-dlp itself supports, and it prints the title,
channel/uploader, duration, and (if captions exist) the deduped transcript text as
plain text on stdout.

This exists so an LLM-backed agent never has to say "I can't watch videos." yt-dlp
already knows how to pull captions from hundreds of sites; this script just supplies
the right invocation (a JS runtime for YouTube's extractor, auto-subs first then
manual subs, an optional browser-cookie retry for auth-gated content) and returns
clean text instead of a raw `.vtt` file.

## Dependencies

- **Python 3** (any recent 3.x; developed against 3.9).
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)**, the actual extractor. Install with
  `pipx install yt-dlp` or `python3 -m pip install --user yt-dlp`. yt-dlp updates
  often (sites change their player code regularly); if fetches start failing,
  upgrade it first (`pipx upgrade yt-dlp` or `pip install --user -U yt-dlp`) before
  assuming this script is broken.
- **Node.js**, any reasonably current LTS. yt-dlp's YouTube extractor needs a JS
  runtime to solve player-side challenges; without one, YouTube fetches fail even
  though yt-dlp itself is installed correctly. Not required for sites that don't
  need it.
- Optional: a **browser with cookies** (Chrome, Safari, or Firefox) if you need to
  fetch content that requires being logged in. yt-dlp reads the cookie jar directly
  from the browser profile; nothing is copied out of it by this script.

## Install

```bash
cd fetch-media
./install.sh
```

`install.sh` is idempotent, safe to re-run any time. It:
1. Confirms `python3` is on PATH.
2. Confirms `yt-dlp` is installed (on PATH or at `~/.local/bin/yt-dlp`); installs it
   via pipx or `pip install --user` if missing.
3. Confirms `node` is on PATH; warns (does not fail) if it's missing, since only
   some sites need it.
4. Copies `config.example.json` to `config.json` if `config.json` doesn't already
   exist. It never overwrites an existing `config.json`.

Edit `config.json` if your yt-dlp lives somewhere nonstandard, or if you want a
longer timeout, or a different default cookie browser. See
`config.example.json` for every setting and its default.

## Usage

```bash
python3 fetch_media.py <url> [--cookies chrome|safari|firefox]
```

**Example 1, a short public video with captions:**

```bash
$ python3 fetch_media.py 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
```

Prints an untrusted-content-fenced block whose body looks like:

```
TITLE: Me at the zoo
CHANNEL: jawed
DURATION: 00:00:19

TRANSCRIPT:
All right, so here we are, in front of the elephants
the cool thing about these guys is that they have really...
really really long trunks
and that's cool
...
```

The fencing markers (`[BEGIN_UNTRUSTED_CONTENT:...]` / `[END_UNTRUSTED_CONTENT:...]`)
and the instruction line above them are intentional, see "Content safety" below.
Exits 0.

**Example 2, a URL that can't be fetched (deleted/private/nonexistent):**

```bash
$ python3 fetch_media.py 'https://www.youtube.com/watch?v=doesnotexist000'
COULD NOT FETCH via yt-dlp:
[BEGIN_UNTRUSTED_CONTENT:...]
ERROR: [youtube] doesnotexist0: Video unavailable
[END_UNTRUSTED_CONTENT:...]
This is likely private, deleted, region-locked, or login-gated. Retry with
--cookies chrome|safari|firefox if it needs a logged-in session, or open the URL
in a browser and read the page directly.
```

Exits 1.

## How to verify it works

Run the install script, then fetch a known-stable public video with captions:

```bash
./install.sh
python3 fetch_media.py 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; echo "exit=$?"
```

Success looks like: output containing `TITLE: Me at the zoo`, a `TRANSCRIPT:`
section with real caption text, and `exit=0`. If instead you get `COULD NOT FETCH`
and `exit=1` on this specific URL (it's short, public, and has had captions for
years), something in the install is broken, most likely yt-dlp is out of date or
`node` isn't reachable, check the warnings `install.sh` printed.

## Content safety

Everything this script prints from an external source (the transcript, the error
text on a failed fetch) is wrapped in an untrusted-content fence (see `safety.py`,
vendored alongside this script). The fence tells a downstream model, explicitly,
to treat that text as inert data, never as instructions, even if the transcript
itself contains something that reads like a command. This matters because the
content comes from whatever page you pointed the script at, not from you.

## Known limits

- **Private, deleted, region-locked, or login-gated media**: the script prints
  `COULD NOT FETCH via yt-dlp:` followed by yt-dlp's error text (fenced as
  untrusted content) and exits 1. If the failure looks like an auth wall
  (whole-word match on "private", "sign in", "login", "members", or
  "age-restrict"/"age restrict" in the error text) and
  `auto_retry_with_cookies` is on in config (**default: off** - it silently
  hands your logged-in browser session's cookies to yt-dlp for whatever URL
  you fetch, which is worth opting into deliberately, not inheriting by
  default), it automatically retries once using the configured browser's
  cookie jar before giving up.
- **No captions available**: the fetch still succeeds (exit 0) and prints the
  title/channel/duration, but the transcript section says none was available.
  Not every video has captions or auto-generated subtitles.
- **yt-dlp breaks when sites change.** Sites change their player/API code
  regularly, and yt-dlp updates to track it, often within days. If fetches that
  used to work suddenly fail across the board (not just for one video), upgrade
  yt-dlp before assuming this script regressed.
- **This is text extraction, not media understanding.** The transcript is
  whatever caption track yt-dlp pulls down; nothing here transcribes audio that
  has no caption track, describes video content, or does OCR on it.
