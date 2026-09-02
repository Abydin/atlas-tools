'use strict';

// SECURITY (t-355): short-lived, session-scoped bearer tokens.
//
// The master TOKEN (lib/auth.js) grants FULL browser control forever: open
// new sessions, drive any session, upload files from the operator's disk, escalate,
// close. That is correct for the local CLI and cockpit, which read it from a
// 0600 file. It is catastrophic in a URL pushed over the PUBLIC ntfy relay
// (lib/ntfy.js default = https://ntfy.sh with an in-repo topic name): anyone
// who reads that topic would hold that credential forever (this was the
// original, honestly-flagged widening this module closes).
//
// A scoped token is the fix. It is minted ONLY by the server process, in
// memory, bound to ONE session id, and it self-destructs after a few minutes.
// The server's auth path (server.js) accepts it in place of the master token
// for EXACTLY the /live takeover surface of its own session and nothing else
// (see allows() below). So the worst a topic-reader can now do is drive that
// one captcha page for a few minutes, not seize the whole browser forever.
// This does not make the public topic safe on its own - setting a private
// ATLAS_NTFY_TOPIC still closes the "who reads this channel" gap properly -
// but it bounds the blast radius to something survivable regardless.
//
// In-memory (a module-level Map, one instance per process) is deliberate: the
// only minter and the only validator are both the single server process, so
// there is no cross-process store to race on and nothing to persist across a
// restart (a restart invalidating every outstanding scoped link is the safe
// direction). The runner mints via POST /scoped-tokens (server.js), not by
// touching this module directly.

const crypto = require('crypto');

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min - long enough to walk to a phone and solve a captcha
const MAX_TTL_MS = 60 * 60 * 1000; // hard ceiling a caller cannot exceed

const store = new Map(); // token -> { sessionId, exp }

function prune(now) {
  for (const [t, e] of store) {
    if (e.exp <= now) store.delete(t);
  }
}

// Mint a token bound to `sessionId`, valid for `ttlMs` (clamped to MAX_TTL_MS,
// defaulted when absent/invalid). Returns { token, exp }.
function mint(sessionId, ttlMs) {
  const now = Date.now();
  prune(now);
  const ttl = Math.min(
    Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS,
    MAX_TTL_MS,
  );
  const token = crypto.randomBytes(24).toString('hex');
  const exp = now + ttl;
  store.set(token, { sessionId, exp });
  return { token, exp };
}

// Return { sessionId, exp } for a live token, or null if unknown/expired.
// Expired tokens are dropped on read so the store self-cleans even without
// a mint call to trigger prune().
function resolve(token) {
  if (!token) return null;
  const e = store.get(token);
  if (!e) return null;
  if (e.exp <= Date.now()) {
    store.delete(token);
    return null;
  }
  return { sessionId: e.sessionId, exp: e.exp };
}

// The ONLY requests a scoped token may authorize, and only for its own
// session: the /live takeover page + the endpoints that page (and the /view
// fallback) drive. Everything else - open, close, upload, proxy, listing,
// ANY other session - requires the master token. Kept here (not inline in
// server.js) so it is unit-testable in isolation.
//
// Note: /live drives entirely over the WebSocket (/sessions/:id/live), which
// is authorized separately in server.js validateUpgrade(); this covers the
// HTTP surface: the page GETs and the /view fallback's screenshot/input/meta.
function allows(scope, method, pathname, searchParams) {
  if (!scope || !scope.sessionId) return false;

  // The takeover pages themselves: only when their ?session= is the bound one.
  if ((pathname === '/live' || pathname === '/view') && method === 'GET') {
    return searchParams.get('session') === scope.sessionId;
  }

  // Per-session endpoints, for THIS session only.
  const m = pathname.match(/^\/sessions\/([a-z0-9]+)(?:\/(screenshot|input))?$/);
  if (!m || m[1] !== scope.sessionId) return false;
  const sub = m[2];
  if (method === 'GET' && (sub === undefined || sub === 'screenshot')) return true; // meta poll + img frame
  if (method === 'POST' && sub === 'input') return true; // /view fallback input relay
  return false;
}

module.exports = { mint, resolve, allows, DEFAULT_TTL_MS, MAX_TTL_MS };
