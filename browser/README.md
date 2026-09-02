# browser

A headless Playwright browser service with a live captcha-handover surface.
Runs as a small local HTTP server; a thin CLI drives it. Built so a
script or an LLM-backed agent can open a page, read structured form data,
fill it in, and, when it hits something it genuinely cannot resolve (a
captcha, an ambiguous field), hand the exact same live page over to a human
to finish, instead of failing silently or guessing.

This is the most novel piece in this repo: most headless-browser wrappers
stop at "click and read." This one also solves the handover problem, a
captcha blocks a fully headless run, but pausing to open a whole separate
interactive browser and hope the human relocates the same page is its own
kind of broken. `/live` instead streams the actual running session (CDP
screencast, real mouse/keyboard passthrough) to any device on the network,
so a human finishes the one blocked step and the automation resumes on the
same page, same cookies, same state.

## Why this exists

Ordinary browser automation is fine until it isn't: a captcha appears, a
non-native `<select>` refuses `.value =`, a field looks filled but React's
internal state never actually changed. Most of this repo's code is the
accumulated fix for exactly those failure modes (see the comments in
`lib/form.js` and `lib/atlas-browser.js`), plus a captcha-handover path that
treats "a human needs to look at this" as a normal outcome, not a crash.

## Architecture

```
cli.js  -->  HTTP (127.0.0.1)  -->  server.js  -->  lib/atlas-browser.js  -->  Playwright
```

- `server.js`: the HTTP API. Bearer-token auth, one shared Playwright
  browser context, N named sessions (tabs), an escalation queue, and the
  `/view` and `/live` handover surfaces.
- `cli.js`: a thin CLI over that HTTP API. Every command is one HTTP call;
  JSON in, JSON out on stdout, non-zero exit with an `error` field on
  failure.
- `lib/atlas-browser.js`: the actual browser driver. Owns the one shared
  Playwright context and its sessions.
- `lib/form.js`: structured form introspection (`scanForm`) and semantic
  field setting (`setField`) that handles the non-native combobox/ARIA
  widget cases a plain `.value =` silently fails on.
- `lib/fingerprint-normalize.js`: headless-vs-desktop browser parity. Some
  sites reject fully-honest, correctly-filled submissions purely because
  the browser reads as headless (`navigator.webdriver`, missing `chrome`
  object, an old-style headless UA); this makes it present the same
  surface an ordinary desktop Chrome instance would, without changing
  anything about the content submitted.
- `lib/host-guard.js` / `lib/url-guard.js`: an SSRF guard. Denies
  navigation to loopback/RFC1918/link-local/CGNAT ranges by resolved IP
  (not a string check on the URL), so a hostile page can't use this
  browser to reach an unauthenticated service on your own machine or LAN.
