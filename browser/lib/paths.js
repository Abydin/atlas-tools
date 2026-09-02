'use strict';

// Every path the browser service is allowed to touch, resolved once here.
// SECURITY: the driver process's filesystem writes are confined to these
// directories. Nothing in lib/ or server.js should build a path outside
// this module's exports. See README.md "Security scoping".

const path = require('path');

const ROOT = path.resolve(__dirname, '..'); // repo root

// ATLAS_BROWSER_STATE_DIR lets test/smoke.js point at an isolated scratch
// dir instead of the real state/ folder, so a test run can never clobber
// a real logged-in profile or storageState. Unset in normal operation.
const STATE_DIR = process.env.ATLAS_BROWSER_STATE_DIR || path.join(ROOT, 'state');
const ARTIFACTS_DIR = process.env.ATLAS_BROWSER_ARTIFACTS_DIR || path.join(ROOT, 'artifacts');

module.exports = {
  ROOT,
  STATE_DIR,
  // Chromium's persistent profile. NOT Arc's profile, never shared with it.
  USER_DATA_DIR: path.join(STATE_DIR, 'user-data-dir'),
  // Exported login cookies/localStorage. A secret: see .gitignore + README.
  STORAGE_STATE: path.join(STATE_DIR, 'storageState.json'),
  // Per-run transcript + screenshots, durable audit trail.
  ARTIFACTS_DIR,
  // Bearer token for the HTTP API. A secret: see .gitignore + README.
  // Lives under STATE_DIR (not ROOT) so it automatically follows
  // ATLAS_BROWSER_STATE_DIR in tests, same as everything else here.
  TOKEN_PATH: path.join(STATE_DIR, 'token'),
  // HOLE 4 fix: the ONLY directory upload() will ever read a file from.
  // Deliberately NOT one of the operator's real document folders - see
  // README.md "Security scoping" for why allowlisting an arbitrary personal
  // folder would be a hole in itself (it may hold sensitive documents that
  // have nothing to do with what this service is uploading).
  UPLOADS_DIR: path.join(STATE_DIR, 'uploads'),
  // Remote-access config (Tailscale /live), see lib/network.js. One line
  // each, not secrets, safe to read/write like any other config file here.
  // PUBLIC_HOST_FILE: hostname to print/push in /live URLs (the Tailscale
  // MagicDNS name). TAILSCALE_IP_FILE: the IP the server additionally
  // BINDS to so a phone request over Tailscale actually reaches the
  // process (127.0.0.1 alone never does - see server.js SECURITY comment
  // by the listen() calls). Neither file existing is fine: both features
  // fall back to 127.0.0.1-only behavior, unchanged from before this pass.
  PUBLIC_HOST_FILE: path.join(STATE_DIR, 'public_host'),
  TAILSCALE_IP_FILE: path.join(STATE_DIR, 'tailscale_ip'),
  // Named proxy/VPN exit profiles (discovery only - see
  // lib/proxies.js + README "Proxy / VPN exit profiles"). Not a secret on
  // its own (the seeded profiles are placeholders); lives under STATE_DIR
  // so ATLAS_BROWSER_STATE_DIR redirects it in tests same as everything
  // else here, and so a real profile filled in with a live credential
  // stays out of the repo the same way storageState.json does (see
  // .gitignore note in lib/proxies.js's header on why this file itself is
  // still committed as source with placeholders).
  PROXIES_FILE: path.join(STATE_DIR, 'proxies.json'),
};
