'use strict';

// Named proxy/VPN exit profiles, read from state/proxies.json - the
// plumbing needed to route a session through a chosen exit IP. PROVEN
// necessary: some sites hard-block certain residential IP ranges (403),
// and geo-locked content hides listings from a non-local IP.
//
// HONESTY (read this before wiring a profile into a real session): proxy/
// VPN is for DISCOVERY only - seeing geo-varied content and getting past
// IP-reputation blocks on read-only research. It is NOT for hiding where
// the operator actually is on any outward-facing act - stay honest about
// origin there. See README.md "Proxy / VPN exit profiles" for the same
// note stated for a human reader, and cli.js's `proxy` command help.
//
// state/proxies.json is NOT shipped in this repo - no file, no seeded
// example profiles. loadProxyProfiles() below treats a missing file as
// "zero profiles configured" (proxy support is fully optional, off by
// default), not an error. Create your own state/proxies.json with real
// SOCKS5/HTTP endpoint(s) (from a VPN provider or your own proxy) using
// the shape documented below to use this feature at all. It IS listed in
// .gitignore (same as storageState.json/token) because once you fill in
// a real server/username/password it is a credential, and the discipline
// that keeps a secret out of git only works if the ignore rule exists
// before the secret does.
//
// Shape of each profile (all fields but `server` optional):
//   {
//     "server": "socks5://host:port" | "http://host:port",
//     "username": "..." | null,
//     "password": "..." | null,
//     "timezoneId": "America/New_York",       // IANA tz, spoofed WITH the proxy
//     "geolocation": { "latitude": 0, "longitude": 0 },
//     "locale": "en-US"
//   }
//
// Keys starting with "_" (e.g. "_note") are metadata, not profiles, and are
// skipped by listProxyNames()/loadProxyProfiles().

const fs = require('fs');
const { PROXIES_FILE } = require('./paths');

function isMetaKey(key) {
  return key.startsWith('_');
}

// Reads and validates state/proxies.json fresh on every call (small file,
// no reason to cache and risk serving a stale profile after the operator edits
// it by hand). Missing file -> {} (no profiles configured), not an error:
// proxy support is fully optional and off by default.
function loadProxyProfiles() {
  let raw;
  try {
    raw = fs.readFileSync(PROXIES_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`cannot read proxy profiles at ${PROXIES_FILE}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`proxy profiles file is not valid JSON (${PROXIES_FILE}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`proxy profiles file must be a JSON object of name -> profile (${PROXIES_FILE})`);
  }
  const profiles = {};
  for (const [name, profile] of Object.entries(parsed)) {
    if (isMetaKey(name)) continue;
    if (!profile || typeof profile !== 'object' || typeof profile.server !== 'string' || !profile.server) {
      throw new Error(`proxy profile "${name}" is missing a string "server" field`);
    }
    profiles[name] = profile;
  }
  return profiles;
}

function listProxyNames() {
  return Object.keys(loadProxyProfiles());
}

// Throws with a clear, name-the-options error if the profile does not
// exist - the CLI/HTTP layer surfaces this straight to the caller rather
// than silently falling back to "off".
function getProxyProfile(name) {
  const profiles = loadProxyProfiles();
  if (!Object.prototype.hasOwnProperty.call(profiles, name)) {
    const known = Object.keys(profiles);
    throw new Error(
      `unknown proxy profile "${name}"` +
      (known.length ? ` - known profiles: ${known.join(', ')}` : ` - state/proxies.json has no profiles configured`)
    );
  }
  return profiles[name];
}

// Builds the Playwright `proxy` newContext/launch option from a profile,
// or undefined for no profile - Playwright's own contract is that omitting
// `proxy` entirely means "no proxy", so this never passes an empty object.
function playwrightProxyOption(profile) {
  if (!profile) return undefined;
  const opt = { server: profile.server };
  if (profile.username) opt.username = profile.username;
  if (profile.password) opt.password = profile.password;
  return opt;
}

module.exports = { loadProxyProfiles, listProxyNames, getProxyProfile, playwrightProxyOption };