- `lib/escalations.js` / `lib/ntfy.js` / `lib/scoped-tokens.js`: the
  handover path. When a session can't proceed, it raises an escalation and
  can send an optional push notification (via [ntfy](https://ntfy.sh)).
  That notification's view link carries a scoped, short-lived,
  single-session token (`lib/scoped-tokens.js`), never the master
  credential - it authorizes only the `/live`/`/view` surface of that one
  session, for a bounded window, and nothing else the master token could
  do (open/close/upload/proxy/any other session). Tapping it without that
  token, or after it expires, returns 401.
- `lib/proxies.js`: named proxy/VPN exit profiles for a session, for
  discovery use (seeing geo-varied content, getting past IP-reputation
  blocks on read-only research), not for misrepresenting who's behind an
  outward-facing submission.

## Dependencies

- Node.js, a reasonably current LTS.
- [Playwright](https://playwright.dev) (`npm install` pulls it in) plus its
  bundled Chromium (`npx playwright install chromium`).

## Install

```bash
cd browser
npm install
npx playwright install chromium
./start.sh
```

`start.sh` starts the server in the background (default port 8781, logs to
`logs/server.log`, PID to `state/server.pid`), generating a random bearer
token on first run at `state/token` (0600). `./stop.sh` stops it.

## Environment variables

- `ATLAS_NTFY_TOPIC` (required for push escalations) - your own private
  [ntfy](https://ntfy.sh) topic name. There is no built-in default; an
  escalation with this unset is null-gated (logged, not delivered) rather
  than silently pushed anywhere. Anyone who can guess your topic can read
  your pushes, so pick something unguessable and keep it out of source
  control.
- `ATLAS_NTFY_URL` (optional) - ntfy server base URL, defaults to
  `https://ntfy.sh`.
- `ATLAS_NTFY_TEST_MODE=1` (optional) - hard-disables delivery regardless
  of the above; set by the smoke suite so tests never page a human.

## Usage

```
node cli.js status
node cli.js sessions
node cli.js open <url> [--god NAME] [--label L] [--session ID]
node cli.js read [--session ID]
node cli.js click <selector> [--session ID]
node cli.js type <selector> <text> [--enter] [--session ID]
node cli.js fill <selector> <value> [--session ID]
node cli.js upload <selector> <filePath> [--session ID]
node cli.js stage-file <path>
node cli.js form-scan [--session ID]
node cli.js form-set <ref> <value> [--session ID]
node cli.js form-values [--session ID]
node cli.js form-submit <ref> [--wait MS] [--session ID]
node cli.js close-session [--session ID]
node cli.js save-state
node cli.js watch on|off
node cli.js proxy <name|off>
node cli.js proxy-check [--session ID]
node cli.js view
node cli.js live
node cli.js escalate <reason> [--detail D] [--timeout MS] [--session ID]
node cli.js escalations
node cli.js answer <escalationId> <text>
node cli.js takeover <escalationId>
```

Run `node cli.js` with no args (or read the header comment in `cli.js`) for
the same list kept in sync with the code. Every action operates on a
SESSION (a tab). `--god NAME` (default: `atlas`, any label works, it's just
a namespace for "whose session is this") reuses that caller's most recently
opened session automatically, or pass `--session ID` to target a specific
one explicitly.

**Example, open a page and read its structure:**

```bash
$ node cli.js open 'https://example.com'
{ "sessionId": "smtjcd6bc1", "url": "https://example.com/", "title": "Example Domain" }
$ node cli.js form-scan --session smtjcd6bc1
{ "url": "https://example.com/", "title": "Example Domain", "captcha": false, "formCount": 0, "fields": [], "submits": [] }
```

**Example, the captcha-handover path:**

```bash
$ node cli.js escalate "captcha blocking submit" --session smtjcd6bc1
# BLOCKS until a human answers or takes over. Meanwhile:
$ node cli.js live
{ "url": "http://127.0.0.1:8781/live?session=smtjcd6bc1&token=..." }
# open that URL, solve the captcha live, the escalate call above returns
```

## Proxy / VPN exit profiles

`node cli.js proxy <name|off>` routes a session through a named proxy/VPN
exit defined in `state/proxies.json` (not shipped - create it yourself,
see `lib/proxies.js` for the JSON shape; `off` restores the direct
connection). `node cli.js proxy-check [--session ID]` reports the exit IP
currently in use.

**Read before wiring a profile into a real session:** proxy/VPN here is for
DISCOVERY only - seeing geo-varied content, and getting past IP-reputation
blocks on read-only research. It is NOT for hiding where the operator
actually is on any outward-facing act (a submission, a message, anything
that represents a real person doing a real thing) - stay honest about
origin there. `state/proxies.json` is gitignored once you fill in real
server/username/password values, the same as `storageState.json`/`token`.

## Security scoping

- Bearer-token auth on every endpoint (`lib/auth.js`); the token lives in a
  0600 file under `state/token`, never printed or logged - read it with
  `cat state/token` when you need it for `cli.js` or a manual request.
- The browser's own destination-host guard (`lib/host-guard.js`) denies
  loopback/RFC1918/link-local/CGNAT by resolved IP, not URL string, closing
  the SSRF path a hostile page could otherwise use.
- `upload()` is confined to a single staging directory (`state/uploads/`);
  a path outside it is refused, not silently redirected.
- `/live` and `/view` are token-gated at the server, and are meant to be
  handed to a human. `/live` accepts a bearer token in the URL query string
  specifically so it works from a plain link tap; treat that link itself as
  a bearer credential, don't paste it somewhere public. A link you build
  yourself with `node cli.js view` carries the master token; a link pushed
  by an escalation over ntfy carries a scoped, short-lived, single-session
  token instead (see `lib/scoped-tokens.js`), so a leaked push notification
  can't be used to seize the whole browser.
- `/live` binds to loopback plus (optionally) one specific interface IP you
  configure, never `0.0.0.0`; see the SECURITY comments near the bottom of
  `server.js` for the full reasoning.

## How to verify it works

```bash
cd browser
npm install
npx playwright install chromium
./start.sh
node cli.js status
node cli.js open 'https://example.com'
node cli.js form-scan
node cli.js close-session
./stop.sh
```

Success looks like: `status` returns a JSON object with `"headless": true`
and no error; `open` returns a `sessionId` and `"title": "Example Domain"`;
`form-scan` returns a JSON object (empty `fields`/`submits` is correct for
that page, it has none); `close-session` returns `{"closed": "<id>"}`.

## Known limits

- One shared browser context for all sessions (one profile, one cookie
  jar). Sessions are separate tabs, not separate identities.
- The parity measures in `lib/fingerprint-normalize.js` reduce automation
  fingerprinting tells; they don't defeat every anti-bot system, and this
  tool does not attempt to defeat CAPTCHAs, that's exactly what the
  `/live` handover is for instead.
- `state/`, `artifacts/`, and `logs/` are runtime data, gitignored, and not
  part of this repo.
