# desktop

A macOS desktop-control CLI. Reads any app's UI as structured data (roles,
names, positions) via the Accessibility API and drives it by name, not by
guessed pixel coordinates.

The usual way to script a macOS UI is "screenshot, eyeball pixels, click
the coordinate." That's slow, breaks the moment a window moves or resizes,
and needs manual DPI math on anything but a plain 1x display. This CLI
queries the OS's own accessibility tree instead, the same tree VoiceOver
reads, so a query like "find the button named Submit" returns exact,
click-ready coordinates without a human (or a model) ever looking at a
screenshot. A screenshot + coordinate click is still here, but only as a
fallback for the handful of things Accessibility genuinely can't see
(canvas UIs, games, non-accessible legacy apps).

One verb per invocation, JSON in, JSON out on stdout, non-zero exit with an
`error` field on failure.

## Install

```bash
cd desktop
./install.sh
```

`install.sh` checks for and installs `cliclick` (Homebrew) if it's
missing, confirms `python3` is present, makes `desktop` executable, and
probes whether Accessibility permission is actually granted to your
terminal app, telling you the exact fix if it isn't. It's idempotent, safe
to re-run.

Nothing else needs installing: `desktop` is stdlib-only Python 3, and
`_ax.js`/`_key.js` run under `osascript`'s own JavaScript engine, not
Node. See [Why no package.json](#why-no-packagejson) below.

**Accessibility permission is the one step a script can't do for you.**
The first native-layer command triggers macOS's permission prompt; approve
it once for whichever terminal app you're running from (System Settings >
Privacy & Security > Accessibility). `install.sh` checks this and tells you
if it's missing. Skip it and every native command still runs, prints valid
JSON, and returns zero results with no error, the single worst first-run
experience there is, so `desktop` itself also now detects the denial and
returns a clear `error` field naming the fix instead of an empty result.

## First command

```bash
$ ./desktop list-apps
[{"name": "Finder", "bundleId": "com.apple.finder", "active": false, "pid": 412}, ...]
```

A JSON array of your currently running GUI apps. If Accessibility
permission isn't granted yet, most commands (this one included, since it
only needs `NSWorkspace`, not System Events) still work; the check below
exercises the part that actually needs the permission.

## Verify it works

```bash
./desktop windows
```

Success looks like a JSON array of the frontmost app's windows (title,
role, position, size). This one actually touches System Events, so it's
the real Accessibility-permission check. Failure looks like:

```json
{"error": "Accessibility permission is not granted to this terminal app. ...", "detail": "..."}
```

Grant it (System Settings > Privacy & Security > Accessibility, enable
your terminal app) and re-run.

**Example, click a button by name:**

```bash
$ ./desktop find --role button --name "Sign in" --app Safari
[{"role": "button", "name": "Sign in", "x": 812, "y": 140, "w": 90, "h": 32, "cx": 857, "cy": 156}]
$ ./desktop click --role button --name "Sign in" --app Safari
{"clicked": true, "role": "button", "name": "Sign in"}
```

## The three coverage layers

1. **Native** (`find`, `windows`, `focus`, `click`, `type`, `key`,
   `scroll`) walks the macOS Accessibility tree via System Events. Works on
   any app that exposes it: Finder, System Settings, native dialogs, a
   browser's own chrome (its tab bar, sidebar, URL bar), and most native
   Mac apps. Pass `--app <name>` for any running app (see `list-apps`).
2. **Web** (`dom`, `select`, `fill`) reads and writes the DOM of a page
   rendered in a browser tab, via injected JavaScript. This is what
   Accessibility can't see, a web page's own DOM is a separate tree from
   the native UI tree. Needs a one-time `calibrate` per machine, see below.
3. **Vision fallback** (`screenshot` + `click-xy`) is the safety net for
   anything the first two layers can't expose: canvas/custom-drawn UIs,
   games, images, non-accessible legacy apps, PDFs, video.

