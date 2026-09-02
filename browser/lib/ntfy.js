'use strict';

// Push-notification sender for browser-session escalations. Mirrors the
// existing ntfy channel already used by scripts/morning_brief.sh and
// cockpit/lib/alerts.ts (same ATLAS_NTFY_URL / ATLAS_NTFY_TOPIC env vars).
//
// Gating, and the bug this replaced: an EMPTY url or topic means "log only,
// never touch the network". The previous version claimed that meant tests
// could never spam the live channel, which was false. The gate only tripped
// when the env var was explicitly set to "", and an UNSET var fell through
// to the hardcoded live topic, which is the normal case. On 2026-07-21 that
// sent roughly 35 real pushes to the operator's phone from the smoke suite,
// including "test: nobody will answer this one". Tests must never page a
// human. ATLAS_NTFY_TEST_MODE=1 now hard-disables delivery regardless of
// any other setting, and test/smoke.js sets it.
//
// Deliberately uses Node's built-in `https`/`http` module rather
// than shelling out to curl (unlike the existing Python/TS callers) to
// keep this whole directory's "no child_process anywhere" invariant
// literally true and grep-able - see README.md "Security scoping".

const http = require('http');
const https = require('https');
const { URL } = require('url');

function send({ title, message, click, tags }) {
  return new Promise((resolve) => {
    // Hard kill-switch, checked before anything else so no combination of
    // other settings can defeat it. This is what makes "tests never page a
    // human" an actual property rather than a comment.
    if ((process.env.ATLAS_NTFY_TEST_MODE || '').trim() === '1') {
      return resolve({ delivered: false, reason: 'test-mode (ATLAS_NTFY_TEST_MODE=1)' });
    }

    const url = (process.env.ATLAS_NTFY_URL || 'https://ntfy.sh').trim().replace(/\/+$/, '');
    const topic = (process.env.ATLAS_NTFY_TOPIC || '').trim();
    if (!url || !topic) {
      // eslint-disable-next-line no-console
      console.error('[ntfy] ATLAS_NTFY_TOPIC (or ATLAS_NTFY_URL) is unset - notification NOT sent. Set ATLAS_NTFY_TOPIC to your own private ntfy topic; see README.md.');
      return resolve({ delivered: false, reason: 'null-gated (no ATLAS_NTFY_URL/ATLAS_NTFY_TOPIC)' });
    }

    let target;
    try {
      target = new URL(`${url}/${topic}`);
    } catch (err) {
      return resolve({ delivered: false, reason: `bad ntfy URL: ${err.message}` });
    }

    const mod = target.protocol === 'http:' ? http : https;
    const body = Buffer.from(message, 'utf8');
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
    };
    if (title) headers['Title'] = title;
    if (tags) headers['Tags'] = tags;
    if (click) headers['Click'] = click;

    const req = mod.request(
      target,
      { method: 'POST', headers, timeout: 10000 },
      (res) => {
        res.resume(); // drain, we don't need the body
        resolve({ delivered: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ delivered: false, reason: 'timeout' }); });
    req.on('error', (err) => resolve({ delivered: false, reason: err.message }));
    req.write(body);
    req.end();
  });
}

module.exports = { send };
