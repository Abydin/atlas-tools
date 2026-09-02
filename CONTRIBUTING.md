# Contributing

This is a small, personal toolbox, not a maintained framework. Contributions
are welcome, but keep expectations proportionate to that.

## Scope

The repo is deliberately a monorepo of a few standalone tools rather than
many thin repos. A tool graduates to its own repo only once it has real
outside users, at which point its history moves with it via
`git subtree split`. Until then, new tools land as a new top-level directory
here, each self-contained (its own README, its own install step).

## Before opening a PR

- Keep a tool's directory self-contained. Nothing in one tool's directory
  should import from another tool's directory.
- Match the existing style in the file you're touching rather than
  introducing a new convention.
- No new dependencies without a reason in the PR description.
- Run whatever that tool's README lists under "how to verify it works"
  before opening the PR, and say what you ran.
- No fabricated benchmarks or claims. If you didn't measure it, don't
  assert it.

## Bug reports

Open an issue with: what you ran, what you expected, what happened instead,
and your OS/runtime versions. For `browser/`, that's the Node version; for
`fetch-media/`, the yt-dlp version. `desktop` moved to its own repo,
[github.com/Abydin/atlas-desktop](https://github.com/Abydin/atlas-desktop),
file issues there.

## Security

If you find a way to bypass one of the sandboxing/allowlist boundaries
documented in a tool's README (the SSRF guard in `browser/lib/host-guard.js`,
the upload-path confinement, the URL scheme guard), please open an issue
rather than a PR with the exploit, so it can be looked at before details are
public.
