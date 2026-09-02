#!/usr/bin/env node
'use strict';

// Thin CLI over the atlas-browser HTTP API. Modeled on the ergonomics of
// scripts/desktop/desktop: one verb, JSON in, JSON out on stdout, non-zero
// exit with an "error" field on failure. This process only talks HTTP to
// 127.0.0.1 - it never touches the OS desktop, never shells out.
//
// Requires the server to already be running: ./start.sh
//
// Every action operates on a SESSION (a tab), attributed to a god. Set
// --god (default: atlas) and this CLI reuses that god's most recently
// opened session automatically, or pass --session <id> to target a
// specific one explicitly (useful when one god has several open at once).
//
// USAGE
//   node cli.js status
//   node cli.js sessions                       # list all active sessions
//   node cli.js open <url> [--god NAME] [--label L] [--session ID]
//   node cli.js read [--session ID]
//   node cli.js click <selector> [--session ID]
//   node cli.js type <selector> <text> [--enter] [--session ID]
//   node cli.js fill <selector> <value> [--session ID]
//   node cli.js upload <selector> <filePath> [--session ID]
//                                               # filePath MUST resolve inside state/uploads/
//   node cli.js stage-file <path>
//                                               # copies a local file into state/uploads/ for upload
//   node cli.js form-scan [--session ID]        # structured description of every field on the page
//   node cli.js form-set <ref> <value> [--session ID]
//                                               # ref comes from form-scan; handles text, select,
//                                               # checkbox, radio, and non-native comboboxes
//   node cli.js form-values [--session ID]      # read back what is currently in the fields
//   node cli.js form-submit <ref> [--wait MS] [--session ID]
//                                               # clicks and returns the resulting page, for confirmation
//   node cli.js close-session [--session ID]
//   node cli.js save-state
//   node cli.js watch on|off                   # headless:false / headless:true, ALL sessions
//   node cli.js proxy <name|off>                # switch the whole shared context to a named
//                                               # proxy/VPN exit profile (state/proxies.json),
//                                               # or back to a direct connection. DISCOVERY
//                                               # ONLY - see README "Proxy / VPN exit profiles";
//                                               # useful to keep egress geography consistent.
//   node cli.js proxy-check [--session ID]      # fetches api.ipify.org through a session to
//                                               # show the IP this context is ACTUALLY egressing
//                                               # as right now - the proof a proxy switch worked
//   node cli.js view                           # prints the low-tech screenshot fallback URL
//   node cli.js live                           # prints the interactive URL (CDP screencast + real drag)
//   node cli.js escalate <reason> [--detail D] [--timeout MS] [--session ID]
//                                               # BLOCKS until answered/taken-over/timed-out
//   node cli.js escalations                    # list all escalations
//   node cli.js answer <escalationId> <text>
//   node cli.js takeover <escalationId>

const http = require('http');
const fs = require('fs');
const nodePath = require('path');
const os = require('os');
// Same source lib/atlas-browser.js and server.js use, so this CLI
// automatically follows ATLAS_BROWSER_STATE_DIR too (a test harness or a
// non-default state dir would otherwise silently read the wrong token/
// staging dir - an Athena review caught this drifting from paths.js).
const { TOKEN_PATH, UPLOADS_DIR } = require('./lib/paths');
const { resolvePublicHost } = require('./lib/network');

const PORT = Number(process.env.ATLAS_BROWSER_PORT || 8781);
// This CLI always TALKS to the server over loopback - it runs ON the same
// Mac the service does, so HOST here stays 127.0.0.1 regardless of
// PUBLIC_HOST below. PUBLIC_HOST is a separate concern: what hostname to
// PRINT in the view/live URL so a phone (which is NOT on this Mac) can
// actually reach it. See lib/network.js.
const HOST = '127.0.0.1';

