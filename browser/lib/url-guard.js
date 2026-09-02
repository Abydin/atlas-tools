'use strict';

// SECURITY BOUNDARY (t-350 hardening, HOLE 1): validates a navigation
// target's scheme BEFORE it is ever handed to page.goto(). This is the
// ONLY place that decides "is this URL safe to visit" - lib/atlas-browser.js
// calls assertSafeUrl() at the top of open(), before goto, and again on
// page.url() immediately after goto returns (see the comment there for
// why: a redirect chain is a second place a disallowed scheme could be
// reached even though the caller's original URL was fine).
//
// Deliberately NOT implemented as page.route() interception - route
// handlers apply to requests, and a top-level navigation to file:// (or
// data:/javascript:/chrome:/etc) does not reliably fire as an interceptable
// "request" the way a same-page fetch does. Boundary validation with the
// URL API is the actual fix; string-prefix matching (e.g. checking
// url.startsWith('http')) is NOT used here on purpose, since it is trivial
// to defeat (e.g. "http:evil" tricks, whitespace, backslashes browsers
// normalize before the string check ever sees them). Parsing with `new
// URL()` forces Node's own WHATWG-compliant normalization to run first.

const { URL } = require('url');

// http/https only. Every other scheme below is explicitly named in the
// task spec as one this browser must never resolve, listed here (rather
// than only implied by the allowlist) so the intent reads plainly:
//   file:            arbitrary local file read (HOLE 1, verified)
//   data:            inline content, can smuggle scripts/HTML past a URL check
//   blob:            same class of risk as data:
//   javascript:      would execute in the frame if ever navigated to
//   about: (non-blank) internal browser pages
//   chrome:, chrome-extension:, view-source:  browser-internal surfaces
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function assertSafeUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input));
  } catch (err) {
    throw new Error(`refusing to navigate: not a parseable URL: ${input}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`refusing to navigate: protocol "${parsed.protocol}" is not allowed (only http/https)`);
  }
  return parsed;
}

module.exports = { assertSafeUrl, ALLOWED_PROTOCOLS };
