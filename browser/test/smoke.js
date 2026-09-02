'use strict';

// Smoke test for the Atlas browser service. Exercises the same HTTP API
// the CLI uses: multi-session (multiple gods, multiple tabs, one shared
// context), open a real page, read text, fill a field, upload a file via
// setInputFiles, save/reload storageState, the escalation pause/answer/
// timeout flow, and the headed/headless toggle. Requires the server NOT
// already running on the test port (it starts and stops its own).
//
// Run: node test/smoke.js

// Tests must never page a human. Set BEFORE anything is required, so the
// spawned server process inherits it too. Without this the escalation tests
// below push real notifications to the operator's phone, which they did about 35
// times on 2026-07-21 with gems like "test: nobody will answer this one".
// See lib/ntfy.js for why the previous env-var-only gate did not hold.
process.env.ATLAS_NTFY_TEST_MODE = '1';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 8782; // separate from the default 8781 so this never collides
                    // with a real running instance.
const HOST = '127.0.0.1';

// Set once the server's token file appears (see main(), before
// waitForServer). `req()` is the normal authenticated helper every
// existing test uses; `rawReq()` lets the new hardening tests below send
// deliberately WRONG headers (no token, spoofed Host, an Origin header).
let TOKEN = null;

function rawReq(method, p, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = Object.assign(
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      extraHeaders || {}
    );
    const r = http.request(
      { host: HOST, port: PORT, path: p, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if ((res.headers['content-type'] || '').includes('application/json')) {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(buf.toString('utf8')) });
            } catch (e) {
              resolve({ status: res.statusCode, body: buf.toString('utf8') });
            }
          } else {
            resolve({ status: res.statusCode, buf });
          }
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function req(method, p, body) {
  return rawReq(method, p, body, TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {});
}

