'use strict';

// Remote-access host resolution for the /live takeover surface, so a phone
// on the operator's Tailscale (not just a browser ON this Mac) can reach it.
//
// Deliberately NOT auto-detected by shelling out to the `tailscale` binary -
// this directory's "no child_process anywhere" invariant is absolute (see
// server.js header, lib/ntfy.js). Both values below are instead read from
// small plain-text config files under state/, written once by hand (or by
// whatever set this Mac up) and read fresh on every call - if the Tailscale
// DNS name or IP ever changes (re-auth, a different tailnet), update the
// file (or set the matching env var) and nothing else needs to change.
//
// Resolution order for BOTH: explicit env var first, then the state file,
// then a safe localhost-only default that reproduces the exact behavior
// this code had before this feature existed.

const fs = require('fs');
const { PUBLIC_HOST_FILE, TAILSCALE_IP_FILE } = require('./paths');

function readFirstLine(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const line = raw.split('\n').map((s) => s.trim()).find(Boolean);
    return line || null;
  } catch (_) {
    return null; // file missing/unreadable - caller falls back
  }
}

// Hostname to print/push in emitted /live (and /view) URLs. Does NOT affect
// what the server binds to - see resolveBindIp() for that, and server.js's
// SECURITY comment at the listen() calls for why they are two separate
// questions.
function resolvePublicHost() {
  const envHost = (process.env.ATLAS_BROWSER_PUBLIC_HOST || '').trim();
  if (envHost) return envHost;
  return readFirstLine(PUBLIC_HOST_FILE) || '127.0.0.1';
}

// Extra IP the server additionally binds to (in ADDITION to 127.0.0.1,
// never instead of it). Returns null when unset, which means "no extra
// bind, loopback-only" - the safe default this whole feature opts INTO
// rather than assumes. See server.js for the token + Host-allowlist fence
// that makes binding this one specific interface acceptable.
function resolveBindIp() {
  const envIp = (process.env.ATLAS_BROWSER_TAILSCALE_IP || '').trim();
  if (envIp) return envIp;
  return readFirstLine(TAILSCALE_IP_FILE);
}

// Builds the /live URL a human taps. `token` is optional and omitted by
// default by callers that push over an unauthenticated relay (ntfy) - see
// server.js viewUrlFor()'s own comment for why. Callers that build a link
// for the operator to copy off the Mac himself (cli.js) pass the token.
function buildLiveUrl({ port, sessionId, token } = {}) {
  const host = resolvePublicHost();
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  if (token) params.set('token', token);
  const qs = params.toString();
  return `http://${host}:${port}/live${qs ? `?${qs}` : ''}`;
}

module.exports = { resolvePublicHost, resolveBindIp, buildLiveUrl };
