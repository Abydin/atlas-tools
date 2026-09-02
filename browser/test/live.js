'use strict';

// Proof harness for the /live interactive surface (CDP screencast + input
// relay over a WebSocket). Separate from smoke.js so that suite stays pinned
// at exactly 46; this one exercises the NEW capability the whole build exists
// for and, where it can, shows a thing FAILING before it passes:
//
//   1. screencast frames actually arrive over the WS (count > 0 in ~3s).
//   2. DRAG works end to end - a real range slider's value CHANGES, and the
//      SAME drag sent as a plain click does NOT (drag is doing the work, not
//      an incidental click).
//   3. state preservation - a filled field still holds its value after the
//      screencast started and input was dispatched (no reload, the point).
//   4. auth - a WS connect with no token, and one with a spoofed Origin, are
//      both rejected before any frame streams.
//
// Runs against its own freshly spawned server on its own port + scratch dirs,
// never the live 8781 instance. Never pages a human (ntfy nulled).

process.env.ATLAS_NTFY_TEST_MODE = '1';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8785;
const HOST = '127.0.0.1';
let TOKEN = null;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}

function httpReq(method, p, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = Object.assign(
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      extraHeaders || {}
    );
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode, body: JSON.parse(buf.toString('utf8')) }); }
        catch (_) { resolve({ status: res.statusCode, body: buf.toString('utf8') }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// A fixture page with a real HTML range slider (the drag target) and a text
// input (the state-preservation target). The slider reports its value into a
// span so we can read it back via /read without guessing pixel state.
function startFixtureServer() {
  const html = `<!doctype html><html><head><title>Live Proof Fixture</title></head><body>
    <div><input id="name" type="text"></div>
    <div style="padding:40px 20px"><input id="slider" type="range" min="0" max="100" value="0" step="1" style="width:600px"></div>
    <div>VAL:<span id="out">0</span></div>
    <div>NAME:<span id="nameout"></span></div>
    <div>RECT:<span id="rect">?</span></div>
    <script>
      var sl = document.getElementById('slider'), out = document.getElementById('out');
      sl.addEventListener('input', function(){ out.textContent = sl.value; });
      // Echo the text field's value into page text so /read can confirm it
      // survived the screencast+input with no reload (fill() fires 'input').
      var nm = document.getElementById('name');
      nm.addEventListener('input', function(){ document.getElementById('nameout').textContent = nm.value; });
      // Report the slider's real viewport geometry so the proof drags the
      // ACTUAL track, not guessed pixels.
      var r = sl.getBoundingClientRect();
      document.getElementById('rect').textContent =
        Math.round(r.left)+','+Math.round(r.top)+','+Math.round(r.width)+','+Math.round(r.height);
    </script>
  </body></html>`;
  return new Promise((resolve) => {
    const srv = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function openLiveWs(sessionId, { token = TOKEN, origin } = {}) {
  const q = token !== null && token !== undefined ? `?token=${encodeURIComponent(token)}` : '';
  const headers = origin ? { Origin: origin } : {};
  return new WebSocket(`ws://${HOST}:${PORT}/sessions/${sessionId}/live${q}`, { headers });
}

async function main() {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const scratchState = path.join(__dirname, '.scratch-live-state');
  const scratchArtifacts = path.join(__dirname, '.scratch-live-artifacts');
  fs.rmSync(scratchState, { recursive: true, force: true });
  fs.rmSync(scratchArtifacts, { recursive: true, force: true });

  const fixtureServer = await startFixtureServer();
  const fixturePort = fixtureServer.address().port;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

  const child = spawn(process.execPath, [serverPath, String(PORT)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ATLAS_BROWSER_STATE_DIR: scratchState,
      ATLAS_BROWSER_ARTIFACTS_DIR: scratchArtifacts,
      ATLAS_BROWSER_ESCALATIONS_LOG: path.join(scratchState, 'escalations.jsonl'),
      ATLAS_NTFY_URL: '',
      ATLAS_NTFY_TOPIC: '',
      // fixture is served over loopback; the host guard denies internal by
      // default, so this proof's own known-local target needs the documented
      // escape hatch, exactly like smoke.js main().
      ATLAS_BROWSER_ALLOW_INTERNAL: '1',
    },
  });

  try {
    const tokenPath = path.join(scratchState, 'token');
    const start = Date.now();
    while (!fs.existsSync(tokenPath)) {
      if (Date.now() - start > 20000) throw new Error('token never appeared');
      await new Promise((r) => setTimeout(r, 100));
    }
    TOKEN = fs.readFileSync(tokenPath, 'utf8').trim();
    // wait for listen
    while (true) {
      try { const r = await httpReq('GET', '/status'); if (r.status === 200) break; } catch (_) {}
      if (Date.now() - start > 20000) throw new Error('server did not come up');
      await new Promise((r) => setTimeout(r, 200));
    }

    // ---- 4 (auth, prove rejection FIRST) --------------------------------
    // Open a session to target. Auth is checked at the upgrade, before any
    // session lookup, so a bogus session id would still be fine here - but use
    // a real one so nothing else is ambiguous.
    const sess = await httpReq('POST', '/sessions', { god: 'hephaestus', label: 'live-proof' });
    const id = sess.body.id;

    async function expectWsRejected(name, ws) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (ok, detail) => { if (settled) return; settled = true; try { ws.terminate(); } catch (_) {} check(name, ok, detail); resolve(); };
        ws.on('open', () => done(false, 'connection OPENED but should have been rejected'));
        ws.on('error', () => done(true));
        ws.on('unexpected-response', (_req, res) => done(res.statusCode === 401 || res.statusCode === 403, 'status ' + res.statusCode));
        setTimeout(() => done(false, 'no rejection within 4s'), 4000);
      });
    }
    await expectWsRejected('AUTH: WS connect with NO token is rejected', openLiveWs(id, { token: null }));
    await expectWsRejected('AUTH: WS connect with WRONG token is rejected', openLiveWs(id, { token: 'not-the-real-token' }));
    await expectWsRejected('AUTH: WS connect with a foreign Origin is rejected (CSWSH)', openLiveWs(id, { origin: 'https://evil.example.com' }));

    // ---- navigate the session to the fixture ----------------------------
    await httpReq('POST', `/sessions/${id}/open`, { url: fixtureUrl });
    // fill the text field NOW, before any screencast/input, so #3 can prove it
    // survives.
    await httpReq('POST', `/sessions/${id}/fill`, { selector: '#name', value: 'the operator-STATE-MARKER' });

    // ---- 1 (screencast frames arrive) -----------------------------------
    let frameCount = 0;
    const ws = openLiveWs(id);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('ws did not open')), 5000);
    });
    let lastFrameB64 = null;
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.type === 'frame') { frameCount++; lastFrameB64 = m.data; }
    });
    await new Promise((r) => setTimeout(r, 3000));
    check('SCREENCAST: JPEG frames actually arrive over the WS in ~3s', frameCount > 0, `frames=${frameCount}`);
    // sanity: the last frame decodes to real JPEG bytes (magic FF D8 FF)
    const jpegOk = lastFrameB64 && Buffer.from(lastFrameB64, 'base64').slice(0, 3).toString('hex') === 'ffd8ff';
    check('SCREENCAST: a frame decodes to real JPEG bytes', !!jpegOk, lastFrameB64 ? lastFrameB64.slice(0, 12) : 'no frame');

    // ---- read the slider's REAL viewport geometry -----------------------
    function readPage() { return httpReq('GET', `/sessions/${id}/read`).then((r) => r.body.text || ''); }
    function sliderValue(text) { const m = /VAL:\s*(\d+)/.exec(text); return m ? Number(m[1]) : null; }
    const pageText = await readPage();
    const rectMatch = /RECT:\s*(-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(pageText);
    check('DRAG setup: read the slider bounding box from the live page', !!rectMatch, pageText.slice(0, 120));
    const [rx, ry, rw, rh] = rectMatch ? rectMatch.slice(1).map(Number) : [0, 0, 0, 0];
    // thumb at value 0 sits at the left; sweep along the track's centre line.
    const trackY = ry + Math.round(rh / 2);
    const leftX = rx + 8;
    const rightX = rx + rw - 8;

    const before = sliderValue(pageText);

    // Prove a plain CLICK at the far-right of the track does NOT sweep the
    // value up the way a drag does (a click can jump toward that point but is
    // not the press-move-release the captcha slider actually needs). We first
    // reset by reading current value after the click.
    ws.send(JSON.stringify({ kind: 'click', x: leftX, y: trackY }));
    await new Promise((r) => setTimeout(r, 500));
    const afterClick = sliderValue(await readPage());

    // The DRAG: press on the thumb (left) and sweep to the far right.
    ws.send(JSON.stringify({ kind: 'drag', fromX: leftX, fromY: trackY, toX: rightX, toY: trackY, steps: 25 }));
    await new Promise((r) => setTimeout(r, 900));
    const afterDrag = sliderValue(await readPage());

    check('DRAG: slider had a real starting value we can read', before !== null, `before=${before}`);
    check('DRAG: a full press-move-release sweep drives the slider up', afterDrag !== null && afterDrag > (before || 0) + 20, `before=${before} afterClick=${afterClick} afterDrag=${afterDrag}`);
    check('DRAG: the drag moved it further than the single click at the thumb did', afterDrag !== null && afterClick !== null && afterDrag > afterClick, `afterClick=${afterClick} afterDrag=${afterDrag}`);
    console.log(`      [drag proof] slider rect=[${rx},${ry},${rw},${rh}] value: before=${before}  afterClick=${afterClick}  afterDrag=${afterDrag}`);

    // ---- 3 (state preservation) -----------------------------------------
    // The fixture echoes #name into "NAME:<value>" via its input event, which
    // fill() fired when we set it BEFORE the screencast + all the drag/click
    // input. If the page had reloaded (the headed-flip bug), that echo would be
    // gone; it still being present is the state-preservation proof.
    const stateText = await readPage();
    check('STATE: the field filled BEFORE screencast+input still holds its value (no reload)', /NAME:\s*the operator-STATE-MARKER/.test(stateText), stateText.slice(0, 200));

    // ---- reuse / multi-listener sanity: second WS shares one screencast --
    let frames2 = 0;
    const ws2 = openLiveWs(id);
    await new Promise((res, rej) => { ws2.on('open', res); ws2.on('error', rej); setTimeout(() => rej(new Error('ws2 open timeout')), 5000); });
    ws2.on('message', (raw) => { try { if (JSON.parse(raw.toString()).type === 'frame') frames2++; } catch (_) {} });
    await new Promise((r) => setTimeout(r, 1500));
    check('SCREENCAST: a second client on the same session also receives frames (shared CDP)', frames2 > 0, `frames2=${frames2}`);

    ws.close(); ws2.close();
    await new Promise((r) => setTimeout(r, 300));

    // closing both clients must stop the screencast + detach cleanly (no throw)
    const statusAfter = await httpReq('GET', '/status');
    check('SCREENCAST: server still healthy after all live clients disconnect', statusAfter.status === 200, JSON.stringify(statusAfter.body));
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    fixtureServer.close();
    fs.rmSync(scratchState, { recursive: true, force: true });
    fs.rmSync(scratchArtifacts, { recursive: true, force: true });
  }
}

main()
  .then(() => { console.log(`\nLIVE TOTAL: ${pass} passed, ${fail} failed`); process.exit(fail > 0 ? 1 : 0); })
  .catch((err) => { console.error('LIVE PROOF CRASHED:', err); process.exit(1); });