Reach for layer 1 first, layer 2 for in-page web content, layer 3 only when
the first two genuinely have nothing to offer.

## Calibration (web layer only)

The `dom`/`fill`/`select` commands compute a web element's absolute screen
position from its in-page coordinates plus the browser window's own chrome
(toolbar height, sidebar width). That chrome varies by browser, zoom level,
and display, so it's measured per machine, not shipped: `.calibration.json`
is gitignored on purpose (copy `.calibration.json.example` to see its
shape, but don't hand-edit it, `calibrate` writes it).

```bash
./desktop calibrate --app Arc
```

Run this once per machine/display combination, it makes a single
corrective click to measure the offset and stores the result. Without it,
the web layer falls back to a hardcoded default guess that's usually close
but not exact, and every web-layer command now warns loudly on stderr when
it's running on that uncalibrated guess (or on a stale one, e.g. after a
sidebar toggle or a move to a different display), naming the exact
`calibrate` command to fix it, so a bad click has an explanation instead of
just being wrong.

## Usage

```
desktop list-apps
desktop focus --app <Name>
desktop windows [--app <Name>]
desktop find --role button --name "Submit" [--app <Name>]
desktop click --role button --name "Submit" [--app <Name>]
desktop click-xy <x> <y>
desktop type --text "hello" [--enter]
desktop key --key return [--cmd] [--shift] [--option] [--control]
desktop scroll --direction down [--amount N]
desktop wait --role button --name "Submit" [--timeout MS] [--click]
desktop screenshot [--outpath PATH] [--display auto|N]
desktop dom [--selector "a,button,input"] [--limit 200]
desktop fill <selector> <value> [--enter]
desktop select --selector "#country" --value "Canada"
desktop macro --file actions.json
desktop calibrate
```

Run `desktop --help` (or `desktop <subcommand> --help`) for the full,
current flag list, it's kept in sync with the code as the single source of
truth.

## Dependencies

- macOS. Uses the Accessibility API (System Events) and `osascript`.
- **Python 3**, stdlib only. Use the system `/usr/bin/python3` rather than a
  Homebrew Python if you hit `osascript`/AppleScript bridging issues; some
  third-party Python builds don't wire up the ScriptingBridge the same way.
- **cliclick**, the only input-injection primitive for a real OS click or
  keystroke. `install.sh` installs it via Homebrew if missing.
- **Accessibility permission** for your terminal app, see Install above.
- The web layer (`dom`, `select`, `fill`) currently targets a Chromium-based
  browser reachable via `osascript`'s `execute javascript` (developed and
  tested against Arc; should generalize to any Chromium browser with
  "Allow JavaScript from Apple Events" enabled in its View menu).

## Files

- `desktop`, the executable. `#!/usr/bin/env python3`, stdlib only, no pip
  dependencies.
- `_ax.js`, the Accessibility-tree engine, invoked via
  `osascript -l JavaScript`. Not meant to be called directly.
- `_key.js`, the key-combo dispatcher, same deal.
- `install.sh`, the install/verify script described above.
- `.calibration.json.example`, a template for the per-display geometry
  values the web layer needs. Copy to `.calibration.json` only if you want
  to see the shape, `calibrate` writes the real file.

## Why no package.json

`desktop`'s entry point is a Python script; `_ax.js`/`_key.js` run inside
`osascript`'s own JavaScript engine, not under Node, and pull in no npm
packages. There's nothing for `npm install` to resolve and no scripts a
`package.json` would meaningfully wire up here, adding one would just be a
file that does nothing. If that changes (a real Node dependency shows up),
add one then.

## Known limits

- macOS only.
- The web layer needs a Chromium-based browser with Apple Events JavaScript
  execution enabled; it does not currently support Safari or Firefox.
- `type` is native-apps only; it does not reliably reach web `<input>`
  fields (use `fill` for those, see the CLI's own `--help` text for why).
- `screenshot`/`click-xy` is a fallback, not the primary way to find things,
  by design: it has no notion of "the button named X," only pixels.
