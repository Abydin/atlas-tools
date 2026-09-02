'use strict';

// SECURITY (t-350 hardening, HOLE 3): bearer-token auth for the HTTP API.
// Generated on first start, written 0600 under state/ (see paths.js
// TOKEN_PATH), printed once on startup, read by cli.js from the same file.
// This is defence in depth BEHIND the Host-header allowlist and Origin
// rejection in server.js, not a replacement for them: those two stop a
// hostile web page from ever reaching this API in the first place; this
// stops any OTHER local process (or a page that somehow got past the Host
// check) from driving the browser without the token.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TOKEN_PATH } = require('./paths');

function loadOrCreateToken() {
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch (_) {
    // no token file yet, fall through and create one
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch (_) {}
  return token;
}

// Constant-time compare so a caller cannot learn the token byte-by-byte
// via response-timing. Buffer length differs -> not equal, without ever
// comparing the (attacker-controlled) supplied value byte-for-byte against
// the real token using a short-circuiting ===.
function safeTokenEqual(supplied, real) {
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(String(real || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { loadOrCreateToken, safeTokenEqual };