// SECURITY: every endpoint requires the bearer token (see lib/auth.js,
// server.js). This CLI reads it from the same file the server wrote it to
// on first start - it never generates or guesses one itself.
let _token;
function getToken() {
  if (_token) return _token;
  try {
    _token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch (err) {
    fail(`missing bearer token at ${TOKEN_PATH} - start the server first (./start.sh)`);
  }
  return _token;
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    headers['Authorization'] = `Bearer ${getToken()}`;
    const r = http.request(
      { host: HOST, port: PORT, path, method, headers },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(out) });
          } catch (e) {
            resolve({ status: res.statusCode, body: out });
          }
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function fail(msg) {
  console.log(JSON.stringify({ error: msg }, null, 2));
  process.exit(1);
}

// Pulls --flag value / --flag (boolean) pairs out of argv, returns
// { flags, positional } so each command can read what it needs.
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// Resolves which session to act on: explicit --session wins; otherwise
// reuse the named god's most recently opened session; otherwise open a
// fresh one for that god (default god: "atlas").
async function resolveSessionId(flags) {
  if (flags.session) return flags.session;
  const god = flags.god || 'atlas';
  const list = await req('GET', '/sessions');
  const mine = (list.body.sessions || []).filter((s) => s.god === god);
  if (mine.length) return mine[mine.length - 1].id;
  const created = await req('POST', '/sessions', { god, label: flags.label });
  if (created.status >= 400) fail(created.body.error || 'failed to open session');
  return created.body.id;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  if (!cmd) fail('missing command. see cli.js header for usage.');

  let result;
  switch (cmd) {
    case 'status':
      result = await req('GET', '/status');
      break;

    case 'sessions':
      result = await req('GET', '/sessions');
      break;

    case 'open': {
      if (!rest[0]) fail('usage: open <url> [--god NAME] [--label L] [--session ID]');
      const id = await resolveSessionId(flags);
      result = await req('POST', `/sessions/${id}/open`, { url: rest[0] });
      result.body = { sessionId: id, ...result.body };
      break;
    }

    case 'read': {
      const id = await resolveSessionId(flags);
      result = await req('GET', `/sessions/${id}/read`);
      break;
    }

    case 'click': {
      if (!rest[0]) fail('usage: click <selector> [--session ID]');
      const id = await resolveSessionId(flags);
      result = await req('POST', `/sessions/${id}/click`, { selector: rest[0] });
      break;
    }

    case 'type': {
      if (!rest[0] || rest[1] === undefined) fail('usage: type <selector> <text> [--enter] [--session ID]');
      const id = await resolveSessionId(flags);
      result = await req('POST', `/sessions/${id}/type`, { selector: rest[0], text: rest[1], enter: !!flags.enter });
      break;
    }

    case 'fill': {
      if (!rest[0] || rest[1] === undefined) fail('usage: fill <selector> <value> [--session ID]');
      const id = await resolveSessionId(flags);
      result = await req('POST', `/sessions/${id}/fill`, { selector: rest[0], value: rest[1] });
      break;
    }

    case 'upload': {
      if (!rest[0] || !rest[1]) fail('usage: upload <selector> <filePath> [--session ID]');
      const id = await resolveSessionId(flags);
      result = await req('POST', `/sessions/${id}/upload`, { selector: rest[0], path: rest[1] });
      break;
    }

    case 'form-scan': {
      const id = await resolveSessionId(flags);
      result = await req('GET', `/sessions/${id}/form-scan`);
      break;
    }

    case 'form-set': {
      if (!rest[0] || rest[1] === undefined) fail('usage: form-set <ref> <value> [--session ID]');
      const id = await resolveSessionId(flags);
      result = await req('POST', `/sessions/${id}/form-set`, { ref: rest[0], value: rest[1] });
      break;
    }

    case 'form-values': {
      const id = await resolveSessionId(flags);
      result = await req('GET', `/sessions/${id}/form-values`);
      break;
    }

    case 'form-submit': {
      if (!rest[0]) fail('usage: form-submit <ref> [--wait MS] [--session ID]');
      const id = await resolveSessionId(flags);
      result = await req('POST', `/sessions/${id}/form-submit`, { ref: rest[0], waitMs: flags.wait ? Number(flags.wait) : undefined });
      break;
    }

    case 'close-session': {
      const id = await resolveSessionId(flags);
      result = await req('POST', `/sessions/${id}/close`);
      break;
    }

    case 'save-state':
      result = await req('POST', '/save-state');
      break;

    case 'watch':
      if (rest[0] !== 'on' && rest[0] !== 'off') fail('usage: watch on|off');
      result = await req('POST', '/watch', { headless: rest[0] === 'off' });
      break;

    case 'proxy': {
      if (!rest[0]) fail('usage: proxy <name|off>');
      const profile = rest[0] === 'off' ? null : rest[0];
      result = await req('POST', '/proxy', { profile });
      break;
    }

    case 'proxy-check': {
      const params = new URLSearchParams();
      if (flags.session) params.set('session', flags.session);
      const qs = params.toString();
      result = await req('GET', `/proxy-check${qs ? `?${qs}` : ''}`);
      break;
    }

    case 'view': {
      const id = flags.session || null;
      const params = new URLSearchParams();
      if (id) params.set('session', id);
      params.set('token', getToken()); // a top-level page load can't set an Authorization header
      // PUBLIC_HOST (a mesh-VPN hostname, when configured - see
      // lib/network.js) so this link works from another device, not just
      // from a browser on this machine. Falls back to 127.0.0.1 unchanged.
      console.log(JSON.stringify({ url: `http://${resolvePublicHost()}:${PORT}/view?${params.toString()}` }, null, 2));
      return;
    }

    case 'live': {
      // The interactive takeover surface (CDP screencast + real drag), the one
      // to hand a human for a captcha. /view remains the low-tech fallback.
      const id = flags.session || null;
      const params = new URLSearchParams();
      if (id) params.set('session', id);
      params.set('token', getToken()); // a top-level page load can't set an Authorization header
      console.log(JSON.stringify({ url: `http://${resolvePublicHost()}:${PORT}/live?${params.toString()}` }, null, 2));
      return;
    }

    case 'stage-file': {
      // Sanctioned way to get a local file into the upload staging dir:
      // a plain fs copy, confined to state/uploads/, never exposed over
      // the HTTP API directly.
      const src = rest[0];
      if (!src) fail('usage: stage-file <path>');
      const resolvedSrc = nodePath.resolve(src);
      if (!fs.existsSync(resolvedSrc)) fail(`no such file: ${resolvedSrc}`);
      // Refuse a symlinked source: lstatSync does not follow the link, so
      // this checks the thing at the path itself, not whatever it points to.
      if (fs.lstatSync(resolvedSrc).isSymbolicLink()) {
        fail(`refusing to stage a symlinked source: ${resolvedSrc}`);
      }
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const dest = nodePath.join(UPLOADS_DIR, nodePath.basename(resolvedSrc));
      fs.copyFileSync(resolvedSrc, dest);
      console.log(JSON.stringify({ staged: dest }, null, 2));
      return;
    }

    case 'escalate': {
      if (!rest[0]) fail('usage: escalate <reason> [--detail D] [--timeout MS] [--session ID]');
      const id = await resolveSessionId(flags);
      result = await req('POST', '/escalate', {
        sessionId: id,
        reason: rest[0],
        details: flags.detail,
        timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
      });
      break;
    }

    case 'escalations':
      result = await req('GET', '/escalations');
      break;

    case 'answer':
      if (!rest[0] || rest[1] === undefined) fail('usage: answer <escalationId> <text>');
      result = await req('POST', `/escalations/${rest[0]}/answer`, { answer: rest[1] });
      break;

    case 'takeover':
      if (!rest[0]) fail('usage: takeover <escalationId>');
      result = await req('POST', `/escalations/${rest[0]}/takeover`);
      break;

    default:
      fail(`unknown command: ${cmd}`);
  }

  console.log(JSON.stringify(result.body, null, 2));
  if (result.status >= 400) process.exit(1);
}

main().catch((err) => fail(String((err && err.message) || err)));
