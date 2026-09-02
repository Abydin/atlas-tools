'use strict';

// SSRF-over-WebSocket reproduction + verification (t-350 follow-up).
//
// The HTTP-layer fix in lib/atlas-browser.js (`context.route('**/*')`
// running assertSafeDestination before every request) does NOT cover
// WebSocket connections - Playwright's BrowserContext.route() only
// intercepts fetch/XHR/navigation-style requests, never ws:/wss:
// handshakes. That leaves the exact same SSRF class the route guard was
// built to close: a page reachable by this browser can open
// `new WebSocket('ws://127.0.0.1:<port>/')` and read back whatever a
// loopback service says, with no guard in the way.
//
// Run in-process (not spawned as a subprocess like test/smoke.js) so the
// test can flip ATLAS_BROWSER_ALLOW_INTERNAL off AFTER navigating to its
// own loopback fixture page (setup requires the escape hatch, same as
// smoke.js's fixture - see host-guard.js) and BEFORE the page's own script
// opens the WebSocket - isolating exactly what's under test: does the
// WebSocket connection itself respect the default-deny guard.
//
// Usage: node test/ws-ssrf-repro.js
// Exits 0 if the WebSocket connection was blocked, 1 if the secret leaked.

const path = require('path');
const scratchState = path.join(__dirname, '.scratch-ws-repro');
const scratchArtifacts = path.join(__dirname, '.scratch-ws-repro-artifacts');
process.env.ATLAS_BROWSER_STATE_DIR = scratchState;
process.env.ATLAS_BROWSER_ARTIFACTS_DIR = scratchArtifacts;
process.env.ATLAS_NTFY_URL = '';
process.env.ATLAS_NTFY_TOPIC = '';

const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { AtlasBrowser } = require('../lib/atlas-browser');

fs.rmSync(scratchState, { recursive: true, force: true });
fs.rmSync(scratchArtifacts, { recursive: true, force: true });

const SECRET = 'SECRET-FROM-LOOPBACK-SERVICE';

function startWsServer() {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 }, () => {
      resolve(wss);
    });
    wss.connectionCount = 0;
    wss.on('connection', (socket) => {
      wss.connectionCount += 1;
      console.log('[ws-fixture] connection received from browser page');
      socket.send(SECRET);
    });
  });
}

function startHttpFixture(wsPort) {
  const html = `
    <html><body>
      <h1>ws ssrf repro fixture</h1>
      <div id="result">not-run</div>
      <button id="connect" onclick="doConnect()">connect</button>
      <script>
        function doConnect() {
          try {
            var ws = new WebSocket('ws://127.0.0.1:${wsPort}/');
            ws.onmessage = function (ev) {
              document.getElementById('result').textContent = ev.data;
            };
            ws.onerror = function () {
              document.getElementById('result').textContent = 'WS-ERROR';
            };
          } catch (err) {
            document.getElementById('result').textContent = 'WS-THROW:' + err.message;
          }
        }
      </script>
    </body></html>
  `;
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function run() {
  const wss = await startWsServer();
  const wsPort = wss.address().port;
  const httpFixture = await startHttpFixture(wsPort);
  const httpPort = httpFixture.address().port;
  console.log(`[repro] ws fixture on 127.0.0.1:${wsPort}, http fixture on 127.0.0.1:${httpPort}`);

  const browser = new AtlasBrowser();
  // Setup only: loading OUR OWN loopback fixture page is the documented
  // "operator's own local dev server" escape-hatch case, not the attack
  // under test. Turned OFF again below before the WebSocket is opened.
  process.env.ATLAS_BROWSER_ALLOW_INTERNAL = '1';
  await browser.launch({ headless: true });
  const session = await browser.openSession({ god: 'test-god', label: 'ws-repro' });
  await browser.open(session.id, `http://127.0.0.1:${httpPort}/`);

  // Now simulate the realistic default: the guard is NOT relaxed. This is
  // the posture every real session runs under.
  delete process.env.ATLAS_BROWSER_ALLOW_INTERNAL;

  await browser.click(session.id, '#connect');
  await new Promise((r) => setTimeout(r, 1000)); // let the WS handshake/message land

  const read = await browser.readText(session.id);
  console.log(`[repro] page result div: ${JSON.stringify(read.text.trim())}`);
  console.log(`[repro] ws server saw ${wss.connectionCount} connection(s)`);

  const leaked = read.text.includes(SECRET);
  const blocked = !leaked && wss.connectionCount === 0;

  await browser.close().catch(() => {});
  wss.close();
  httpFixture.close();
  fs.rmSync(scratchState, { recursive: true, force: true });
  fs.rmSync(scratchArtifacts, { recursive: true, force: true });

  if (leaked) {
    console.log('\nRESULT: LEAKED - the loopback WebSocket service was reachable, secret exfiltrated to the page.');
    process.exit(1);
  }
  if (!blocked) {
    console.log('\nRESULT: INCONCLUSIVE - no secret leaked but the ws server also logged no connection attempt; check the fixture.');
    process.exit(1);
  }
  console.log('\nRESULT: BLOCKED - the WebSocket connection to the loopback service never reached it.');
  process.exit(0);
}

run().catch((err) => {
  console.error('WS SSRF REPRO CRASHED:', err);
  process.exit(1);
});
