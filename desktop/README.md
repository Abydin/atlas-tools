# desktop

A macOS desktop-control CLI. Reads any app's UI as structured data (roles,
names, positions) via the Accessibility API and drives it by name, not by
guessed pixel coordinates. Falls back to a screenshot + coordinate click
only for the handful of things Accessibility genuinely can't see (canvas
UIs, games, non-accessible legacy apps).

One verb per invocation, JSON in, JSON out on stdout, non-zero exit with an
`error` field on failure.

## Why this exists

The usual way to script a macOS UI is "screenshot, eyeball pixels, click
the coordinate." That's slow, breaks the moment a window moves or resizes,
and needs manual DPI math on anything but a plain 1x display. This CLI
queries the OS's own accessibility tree instead, the same tree VoiceOver
reads, so a query like "find the button named Submit" returns exact,
click-ready coordinates without a human (or a model) ever looking at a
screenshot.

## The three coverage layers

1. **Native** (`find`, `windows`, `focus`, `click`, `type`, `key`,
   `scroll`) walks the macOS Accessibility tree via System Events. Works on
   any app that exposes it: Finder, System Settings, native dialogs, a
   browser's own chrome (its tab bar, sidebar, URL bar), and most native
   Mac apps. Pass `--app <name>` for any running app (see `list-apps`).
2. **Web** (`dom`, `select`, `fill`) reads and writes the DOM of a page
   rendered in a browser tab, via injected JavaScript. This is what
   Accessibility can't see, a web page's own DOM is a separate tree from
   the native UI tree.
3. **Vision fallback** (`screenshot` + `click-xy`) is the safety net for
   anything the first two layers can't expose: canvas/custom-drawn UIs,
   games, images, non-accessible legacy apps, PDFs, video.

Reach for layer 1 first, layer 2 for in-page web content, layer 3 only when
the first two genuinely have nothing to offer.

## Files

- `desktop`, the executable. `#!/usr/bin/env python3`, stdlib only, no pip
  dependencies.
- `_ax.js`, the Accessibility-tree engine, invoked via
  `osascript -l JavaScript`. Not meant to be called directly.
- `_key.js`, the key-combo dispatcher, same deal.
- `.calibration.json.example`, a template for the per-display geometry
  values the `dom`/`fill`/`select` web layer needs to translate a page's
  own coordinates into absolute screen coordinates. Copy to
  `.calibration.json` and run `calibrate` once per machine/display, see
  below.

## Dependencies

- macOS. Uses the Accessibility API (System Events) and `osascript`.
- **Python 3**, stdlib only. Use the system `/usr/bin/python3` rather than a
  Homebrew Python if you hit `osascript`/AppleScript bridging issues; some
  third-party Python builds don't wire up the ScriptingBridge the same way.
- **Accessibility permission**: on first run, macOS will prompt to grant
  your terminal app Accessibility access (System Settings > Privacy &
  Security > Accessibility). Required for every native-layer command.
- The web layer (`dom`, `select`, `fill`) currently targets a Chromium-based
  browser reachable via `osascript`'s `execute javascript` (developed and
  tested against Arc; should generalize to any Chromium browser with
  "Allow JavaScript from Apple Events" enabled in its View menu).

## Install

No build step. Clone or copy the `desktop/` directory anywhere and run it
directly:

```bash
cd desktop
chmod +x desktop
./desktop list-apps
```

The first native-layer command triggers the macOS Accessibility permission
prompt. Approve it once for whichever terminal app you're running from.

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

**Example, click a button by name:**

```bash
$ desktop find --role button --name "Sign in" --app Safari
[{"role": "button", "name": "Sign in", "x": 812, "y": 140, "w": 90, "h": 32, "cx": 857, "cy": 156}]
$ desktop click --role button --name "Sign in" --app Safari
{"clicked": true, "role": "button", "name": "Sign in"}
```

## Calibration (web layer only)

The `dom`/`fill`/`select` commands compute a web element's absolute screen
position from its in-page coordinates plus the browser window's own chrome
(toolbar height, sidebar width). That chrome varies by browser, zoom level,
and display. `calibrate` measures it once per machine/display combination
with a single corrective click, and stores the result in
`.calibration.json` (gitignored; copy `.calibration.json.example` to see
the shape). Without a calibration file, the CLI falls back to a hardcoded
default that's usually close but not exact, run `calibrate` for reliable
clicks.

## How to verify it works

```bash
cd desktop
./desktop list-apps
```

Success looks like a JSON array of your currently running GUI apps (name,
bundle id, active flag, pid), and no Accessibility-permission error. If you
get an empty array or a permission error, check System Settings > Privacy &
Security > Accessibility for your terminal app.

For the web layer, open any page in your Chromium-based browser and run:

```bash
./desktop dom --limit 5
```

Success looks like a JSON array of up to 5 elements from that page's DOM.

## Known limits

- macOS only.
- The web layer needs a Chromium-based browser with Apple Events JavaScript
  execution enabled; it does not currently support Safari or Firefox.
- `type` is native-apps only; it does not reliably reach web `<input>`
  fields (use `fill` for those, see the CLI's own `--help` text for why).
- `screenshot`/`click-xy` is a fallback, not the primary way to find things,
  by design: it has no notion of "the button named X," only pixels.