function waitForServer(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await req('GET', '/status');
        if (r.status === 200) return resolve();
      } catch (_) {}
      if (Date.now() - start > timeoutMs) return reject(new Error('server did not come up in time'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

// Serves the test fixture page over a REAL local http:// origin. This used
// to be a data:text/html,... URL, but HOLE 1's fix (lib/url-guard.js)
// correctly rejects data: along with file:/javascript:/etc, so the test's
// own fixture had to move to an allowed scheme rather than carve out an
// exception for it.
function startFixtureServer() {
  const html = `
    <html><head><title>Atlas Browser Smoke Test</title></head><body>
      <h1>Atlas Browser Smoke Test</h1>
      <input id="name" type="text">
      <input id="resume" type="file">
    </body></html>
  `;
  return new Promise((resolve) => {
    const srv = http.createServer((req2, res2) => {
      res2.writeHead(200, { 'Content-Type': 'text/html' });
      res2.end(html);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}

async function main() {
  const serverPath = path.join(__dirname, '..', 'server.js');
  // Isolated scratch state dir so this test run can never touch or clobber
  // a real logged-in profile / storageState.json.
  const scratchState = path.join(__dirname, '.scratch-state');
  const scratchArtifacts = path.join(__dirname, '.scratch-artifacts');
  const scratchEscalations = path.join(__dirname, '.scratch-escalations.jsonl');
  fs.rmSync(scratchState, { recursive: true, force: true });
  fs.rmSync(scratchArtifacts, { recursive: true, force: true });
  fs.rmSync(scratchEscalations, { force: true });
  const fixtureServer = await startFixtureServer();
  const fixturePort = fixtureServer.address().port;

  // Proxy/VPN support (Job Hunt v2, see lib/proxies.js): seed the scratch
  // state dir with a config the server will read fresh once we start
  // calling /proxy. "dead" resolves to nothing on purpose (.invalid is an
  // RFC 2606 reserved TLD, guaranteed never to resolve) - it is the
  // negative-proof profile: no real proxy exists in this environment, so
  // the thing we CAN prove is that a bad proxy makes page loads fail,
  // which is real proof traffic is routed through it rather than ignored.
  fs.mkdirSync(scratchState, { recursive: true });
  fs.writeFileSync(
    path.join(scratchState, 'proxies.json'),
    JSON.stringify({
      dead: {
        server: 'socks5://proxy-does-not-exist.invalid:1080',
        timezoneId: 'America/New_York',
        geolocation: { latitude: 40.7128, longitude: -74.006 },
        locale: 'en-US',
      },
    })
  );

  const child = spawn(process.execPath, [serverPath, String(PORT)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ATLAS_BROWSER_STATE_DIR: scratchState,
      ATLAS_BROWSER_ARTIFACTS_DIR: scratchArtifacts,
      ATLAS_BROWSER_ESCALATIONS_LOG: scratchEscalations,
      // null-gate the real ntfy push so this test never touches the live
      // channel (same discipline as atlas_supervisor.py's test suite).
      ATLAS_NTFY_URL: '',
      ATLAS_NTFY_TOPIC: '',
      // HOLE 5 (host guard, t-350): this suite's OWN fixture server below
      // is deliberately served over a real http://127.0.0.1:<port> origin
      // (see the comment on startFixtureServer() - that used to be a
      // data: URL until HOLE 1 ruled data: out). Loopback is now denied by
      // default by lib/host-guard.js, so this main() child needs the
      // documented escape hatch to keep navigating to its own fixture page
      // for the fill/upload/screenshot tests below - this is exactly the
      // "Atlas legitimately pointing the browser at a known local target it
      // controls" case the escape hatch exists for, not a workaround around
      // it. The ACTUAL denylist-blocking behavior (default deny, no escape
      // hatch) is proven end-to-end against a separate, freshly spawned
      // server in hostGuardEndToEnd() below, so this env var here does not
      // paper over HOLE 5 - it just keeps this unrelated, pre-existing test
      // flow working under the new default.
      ATLAS_BROWSER_ALLOW_INTERNAL: '1',
    },
  });

  try {
    // The server writes state/token synchronously at startup, before it
    // ever starts listening (see lib/auth.js loadOrCreateToken()). Every
    // endpoint including /status now requires it, so we must read it
    // BEFORE the first request, not after waitForServer succeeds.
    const tokenPath = path.join(scratchState, 'token');
    const tokenWaitStart = Date.now();
    while (!fs.existsSync(tokenPath)) {
      if (Date.now() - tokenWaitStart > 20000) throw new Error('token file never appeared at ' + tokenPath);
      await new Promise((r) => setTimeout(r, 100));
    }
    TOKEN = fs.readFileSync(tokenPath, 'utf8').trim();
    check('server wrote a non-empty bearer token on startup', TOKEN.length >= 32, TOKEN);

    await waitForServer(20000);

    // 1. status shows headless true by default, no sessions yet
    const s1 = await req('GET', '/status');
    check('starts headless by default', s1.body.headless === true, JSON.stringify(s1.body));
    check('starts with zero sessions', s1.body.sessions.length === 0, JSON.stringify(s1.body));

    // 2. multi-session: two DIFFERENT gods each open their own session,
    // proving they get independent tabs rather than fighting over one page.
    const hermesSession = await req('POST', '/sessions', { god: 'hermes', label: 'research' });
    check('hermes opens a session', hermesSession.status === 200 && hermesSession.body.god === 'hermes', JSON.stringify(hermesSession.body));

    const athenaSession = await req('POST', '/sessions', { god: 'athena', label: 'review' });
    check('athena opens a DIFFERENT session', athenaSession.status === 200 && athenaSession.body.id !== hermesSession.body.id, JSON.stringify(athenaSession.body));

    const listed = await req('GET', '/sessions');
    check('both sessions are independently listed', listed.body.sessions.length === 2, JSON.stringify(listed.body));

    const hermesId = hermesSession.body.id;
    const athenaId = athenaSession.body.id;

    // hermes navigates its tab...
    await req('POST', `/sessions/${hermesId}/open`, { url: 'https://example.com' });
    // ...while athena's tab independently goes somewhere else entirely.
    const testHtml = `http://127.0.0.1:${fixturePort}/test.html`;
    await req('POST', `/sessions/${athenaId}/open`, { url: testHtml });

    const hermesRead = await req('GET', `/sessions/${hermesId}/read`);
    const athenaRead = await req('GET', `/sessions/${athenaId}/read`);
    check('hermes session shows the real remote page (not athena\'s)', hermesRead.body.text.includes('Example Domain'), hermesRead.body.text);
    check('athena session shows its own page (not hermes\'s), proving no cross-talk', athenaRead.body.text.includes('Atlas Browser Smoke Test'), athenaRead.body.text);

    // 3. fill a text field on athena's session
    const f = await req('POST', `/sessions/${athenaId}/fill`, { selector: '#name', value: 'the operator' });
    check('fill() succeeds', f.status === 200, JSON.stringify(f.body));

    // 4. upload a real file via setInputFiles on athena's session. Must be
    // staged inside state/uploads/ - HOLE 4 fix confines upload() strictly
    // to that dir. Negative cases (outside the dir, via a symlink) are
    // covered further down, after the escalation flow.
    const stagingDir = path.join(scratchState, 'uploads');
    fs.mkdirSync(stagingDir, { recursive: true });
    const fixturePath = path.join(stagingDir, 'fixture.txt');
    fs.writeFileSync(fixturePath, 'test resume content');
    const u = await req('POST', `/sessions/${athenaId}/upload`, { selector: '#resume', path: fixturePath });
    check('upload() via setInputFiles succeeds', u.status === 200, JSON.stringify(u.body));

    // 5. screenshot returns PNG bytes, scoped to a specific session
    const shotRes = await req('GET', `/sessions/${athenaId}/screenshot`);
    check('screenshot() returns a PNG', shotRes.buf && shotRes.buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a', 'bad PNG header');

    // 6. save storageState (context-level, shared across all sessions), confirm file exists
    const save = await req('POST', '/save-state');
    const statePath = path.join(scratchState, 'storageState.json');
    check('save-state() writes storageState.json', save.status === 200 && fs.existsSync(statePath), JSON.stringify(save.body));

    // 7. escalation: answer path. /escalate BLOCKS (proves the session pauses
    // live rather than tearing down) until /escalations/:id/answer resolves it.
    const escalatePromise = req('POST', '/escalate', {
      sessionId: hermesId,
      reason: 'needs-human-answer',
      details: 'test: what is your favorite number?',
      timeoutMs: 15000,
    });
    // give the server a moment to register the pending escalation before answering
    await new Promise((r) => setTimeout(r, 500));
    const listPending = await req('GET', '/escalations');
    const pendingRec = listPending.body.escalations.find((e) => e.sessionId === hermesId && e.status === 'PENDING');
    check('escalation is durably recorded while pending', !!pendingRec, JSON.stringify(listPending.body));

    const answerResult = await req('POST', `/escalations/${pendingRec.id}/answer`, { answer: '42' });
    check('answer() resolves the pending escalation', answerResult.status === 200, JSON.stringify(answerResult.body));

    const escalateResolved = await escalatePromise; // now unblocks
    check('escalate() unblocks with the human\'s answer', escalateResolved.body.outcome === 'answered' && escalateResolved.body.answer === '42', JSON.stringify(escalateResolved.body));

    // the hermes session must still be alive and on the SAME page throughout
    const hermesStillThere = await req('GET', `/sessions/${hermesId}`);
    check('the escalated session stayed alive with state intact (not torn down)', hermesStillThere.body.url && hermesStillThere.body.url.includes('example.com'), JSON.stringify(hermesStillThere.body));

    // 8. escalation: timeout path. A short timeout with nobody answering must
    // resolve to {outcome:'timeout'} and record NEEDS_HUMAN, never hang.
    const timeoutEscalation = await req('POST', '/escalate', {
      sessionId: athenaId,
      reason: 'captcha',
      details: 'test: nobody will answer this one',
      timeoutMs: 800,
    });
    check('escalate() times out rather than hanging forever', timeoutEscalation.body.outcome === 'timeout', JSON.stringify(timeoutEscalation.body));
    const afterTimeout = await req('GET', `/escalations/${timeoutEscalation.body.escalationId}`);
    check('timed-out escalation is recorded NEEDS_HUMAN', afterTimeout.body.status === 'NEEDS_HUMAN', JSON.stringify(afterTimeout.body));

    // 9. per-session artifacts are god-attributed (directory name carries the god)
    const hermesArtifacts = fs.readdirSync(scratchArtifacts).find((d) => d.includes('-hermes-'));
    const athenaArtifacts = fs.readdirSync(scratchArtifacts).find((d) => d.includes('-athena-'));
    check('hermes session artifacts are attributed to hermes', !!hermesArtifacts, fs.readdirSync(scratchArtifacts).join(', '));
    check('athena session artifacts are attributed to athena', !!athenaArtifacts, fs.readdirSync(scratchArtifacts).join(', '));

    // ---- t-350 hardening: HOLE 1, file:// (and sibling schemes) rejected ----
    const beforeFileAttempt = await req('GET', `/sessions/${hermesId}`);
    const fileOpen = await req('POST', `/sessions/${hermesId}/open`, { url: 'file:///etc/passwd' });
    check('HOLE 1: file:// navigation is rejected', fileOpen.status >= 400 && /protocol/i.test(fileOpen.body.error || ''), JSON.stringify(fileOpen.body));
    const afterFileAttempt = await req('GET', `/sessions/${hermesId}`);
    check('HOLE 1: session URL unchanged after a rejected file:// attempt', afterFileAttempt.body.url === beforeFileAttempt.body.url, JSON.stringify(afterFileAttempt.body));

    const jsOpen = await req('POST', `/sessions/${hermesId}/open`, { url: 'javascript:alert(1)' });
    check('HOLE 1: javascript: navigation is rejected', jsOpen.status >= 400 && /protocol/i.test(jsOpen.body.error || ''), JSON.stringify(jsOpen.body));

    // ---- t-350 hardening: HOLE 2, spoofed Host header (DNS rebinding) rejected ----
    const spoofedHost = await rawReq('GET', '/status', undefined, { Host: 'evil.example.com', Authorization: `Bearer ${TOKEN}` });
    check('HOLE 2: a spoofed Host header is rejected (403)', spoofedHost.status === 403, JSON.stringify(spoofedHost.body));
    const realHost = await rawReq('GET', '/status', undefined, { Host: `127.0.0.1:${PORT}`, Authorization: `Bearer ${TOKEN}` });
    check('HOLE 2: the real Host header still works (no regression)', realHost.status === 200, JSON.stringify(realHost.body));

    // ---- t-350 fifth finding: a request carrying an Origin header (localhost
    // drive-by from ANY page in ANY browser tab, not just DNS rebinding) is
    // rejected even when the Host header is perfectly correct ----
    const withOrigin = await rawReq('GET', '/status', undefined, { Origin: 'https://evil.example.com', Authorization: `Bearer ${TOKEN}` });
    check('FIFTH FINDING: a request carrying an Origin header is rejected (403) even with a correct Host', withOrigin.status === 403, JSON.stringify(withOrigin.body));

    // ---- t-350 hardening: HOLE 3, no bearer token = unauthorized ----
    const noAuth = await rawReq('GET', '/status', undefined, {});
    check('HOLE 3: a request with no bearer token is rejected (401)', noAuth.status === 401, JSON.stringify(noAuth.body));
    const wrongAuth = await rawReq('GET', '/status', undefined, { Authorization: 'Bearer not-the-real-token' });
    check('HOLE 3: a request with the WRONG bearer token is rejected (401)', wrongAuth.status === 401, JSON.stringify(wrongAuth.body));

    // ---- t-350 hardening: HOLE 4, upload() confined to state/uploads/ ----
    // outside the staging dir entirely (test/fixture.txt, plain file, not staged)
    const outsideFixturePath = path.join(__dirname, 'fixture.txt');
    fs.writeFileSync(outsideFixturePath, 'not a staged resume');
    const outsideUpload = await req('POST', `/sessions/${athenaId}/upload`, { selector: '#resume', path: outsideFixturePath });
    check('HOLE 4: upload outside the staging dir is rejected', outsideUpload.status >= 400 && /staging dir/i.test(outsideUpload.body.error || ''), JSON.stringify(outsideUpload.body));

    // a symlink PLANTED INSIDE the staging dir but pointing OUTSIDE it must
    // still be refused - this is the exact bypass a naive string-prefix
    // check on the unresolved path would miss.
    const outsideSecretDir = path.join(__dirname, '.scratch-outside');
    fs.mkdirSync(outsideSecretDir, { recursive: true });
    const outsideSecret = path.join(outsideSecretDir, 'secret.txt');
    fs.writeFileSync(outsideSecret, 'definitely not a resume');
    const symlinkPath = path.join(stagingDir, 'sneaky-link.txt');
    fs.rmSync(symlinkPath, { force: true });
    fs.symlinkSync(outsideSecret, symlinkPath);
    const symlinkUpload = await req('POST', `/sessions/${athenaId}/upload`, { selector: '#resume', path: symlinkPath });
    check('HOLE 4: a symlink inside the staging dir pointing outside it is rejected', symlinkUpload.status >= 400 && /staging dir/i.test(symlinkUpload.body.error || ''), JSON.stringify(symlinkUpload.body));

    // ---- Athena review fixes, 2026-07-21 ----
    // Blocker A: the escalation viewUrl must never carry the bearer token
    // (it goes out over ntfy, an unauthenticated public relay by default).
    const escForViewUrl = await req('POST', '/escalate', {
      sessionId: hermesId,
      reason: 'test: viewUrl must not leak the token',
      timeoutMs: 2000,
    });
    // don't answer it; let it time out, then inspect what was recorded
    const viewUrlRec = (await req('GET', '/escalations')).body.escalations.find((e) => e.sessionId === hermesId && e.reason === 'test: viewUrl must not leak the token');
    check('BLOCKER A: escalation viewUrl carries no bearer token', !!viewUrlRec && !!viewUrlRec.viewUrl && !viewUrlRec.viewUrl.includes(TOKEN), JSON.stringify(viewUrlRec));
    await escForViewUrl; // let the timeout settle before moving on

    // Blocker B: /view's own script must never splice a raw session id into
    // a JS string literal - it must only ever appear via JSON.stringify().
    // A hostile-looking id (one nextSessionId() could never produce, but
    // proves the template can't be broken out of) must render inert.
    const hostileId = "'-alert(1)-'";
    const viewRes = await rawReq('GET', `/view?session=${encodeURIComponent(hostileId)}&token=${encodeURIComponent(TOKEN)}`, undefined, {});
    const viewHtml = viewRes.buf ? viewRes.buf.toString('utf8') : String(viewRes.body);
    check('BLOCKER B: /view does not splice an unsanitized session id into a JS string literal', !viewHtml.includes(`'${hostileId}'`) && !viewHtml.includes(`/sessions/${hostileId}/`), viewHtml.slice(0, 400));
    // that held partly because the /view route's own regex filter dropped
    // the malformed id before it ever reached VIEW_HTML(). Separately prove
    // the JSON.stringify() embedding itself is correct for a REAL id (this
    // is the code path every legitimate session hits): the served page's
    // SESSION_ID constant must be the properly JSON-quoted hermes id, not
    // a raw splice.
    const realViewRes = await rawReq('GET', `/view?session=${encodeURIComponent(hermesId)}&token=${encodeURIComponent(TOKEN)}`, undefined, {});
    const realViewHtml = realViewRes.buf.toString('utf8');
    check('BLOCKER B: SESSION_ID is embedded via JSON.stringify() for a real session id', realViewHtml.includes(`const SESSION_ID = ${JSON.stringify(hermesId)};`), realViewHtml.slice(0, 600));

    // ---- Job Hunt v2: proxy/VPN support (lib/proxies.js, lib/atlas-browser.js setProxy/checkEgressIp) ----
    // Runs LAST in this shared instance: setProxy() relaunches the whole
    // context (same mechanism as /watch), which recreates every session
    // under a NEW id - anything above this point that still needed
    // hermesId/athenaId to resolve to a live session must run before here.

    // (a) config loads: an unknown profile name is rejected with a clear
    // error and the CURRENT (working) context is left untouched - proven
    // by status still reporting proxy: null right after the rejection.
    const unknownProxy = await req('POST', '/proxy', { profile: 'no-such-profile' });
    check('proxy: an unknown profile name is rejected (400)', unknownProxy.status === 400 && /unknown proxy profile/i.test(unknownProxy.body.error || ''), JSON.stringify(unknownProxy.body));
    const statusAfterUnknown = await req('GET', '/status');
    check('proxy: status still shows no active profile after a rejected switch', statusAfterUnknown.body.proxy && statusAfterUnknown.body.proxy.profile === null, JSON.stringify(statusAfterUnknown.body.proxy));

    // (b) baseline: with no proxy, proxy-check sees this machine's REAL IP.
    const directCheck = await req('GET', '/proxy-check');
    check('proxy: with no proxy active, proxy-check returns a real IP (no error)', directCheck.status === 200 && !!directCheck.body.ip && !directCheck.body.error, JSON.stringify(directCheck.body));
    const realIp = directCheck.body.ip;

    // (c) setProxy() relaunches cleanly under a configured-but-dead profile
    // (this is the "plumbing accepts a proxy profile and relaunches
    // without error" proof: the LAUNCH must succeed even though the proxy
    // server itself cannot be reached - Playwright only fails to CONNECT
    // through a dead proxy when a page actually navigates, not at launch).
    const switchToDead = await req('POST', '/proxy', { profile: 'dead' });
    check('proxy: setProxy() relaunches cleanly under a configured proxy profile', switchToDead.status === 200 && switchToDead.body.changed === true && switchToDead.body.proxyProfile === 'dead', JSON.stringify(switchToDead.body));
    check('proxy: the resolved server string from the profile is reported back', switchToDead.body.server === 'socks5://proxy-does-not-exist.invalid:1080', JSON.stringify(switchToDead.body));

    // (d) the actual proof a proxy is really in the path, not silently
    // ignored: the SAME egress check that returned a real IP a moment ago
    // (b) now FAILS to load api.ipify.org at all, because the dead proxy
    // is genuinely in front of every request from this context.
    check('proxy: a dead proxy makes the egress-check page load FAIL (proof the proxy is in the path)', !!switchToDead.body.egressCheck && !!switchToDead.body.egressCheck.error, JSON.stringify(switchToDead.body.egressCheck));

    const statusUnderDeadProxy = await req('GET', '/status');
    check('proxy: status reflects the active profile + last (failed) egress check', statusUnderDeadProxy.body.proxy.profile === 'dead' && !!statusUnderDeadProxy.body.proxy.lastEgressCheck.error, JSON.stringify(statusUnderDeadProxy.body.proxy));
    check('proxy: status never leaks a username/password field', JSON.stringify(statusUnderDeadProxy.body.proxy).indexOf('password') === -1, JSON.stringify(statusUnderDeadProxy.body.proxy));

    // an explicit /proxy-check call under the dead proxy fails the same way
    // (502, not a silent success) - the standalone verb, not just the
    // switch's own bundled check.
    const deadProxyCheck = await req('GET', '/proxy-check');
    check('proxy: a standalone proxy-check under a dead proxy also fails (502)', deadProxyCheck.status === 502, JSON.stringify(deadProxyCheck.body));

    // (e) switching back to off restores a real, working direct connection
    // and reports the SAME real IP as the (b) baseline - proving "off"
    // really means direct, not just "profile name cleared".
    const switchOff = await req('POST', '/proxy', { profile: 'off' });
    check('proxy: switching back to off relaunches direct and confirms a real IP again', switchOff.status === 200 && switchOff.body.proxyProfile === null && switchOff.body.egressCheck && switchOff.body.egressCheck.ip === realIp, JSON.stringify(switchOff.body));

    // (f) sessions survive a proxy switch as a SET (new ids, same
    // god/label), exactly like setHeadless()'s relaunch - proxy is a
    // context-level property, and this proves that invariant held across
    // TWO relaunches (on, then off) in a row.
    const sessionsAfterProxyRoundTrip = await req('GET', '/sessions');
    const godsAfter = (sessionsAfterProxyRoundTrip.body.sessions || []).map((s) => s.god).sort();
    check('proxy: the SET of god-owned sessions survives a proxy switch round trip', JSON.stringify(godsAfter) === JSON.stringify(['athena', 'hermes'].sort()), JSON.stringify(godsAfter));
  } finally {
    child.kill('SIGTERM');
    // give it a moment to close the browser context cleanly
    await new Promise((r) => setTimeout(r, 1000));
    fixtureServer.close();
    fs.rmSync(scratchState, { recursive: true, force: true });
    fs.rmSync(scratchArtifacts, { recursive: true, force: true });
    fs.rmSync(scratchEscalations, { force: true });
    fs.rmSync(path.join(__dirname, 'fixture.txt'), { force: true });
    fs.rmSync(path.join(__dirname, '.scratch-outside'), { recursive: true, force: true });
  }
}

// Direct-library round-trip proof for storageState: bypasses the HTTP API
// entirely and drives lib/atlas-browser.js in-process against its own
// isolated scratch dir, so "save, restart, reload" is proven deterministically
// rather than depending on a real site setting a cookie.
async function storageStateRoundTrip() {
  const scratchDir = path.join(__dirname, '.scratch-state-roundtrip');
  fs.rmSync(scratchDir, { recursive: true, force: true });
  process.env.ATLAS_BROWSER_STATE_DIR = scratchDir;
  // require AFTER setting the env var so lib/paths.js resolves to the scratch dir
  const { AtlasBrowser } = require('../lib/atlas-browser');

  const first = new AtlasBrowser();
  await first.launch({ headless: true });
  await first.context.addCookies([
    { name: 'atlas_test_cookie', value: 'round-trip-proof', domain: 'example.com', path: '/' },
  ]);
  const saved = await first.saveState();
  check('round-trip: saveState() persists the cookie we set', saved.cookies >= 1, JSON.stringify(saved));
  await first.close();

  const second = new AtlasBrowser();
  await second.launch({ headless: true }); // reads state/storageState.json if present
  const cookiesAfterRestart = await second.context.cookies('https://example.com');
  const found = cookiesAfterRestart.find((c) => c.name === 'atlas_test_cookie' && c.value === 'round-trip-proof');
  check('round-trip: fresh process reloads the cookie from storageState.json', !!found, JSON.stringify(cookiesAfterRestart));
  await second.close();

  fs.rmSync(scratchDir, { recursive: true, force: true });
}

// Generic per-port HTTP helper for hostGuardEndToEnd() below - main()'s
// req()/rawReq() are hardcoded to the module-level PORT/TOKEN, and this
// test needs its own separate server instances on their own ports so the
// default-deny and escape-hatch behaviors can each be proven against a
// clean, purpose-built child rather than reusing main()'s (which runs with
// the escape hatch ON for unrelated reasons - see the comment on its spawn
// env above).
function httpReq(port, token, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = Object.assign(
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      token ? { Authorization: `Bearer ${token}` } : {}
    );
    const r = http.request({ host: HOST, port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf.toString('utf8')) });
        } catch (e) {
          resolve({ status: res.statusCode, body: buf.toString('utf8') });
        }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForToken(scratchState, timeoutMs) {
  const tokenPath = path.join(scratchState, 'token');
  const start = Date.now();
  while (!fs.existsSync(tokenPath)) {
    if (Date.now() - start > timeoutMs) throw new Error('token file never appeared at ' + tokenPath);
    await new Promise((r) => setTimeout(r, 100));
  }
  return fs.readFileSync(tokenPath, 'utf8').trim();
}

async function waitForPort(port, token, timeoutMs) {
  const start = Date.now();
  while (true) {
    try {
      const r = await httpReq(port, token, 'GET', '/status');
      if (r.status === 200) return;
    } catch (_) {}
    if (Date.now() - start > timeoutMs) throw new Error(`server on port ${port} did not come up in time`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// End-to-end proof of HOLE 5 (destination host guard). Runs against TWO
// freshly spawned server instances of its own, entirely separate from
// main()'s (which runs with the escape hatch on, see comment there) - one
// with the default (deny internal destinations), one with the escape hatch
// explicitly enabled - so both the block and the override are proven
// against a real running service, not just the library function in
// isolation.
async function hostGuardEndToEnd() {
  const serverPath = path.join(__dirname, '..', 'server.js');

  // A real local HTTP server on loopback, used ONLY as the escape-hatch
  // target below (phase 2) - proves the override doesn't just avoid an
  // error, it actually lets the browser load internal content.
  const internalMarker = 'HOST-GUARD-ESCAPE-HATCH-REACHED-INTERNAL-CONTENT';
  const internalSrv = http.createServer((req2, res2) => {
    res2.writeHead(200, { 'Content-Type': 'text/html' });
    res2.end(`<html><body>${internalMarker}</body></html>`);
  });
  await new Promise((resolve) => internalSrv.listen(0, '127.0.0.1', resolve));
  const internalPort = internalSrv.address().port;

  // ---- phase 1: default deny ----
  const port1 = 8783;
  const scratch1 = path.join(__dirname, '.scratch-hostguard-deny');
  const artifacts1 = path.join(__dirname, '.scratch-hostguard-deny-artifacts');
  fs.rmSync(scratch1, { recursive: true, force: true });
  fs.rmSync(artifacts1, { recursive: true, force: true });
  const child1 = spawn(process.execPath, [serverPath, String(port1)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ATLAS_BROWSER_STATE_DIR: scratch1,
      ATLAS_BROWSER_ARTIFACTS_DIR: artifacts1,
      ATLAS_BROWSER_ESCALATIONS_LOG: path.join(scratch1, 'escalations.jsonl'),
      ATLAS_NTFY_URL: '',
      ATLAS_NTFY_TOPIC: '',
      // deliberately NOT setting ATLAS_BROWSER_ALLOW_INTERNAL - proving the default.
    },
  });
  try {
    const token1 = await waitForToken(scratch1, 20000);
    await waitForPort(port1, token1, 20000);
    const session1 = await httpReq(port1, token1, 'POST', '/sessions', { god: 'test-god', label: 'hostguard' });
    check('HOLE 5 setup: session opens on the deny-by-default server', session1.status === 200, JSON.stringify(session1.body));
    const sid1 = session1.body.id;

    const cases = [
      // [label, url, expectBlocked]
      ['unauthenticated local admin API (the real motivating case)', `http://127.0.0.1:8444/api/tasks`, true],
      ['cloud metadata address', 'http://169.254.169.254/', true],
      ['private LAN address (RFC1918)', 'http://10.1.2.3/', true],
      ['Tailscale CGNAT address (mesh-VPN space)', 'http://100.x.x.x/', true],
      // catches a naive scheme/string check: this hostname RESOLVES to
      // loopback via DNS, it is not a literal loopback IP in the URL text.
      ['hostname that DNS-resolves to loopback (localtest.me)', 'http://localtest.me/', true],
      // decimal encoding of 127.0.0.1 - a naive string check for "127.0.0.1"
      // or "localhost" would miss this; new URL() normalizes it first, then
      // the guard blocks the normalized address.
      ['decimal-encoded loopback (2130706433 == 127.0.0.1)', 'http://2130706433/', true],
    ];

    for (const [label, url, expectBlocked] of cases) {
      const r = await httpReq(port1, token1, 'POST', `/sessions/${sid1}/open`, { url });
      const blocked = r.status >= 400 && /internal|private|resolve/i.test(r.body.error || '');
      check(`HOLE 5: ${label} is blocked`, blocked === expectBlocked, JSON.stringify(r.body));
    }

    // CONTROL: a normal public site must still load fine through the same
    // guarded path - proves this is a denylist, not an accidental full block.
    const control = await httpReq(port1, token1, 'POST', `/sessions/${sid1}/open`, { url: 'https://example.com' });
    check('HOLE 5 CONTROL: a normal public site still opens fine', control.status === 200 && /Example Domain/.test(control.body.title || ''), JSON.stringify(control.body));
  } finally {
    child1.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
    fs.rmSync(scratch1, { recursive: true, force: true });
    fs.rmSync(artifacts1, { recursive: true, force: true });
  }

  // ---- phase 2: explicit escape hatch ----
  const port2 = 8784;
  const scratch2 = path.join(__dirname, '.scratch-hostguard-allow');
  const artifacts2 = path.join(__dirname, '.scratch-hostguard-allow-artifacts');
  fs.rmSync(scratch2, { recursive: true, force: true });
  fs.rmSync(artifacts2, { recursive: true, force: true });
  const child2 = spawn(process.execPath, [serverPath, String(port2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ATLAS_BROWSER_STATE_DIR: scratch2,
      ATLAS_BROWSER_ARTIFACTS_DIR: artifacts2,
      ATLAS_BROWSER_ESCALATIONS_LOG: path.join(scratch2, 'escalations.jsonl'),
      ATLAS_NTFY_URL: '',
      ATLAS_NTFY_TOPIC: '',
      ATLAS_BROWSER_ALLOW_INTERNAL: '1',
    },
  });
  try {
    const token2 = await waitForToken(scratch2, 20000);
    await waitForPort(port2, token2, 20000);
    const session2 = await httpReq(port2, token2, 'POST', '/sessions', { god: 'test-god', label: 'hostguard-escape' });
    check('HOLE 5 escape hatch setup: session opens on the allow-internal server', session2.status === 200, JSON.stringify(session2.body));
    const sid2 = session2.body.id;

    const escaped = await httpReq(port2, token2, 'POST', `/sessions/${sid2}/open`, { url: `http://127.0.0.1:${internalPort}/` });
    check('HOLE 5 escape hatch: ATLAS_BROWSER_ALLOW_INTERNAL=1 actually lets an internal destination load', escaped.status === 200, JSON.stringify(escaped.body));
    const escapedRead = await httpReq(port2, token2, 'GET', `/sessions/${sid2}/read`);
    check('HOLE 5 escape hatch: the internal page\'s real content came through, not just a non-error status', (escapedRead.body.text || '').includes(internalMarker), escapedRead.body.text);
  } finally {
    child2.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
    fs.rmSync(scratch2, { recursive: true, force: true });
    fs.rmSync(artifacts2, { recursive: true, force: true });
    internalSrv.close();
  }
}

main()
  .then(() => storageStateRoundTrip())
  .then(() => hostGuardEndToEnd())
  .then(() => {
    console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('SMOKE TEST CRASHED:', err);
    process.exit(1);
  });
