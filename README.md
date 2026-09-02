# atlas-tools

A small collection of standalone automation tools: a headless browser with
live captcha handover and a video/audio transcript fetcher. Each one is
self-contained, has its own README, and can be copied out on its own
without breaking anything else here.

## What's here

- **[`browser/`](browser/README.md)**: a headless Playwright browser
  service with structured form introspection and a live handover surface,
  when a session hits something it can't resolve (a captcha, an ambiguous
  field), it can hand the exact running page to a human over the network
  instead of failing silently.
- **[`fetch-media/`](fetch-media/README.md)**: wraps
  [yt-dlp](https://github.com/yt-dlp/yt-dlp) to return a clean title +
  transcript for a video, audio, or social-media URL, so a caller never has
  to say "I can't watch videos."

`desktop`, a macOS accessibility CLI that used to live here, has graduated
to its own repo: [github.com/Abydin/atlas-desktop](https://github.com/Abydin/atlas-desktop).
It reads any macOS app's UI as structured data via the Accessibility API
and drives it by element name, not guessed pixel coordinates, native apps,
a browser's own chrome, and a page's DOM, with a screenshot fallback for
anything else. It moved out with full history via `git subtree split`,
see Layout below for why a tool leaves this monorepo.

## Install

Each tool installs independently, see its own README for exact steps.
Quick version:

```bash
cd browser && npm install && npx playwright install chromium && ./start.sh
cd fetch-media && ./install.sh
```

## Layout

```
atlas-tools/
├── browser/       headless Playwright browser + CLI (Node.js)
├── fetch-media/   yt-dlp wrapper (Python 3)
├── LICENSE
└── CONTRIBUTING.md
```

This is one monorepo, deliberately, rather than a repo per tool. A tool
graduates to its own repo only once it has real outside users, its history
moves with it at that point via `git subtree split`, exactly like
`desktop` did. Until then, keeping small tools in separate repos would
mean a separate README, issue tracker, and CI to babysit each, for no
reader benefit.

## Status

These are personal tools, used and maintained for real, not a polished
framework with a support commitment. Each README says exactly how to
verify that tool works on your machine, run that before relying on
anything here.

## License

MIT, see [LICENSE](LICENSE).
