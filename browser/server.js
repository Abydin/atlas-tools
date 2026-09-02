'use strict';

// Atlas's own browser service - a SHARED surface for the whole pantheon,
// not an Atlas-only tool. One persistent, headless-by-default Chromium
// instance, exposing a small localhost-only HTTP API. Any god can open its
// own NAMED session (tab) and drive it independently; a Round Table with
// several gods active does not have them fighting over one page. Any god
// can also escalate: pause a session live and hand the operator that exact
// page rather than guessing or silently dropping a blocker.
//
// SECURITY: binds to 127.0.0.1 explicitly, never 0.0.0.0. Optionally ALSO
// binds one specific Tailscale interface IP (state/tailscale_ip, unset by
// default) so /live is reachable from the operator's phone - see the SECURITY
// comment by the listen() calls near the bottom for the full rationale.
// This process does not shell out (no child_process anywhere in this file
// or lib/, pushes go over plain http/https, see lib/ntfy.js). See
// README.md "Security scoping" for the full fence.
//
// Run: node server.js [port]   (default port 8781)

const http = require('http');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const { AtlasBrowser } = require('./lib/atlas-browser');
const { EscalationManager } = require('./lib/escalations');
const { loadOrCreateToken, safeTokenEqual } = require('./lib/auth');
const scoped = require('./lib/scoped-tokens');
const { resolvePublicHost, resolveBindIp, buildLiveUrl } = require('./lib/network');

const PORT = Number(process.argv[2] || process.env.ATLAS_BROWSER_PORT || 8781);
const HOST = '127.0.0.1';

// SECURITY (Tailscale /live, 2026-07): the hostname printed/pushed in URLs
// (PUBLIC_HOST) and the interface the server additionally binds to
// (BIND_IP) are two separate questions - see lib/network.js. BIND_IP is
// null unless state/tailscale_ip (or ATLAS_BROWSER_TAILSCALE_IP) says
// otherwise, so an untouched checkout still binds ONLY 127.0.0.1, exactly
// as before this feature. When set, the server binds a SECOND, independent
// socket on that one specific Tailscale IP - never 0.0.0.0 - so the fence
// stays "this one interface, token-gated, Host-allowlisted", not "the
// whole LAN". See the two server.listen() calls near the bottom of this
// file and the ALLOWED_HOST_HEADERS/ALLOWED_ORIGINS block below.
const PUBLIC_HOST = resolvePublicHost();
const BIND_IP = resolveBindIp();

const browser = new AtlasBrowser();
const browserReady = browser.launch({ headless: true });
const escalations = new EscalationManager();

// SECURITY (HOLE 3): bearer token required on every endpoint. Generated on
// first start, written 0600 under state/token, read by cli.js from the
// same file. Deliberately NOT printed/logged to stdout - state/token
// (0600, owner-only) is the only place it should ever land on disk, and
// stdout routinely ends up in shell history, log files, or a terminal
// scrollback another process/user can read. See lib/auth.js.
const TOKEN = loadOrCreateToken();

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

// SECURITY: embeds a SCOPED token (t-355, lib/scoped-tokens.js), never the
// master bearer token. This URL is what lib/escalations.js pushes over
// ntfy (see ntfy.js - default channel is the public https://ntfy.sh with a
// topic name hardcoded in this repo), an unauthenticated third-party
// relay: anyone who knows or guesses the topic can subscribe. Putting the
// real API token in that message would hand full control of the browser
// (open/click/type/upload/escalate, not just viewing) to anyone who ever
// reads that channel (Athena review, 2026-07-21 - the first draft of this
// hardening pass got this wrong by carrying the master token). The scoped
// token minted here is bound to exactly this sessionId, expires with the
// escalation's own timeout (clamped to scoped-tokens.js's MAX_TTL_MS), and
// - per scoped.allows() - authorizes ONLY the /live and /view surface of
// that one session, nothing else the master token could do. Reading the
// topic still lets a stranger drive that one captcha page for a bounded
// window, which is why ATLAS_NTFY_TOPIC should still be a private topic,
// not the shared default - this bounds the blast radius, it doesn't erase
// it.
// Links to /live (the interactive CDP-screencast takeover), not /view (the
// low-tech screenshot fallback): when a god escalates a captcha, what the
// operator needs is the surface he can actually DRAG on.
//
// Uses PUBLIC_HOST (Tailscale MagicDNS name, when configured), not the bind
// address HOST - a link that says "127.0.0.1" is only ever reachable from
// this Mac itself, useless on a phone. See lib/network.js.
function viewUrlFor(sessionId, ttlMs) {
  const { token } = scoped.mint(sessionId, ttlMs);
  return buildLiveUrl({ port: PORT, sessionId, token });
}

function pickDefaultSessionId() {
  const sessions = browser.listSessions();
  return sessions.length ? sessions[sessions.length - 1].id : null;
}

// `token` is embedded directly into the served HTML/JS so the page's own
// screenshot polling and session-switch navigation can carry it as a
// ?token= query param - a top-level page load and an <img> tag cannot set
// a custom Authorization header, so the query-param path is how a human
// actually watching /view in a real browser authenticates. `god`/`label`
// are caller-supplied strings (whichever god opened the session), NOT
// trusted, and are HTML-escaped before being interpolated - the same
// discipline this codebase applies to page-supplied strings applies here
// to API-caller-supplied ones too.
const VIEW_HTML = (sessionId, sessions, token) => `<!doctype html>
<html><head><title>Atlas Browser - Live View</title>
<meta charset="utf-8">
<style>
  body { margin:0; background:#111; color:#ccc; font-family:-apple-system,sans-serif; }
  #bar { padding:8px 12px; font-size:13px; background:#000; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  #bar select { background:#222; color:#ccc; border:1px solid #444; }
  #bar button { background:#2563eb; color:#fff; border:0; padding:5px 10px; border-radius:5px; cursor:pointer; font-size:13px; }
  #bar button.off { background:#444; }
  #bar input[type=text] { background:#222; color:#eee; border:1px solid #444; padding:4px 6px; border-radius:4px; }
  img { display:block; width:100%; height:auto; cursor:crosshair; }
  #empty { padding: 40px; text-align:center; color:#888; }
  #hint { color:#7dd3fc; font-size:12px; }
</style></head>
<body>
<div id="bar">
  Atlas Browser live view
  <select id="sessionPicker">
    ${sessions.map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === sessionId ? 'selected' : ''}>${escapeHtml(s.god)}${s.label ? ' / ' + escapeHtml(s.label) : ''} (${escapeHtml(s.id)})</option>`).join('')}
  </select>
  <span id="url"></span>
  <button id="takeover" class="off" type="button">Take over: OFF</button>
  <button id="refreshbtn" class="off" type="button">Refresh</button>
  <input id="typebox" type="text" placeholder="type + Enter to send keys" size="24" disabled>
  <span id="hint"></span>
</div>
${sessionId ? `<img id="frame" src="/sessions/${encodeURIComponent(sessionId)}/screenshot?_=0&token=${encodeURIComponent(token)}">` : `<div id="empty">No active sessions. A god will open one, or open one yourself via POST /sessions.</div>`}
<script>
  // SECURITY: TOKEN and SESSION_ID both enter this script ONLY via
  // JSON.stringify() - never raw string interpolation into the JS source -
  // so neither can break out of its string literal no matter what
  // characters it contains. (Athena review, 2026-07-21: an earlier draft
  // interpolated sessionId directly into a single-quoted JS string using
  // encodeURIComponent(), which does not escape ' or ( or ), a real
  // injection into a page authenticated callers can reach.) Both are also
  // run through encodeURIComponent() again below, but only as ordinary URL
  // encoding for the query string, not as the injection defense.
  const TOKEN = ${JSON.stringify(token)};
  const SESSION_ID = ${JSON.stringify(sessionId || '')};
  const picker = document.getElementById('sessionPicker');
  picker.addEventListener('change', () => {
    window.location.href = '/view?session=' + encodeURIComponent(picker.value) + '&token=' + encodeURIComponent(TOKEN);
  });
  const img = document.getElementById('frame');
  const urlSpan = document.getElementById('url');
  // The real browser viewport is a fixed 1280x900 (see atlas-browser launch);
  // the <img> is scaled to the window width. A click at display coords must be
  // mapped back to that real viewport before it is dispatched, otherwise the
  // captcha tile you point at is not the tile the page clicks.
  const VIEW_W = 1280, VIEW_H = 900;
  let takeover = false;

  const btn = document.getElementById('takeover');
  const typebox = document.getElementById('typebox');
  const hint = document.getElementById('hint');

  async function sendInput(event) {
    try {
      const r = await fetch('/sessions/' + encodeURIComponent(SESSION_ID) + '/input?token=' + encodeURIComponent(TOKEN), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      const j = await r.json();
      hint.textContent = r.ok ? ('sent ' + (event.kind) ) : ('error: ' + (j.error || r.status));
      // Refresh the frame immediately so the human sees the result of their
      // action without waiting for the poll tick.
      if (img) img.src = '/sessions/' + encodeURIComponent(SESSION_ID) + '/screenshot?_=' + Date.now() + '&token=' + encodeURIComponent(TOKEN);
    } catch (e) { hint.textContent = 'send failed'; }
  }

  if (btn) {
    btn.addEventListener('click', () => {
      takeover = !takeover;
      btn.textContent = 'Take over: ' + (takeover ? 'ON' : 'OFF');
      btn.className = takeover ? '' : 'off';
      typebox.disabled = !takeover;
      hint.textContent = takeover ? 'click the image to click there; type below for keys' : '';
    });
  }

  function refreshFrame() {
    if (img) img.src = '/sessions/' + encodeURIComponent(SESSION_ID) + '/screenshot?_=' + Date.now() + '&token=' + encodeURIComponent(TOKEN);
  }
  const refreshBtn = document.getElementById('refreshbtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshFrame);

  if (img) {
    img.addEventListener('click', (e) => {
      if (!takeover) return;
      const rect = img.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) / rect.width * VIEW_W);
      const y = Math.round((e.clientY - rect.top) / rect.height * VIEW_H);
      sendInput({ kind: 'click', x: x, y: y });
    });
  }

  if (typebox) {
    typebox.addEventListener('keydown', (e) => {
      if (!takeover) return;
      if (e.key === 'Enter') {
        const text = typebox.value;
        if (text) { sendInput({ kind: 'type', text: text }); typebox.value = ''; }
        sendInput({ kind: 'key', key: 'Enter' });
      }
    });
  }

  if (img) {
    setInterval(async () => {
      // Auto-refresh ONLY while watching. During takeover the frame is frozen
      // so a click lands on the tile you actually see, not one shifted by a
      // mid-click repaint; each dispatched input refreshes the frame once, and
      // the Refresh button forces an update on demand. This is the fix for the
      // real usability risk with captcha grids (small tiles, live repaint).
      if (!takeover) refreshFrame();
      try {
        const r = await fetch('/sessions/' + encodeURIComponent(SESSION_ID) + '?token=' + encodeURIComponent(TOKEN));
        const j = await r.json();
        urlSpan.textContent = j.url || '';
      } catch (e) {}
    }, 1500);
  }
</script>
</body></html>`;

// The real interactive surface: a CDP screencast rendered to a <canvas>, with
// full mouse (click AND drag) + keyboard + scroll relayed live over a
// WebSocket. This is what /view could never be - a drag on a slider/move-the-
// tile captcha is a real press-move-release, not a click, and it all plays
// into the SAME headless page so a filled form is never disturbed. TOKEN and
// SESSION_ID enter the script ONLY via JSON.stringify(), never raw
// interpolation, same injection defense as VIEW_HTML above.
const LIVE_HTML = (sessionId, sessions, token) => `<!doctype html>
<html><head><title>Atlas Browser - Live Control</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin:0; background:#0b0b0d; color:#ccc; font-family:-apple-system,sans-serif; }
  #bar { padding:8px 12px; font-size:13px; background:#000; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  #bar select { background:#222; color:#ccc; border:1px solid #444; }
  #bar .dot { width:9px; height:9px; border-radius:50%; background:#666; display:inline-block; }
  #bar .dot.on { background:#22c55e; }
  #bar .dot.off { background:#ef4444; }
  #url { color:#7dd3fc; font-size:12px; max-width:40vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #hint { color:#9ca3af; font-size:12px; }
  #wrap { display:flex; justify-content:center; background:#0b0b0d; }
  canvas { display:block; max-width:100%; height:auto; background:#000; cursor:crosshair; touch-action:none; }
  #empty { padding:40px; text-align:center; color:#888; }
</style></head>
<body>
<div id="bar">
  <span class="dot off" id="conn"></span>
  <strong>Atlas Browser live control</strong>
  <select id="sessionPicker">
    ${sessions.map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === sessionId ? 'selected' : ''}>${escapeHtml(s.god)}${s.label ? ' / ' + escapeHtml(s.label) : ''} (${escapeHtml(s.id)})</option>`).join('')}
  </select>
  <span id="url"></span>
  <span id="hint">click, drag, type, scroll - it is the real browser</span>
</div>
${sessionId ? '<div id="wrap"><canvas id="screen" width="1280" height="900"></canvas></div>' : '<div id="empty">No active sessions. A god will open one, or open one yourself via POST /sessions.</div>'}
<script>
  const TOKEN = ${JSON.stringify(token)};
  const SESSION_ID = ${JSON.stringify(sessionId || '')};
  const VIEW_W = 1280, VIEW_H = 900; // the fixed real viewport (see atlas-browser launch)
  const picker = document.getElementById('sessionPicker');
  if (picker) picker.addEventListener('change', () => {
    window.location.href = '/live?session=' + encodeURIComponent(picker.value) + '&token=' + encodeURIComponent(TOKEN);
  });

  const canvas = document.getElementById('screen');
  const conn = document.getElementById('conn');
  const urlSpan = document.getElementById('url');
  const hint = document.getElementById('hint');

  if (canvas) {
    const ctx = canvas.getContext('2d');
    const img = new Image();
    let haveFrame = false;
    img.onload = () => {
      // Keep the canvas backing store at the real viewport size so a click
      // maps cleanly; the CSS scales it down to the window. Drawing the JPEG
      // (whatever its pixel size) across the full 1280x900 keeps coords honest.
      ctx.drawImage(img, 0, 0, VIEW_W, VIEW_H);
      haveFrame = true;
    };

    let ws;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/sessions/' + encodeURIComponent(SESSION_ID) + '/live?token=' + encodeURIComponent(TOKEN));
      ws.onopen = () => { conn.className = 'dot on'; };
      ws.onclose = () => { conn.className = 'dot off'; setTimeout(connect, 1200); };
      ws.onerror = () => { conn.className = 'dot off'; };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'frame') {
          img.src = 'data:image/jpeg;base64,' + msg.data;
        } else if (msg.type === 'meta') {
          urlSpan.textContent = msg.url || '';
        } else if (msg.type === 'error') {
          hint.textContent = 'error: ' + msg.error;
        }
      };
    }
    connect();

    function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

    // Map a mouse event on the (CSS-scaled) canvas back to the real 1280x900
    // viewport, so the tile you point at is the tile the page acts on.
    function toViewport(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.round((e.clientX - r.left) / r.width * VIEW_W),
        y: Math.round((e.clientY - r.top) / r.height * VIEW_H),
      };
    }

    // Click vs drag is decided by movement: a press that moves more than a few
    // viewport px before release is a DRAG (slider/move-the-tile), otherwise a
    // click. This is the whole point of /live.
    const DRAG_THRESHOLD = 6;
    let down = null;
    canvas.addEventListener('mousedown', (e) => { e.preventDefault(); down = toViewport(e); });
    window.addEventListener('mouseup', (e) => {
      if (!down) return;
      const up = toViewport(e);
      const moved = Math.abs(up.x - down.x) + Math.abs(up.y - down.y);
      if (moved > DRAG_THRESHOLD) {
        send({ kind: 'drag', fromX: down.x, fromY: down.y, toX: up.x, toY: up.y });
        hint.textContent = 'dragged';
      } else {
        send({ kind: 'click', x: down.x, y: down.y });
        hint.textContent = 'clicked';
      }
      down = null;
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      send({ kind: 'scroll', dy: Math.round(e.deltaY) });
    }, { passive: false });

    // Touch (phone): phones do not emit 'wheel', and a finger-swipe would
    // otherwise land as a page DRAG (mousedown..mouseup moved > threshold),
    // so scrolling silently did nothing on mobile. Handle touch explicitly:
    // a single-finger swipe scrolls, a near-stationary touch taps (clicks).
    // preventDefault on touchstart/move also suppresses the synthetic mouse
    // events phones fire, so we never get a doubled click/drag.
    let tStart = null; let tLastY = null; let tMoved = 0;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const t = e.touches[0];
      tStart = toViewport({ clientX: t.clientX, clientY: t.clientY });
      tLastY = t.clientY; tMoved = 0;
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1 || tLastY === null) return;
      e.preventDefault();
      const t = e.touches[0];
      const r = canvas.getBoundingClientRect();
      const scale = VIEW_H / r.height;
      const dyClient = tLastY - t.clientY; // finger up -> positive -> scroll down
      tMoved += Math.abs(dyClient);
      if (Math.abs(dyClient) >= 1) send({ kind: 'scroll', dy: Math.round(dyClient * scale) });
      tLastY = t.clientY;
    }, { passive: false });
    window.addEventListener('touchend', () => {
      if (tStart && tMoved < 10) {
        send({ kind: 'click', x: tStart.x, y: tStart.y });
        hint.textContent = 'tapped';
      }
      tStart = null; tLastY = null; tMoved = 0;
    }, { passive: false });

    // Keyboard: a single printable char is typed as text; a named key
    // (Enter, Backspace, Tab, ArrowLeft...) is sent as a key press. Anything
    // the server does not whitelist is simply dropped there.
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // don't hijack browser shortcuts
      if (e.key.length === 1) {
        e.preventDefault();
        send({ kind: 'type', text: e.key });
      } else if (/^[A-Za-z0-9]+$/.test(e.key)) {
        e.preventDefault();
        send({ kind: 'key', key: e.key });
      }
    });
  }
</script>
</body></html>`;

// SECURITY (HOLE 2 extended for Tailscale): the Host-header allowlist and
// the WS Origin allowlist both need to accept whatever host a request
// LEGITIMATELY arrives as. Before this feature that was only ever
// 127.0.0.1/localhost, because the server only ever bound loopback. Now
// that BIND_IP may additionally be live (see the listen() calls near the
// bottom), a request genuinely routed in over Tailscale carries
// `Host: <PUBLIC_HOST>:PORT` or `Host: <BIND_IP>:PORT` - both need to be
// on the allowlist or they'd be rejected as if spoofed, even though they
// are not. Built ONCE at startup from whatever PUBLIC_HOST/BIND_IP
// resolved to; 127.0.0.1 and localhost are always present regardless, so a
// checkout with neither configured behaves exactly as before this pass.
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);
if (PUBLIC_HOST) ALLOWED_HOSTNAMES.add(PUBLIC_HOST);
if (BIND_IP) ALLOWED_HOSTNAMES.add(BIND_IP);
const ALLOWED_HOST_HEADERS = new Set(Array.from(ALLOWED_HOSTNAMES, (h) => `${h}:${PORT}`));
const ALLOWED_ORIGINS = new Set(Array.from(ALLOWED_HOSTNAMES, (h) => `http://${h}:${PORT}`));

const requestListener = async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const parts = u.pathname.split('/').filter(Boolean); // e.g. ['sessions', 's1x2y3', 'read']

  // SECURITY (HOLE 2, DNS rebinding): validate the Host header against an
  // exact allowlist BEFORE any routing happens. Binding to 127.0.0.1 does
  // NOT stop DNS rebinding - the rebound request originates from the
  // victim's own browser, which is already on localhost by the time it
  // fires, so the packet legitimately arrives on this loopback socket. A
  // spoofed Host header (e.g. "evil.example.com") is the actual tell, and
  // this check is what catches it. Verified: `curl -H "Host:
  // evil.example.com" http://127.0.0.1:PORT/status` returned 200 before
  // this check existed; see README "Security scoping" for the fixed
  // re-run.
  const hostHeader = req.headers.host || '';
  if (!ALLOWED_HOST_HEADERS.has(hostHeader)) {
    return sendJson(res, 403, { error: 'invalid Host header' });
  }

  // SECURITY (FIFTH FINDING - "localhost drive-by", distinct from DNS
  // rebinding above): a Host-header allowlist alone does NOT stop a
  // hostile page in ANY browser tab on this Mac (not just our own
  // sandboxed one) from firing a request straight at
  // http://127.0.0.1:PORT/... - that request's Host header is legitimately
  // correct (it really is going to 127.0.0.1:PORT), no rebinding involved,
  // so the check above lets it through. Non-browser callers (this CLI, a
  // cockpit route, curl) never set an Origin header at all, so rejecting a
  // FOREIGN origin closes that class of attack.
  //
  // The one legitimate browser caller is our OWN /view page: its takeover
  // POSTs to /sessions/:id/input carry an Origin, and a blanket reject broke
  // the captcha-handover path this server exists to provide (the operator hit
  // "Origin header not allowed" tapping the reCAPTCHA from his phone over the
  // tailnet, 2026-08-23). ALLOWED_ORIGINS was already built at startup for
  // exactly this and was simply never consulted. Same-origin passes, anything
  // else is still refused.
  const originHeader = req.headers.origin;
  if (originHeader && !ALLOWED_ORIGINS.has(originHeader)) {
    return sendJson(res, 403, { error: 'Origin header not allowed' });
  }

  // SECURITY (HOLE 3): bearer token required on every endpoint, defence in
  // depth behind both checks above. Accepted via `Authorization: Bearer
  // <token>` (the CLI, a cockpit route) or `?token=` query param (the
  // /view HTML page's own polling and its <img> tag, which cannot set a
  // custom header, and the ntfy push's viewUrl link).
  const authHeader = req.headers.authorization || '';
  const bearerMatch = authHeader.match(/^Bearer (.+)$/);
  const suppliedToken = bearerMatch ? bearerMatch[1] : u.searchParams.get('token');
  // The master token grants everything (full scope). Failing that, a scoped
  // token (t-355, lib/scoped-tokens.js) authorizes ONLY the /live takeover
  // surface of its own session - see scoped.allows(). Anything else it touches
  // is a 401, same as no token at all.
  let scopeFull = false;
  if (safeTokenEqual(suppliedToken, TOKEN)) {
    scopeFull = true;
  } else {
    const sc = scoped.resolve(suppliedToken);
    if (!(sc && scoped.allows(sc, req.method, u.pathname, u.searchParams))) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
  }

  try {
    await browserReady;

    // ---- global ---------------------------------------------------------
    if (u.pathname === '/status' && req.method === 'GET') {
      return sendJson(res, 200, browser.status());
    }

    // Mint a short-lived, session-scoped token (t-355). MASTER-token only: a
    // scoped token must never be able to mint another (scopeFull is false for
    // scoped callers, and scoped.allows() never lists this path anyway, so a
    // scoped caller is already 401'd before reaching here - this is defence in
    // depth). A caller that pushes a link over the public ntfy relay should
    // call this so that link carries a scoped token, not the master credential.
    if (u.pathname === '/scoped-tokens' && req.method === 'POST') {
      if (!scopeFull) return sendJson(res, 403, { error: 'forbidden' });
      const body = await readBody(req);
      const sessionId = body.sessionId;
      if (!sessionId || !/^[a-z0-9]+$/.test(sessionId)) {
        return sendJson(res, 400, { error: 'missing/invalid sessionId' });
      }
      return sendJson(res, 200, scoped.mint(sessionId, body.ttlMs));
    }

    if (u.pathname === '/watch' && req.method === 'POST') {
      const { headless } = await readBody(req);
      if (headless === undefined) return sendJson(res, 400, { error: 'missing headless (bool)' });
      return sendJson(res, 200, await browser.setHeadless(!!headless));
    }

    // Job Hunt v2 proxy/VPN support (discovery only - see README "Proxy /
    // VPN exit profiles"). `profile` is a name from state/proxies.json, or
    // null/'off' to go back to a direct connection. Missing the field
    // entirely is a 400 (same discipline as /watch above); an explicit
    // null is a real, meaningful request ("turn it off"), not a missing one.
    if (u.pathname === '/proxy' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Object.prototype.hasOwnProperty.call(body, 'profile')) {
        return sendJson(res, 400, { error: 'missing profile (name string, or null/"off")' });
      }
      try {
        return sendJson(res, 200, await browser.setProxy(body.profile));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // Confirms what IP this context is ACTUALLY egressing as right now, by
    // fetching api.ipify.org through a real session - the proof a proxy
    // switch took effect, not just that setProxy() didn't throw. Optional
    // ?session=ID reuses an existing session instead of opening/closing a
    // transient one.
    if (u.pathname === '/proxy-check' && req.method === 'GET') {
      const requested = u.searchParams.get('session');
      const sessionId = (requested && /^[a-z0-9]+$/.test(requested)) ? requested : undefined;
      try {
        const result = await browser.checkEgressIp({ sessionId });
        // checkEgressIp() itself never throws for a page-load failure (a
        // dead proxy, for instance) - it catches that and returns
        // {error: ...} so status() can still show the last check either
        // way (see lib/atlas-browser.js). This route still surfaces a
        // failed check as a non-200, since a caller hitting /proxy-check
        // wants "did it actually work", not just "did the HTTP call
        // complete" - only a bad sessionId (getSession() throwing) reaches
        // the catch below.
        return sendJson(res, result.error ? 502 : 200, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (u.pathname === '/save-state' && req.method === 'POST') {
      return sendJson(res, 200, await browser.saveState());
    }

    if (u.pathname === '/view' && req.method === 'GET') {
      const requested = u.searchParams.get('session');
      // Defense in depth alongside the JSON.stringify()-only embedding in
      // VIEW_HTML: nextSessionId() (lib/atlas-browser.js) only ever
      // produces `s` + base36 digits, so anything outside that charset is
      // not a real session id and is dropped in favor of the default,
      // rather than handed to the template at all.
      const sessionId = (requested && /^[a-z0-9]+$/.test(requested)) ? requested : pickDefaultSessionId();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      // Embed the token the caller actually authenticated with, NOT the master
      // TOKEN (t-355): a scoped-token visitor's page must carry the scoped
      // token so its own screenshot/input requests stay session-bounded. A
      // master-token visitor (cli.js on the Mac) still gets the master token,
      // unchanged. Never serialize the master token into a page a scoped
      // (public-relay-reachable) visitor was served.
      return res.end(VIEW_HTML(sessionId, browser.listSessions(), suppliedToken));
    }

    // The new interactive surface (CDP screencast + full input relay over the
    // WebSocket at /sessions/:id/live). /view stays as the low-tech fallback.
    if (u.pathname === '/live' && req.method === 'GET') {
      const requested = u.searchParams.get('session');
      const sessionId = (requested && /^[a-z0-9]+$/.test(requested)) ? requested : pickDefaultSessionId();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      // Same as /view: embed the CALLER's token, not the master TOKEN, so a
      // scoped visitor's WS + input relay stay session-bounded (t-355).
      return res.end(LIVE_HTML(sessionId, browser.listSessions(), suppliedToken));
    }

    // ---- sessions (multi-tenant: one per god, addressable by id) --------
    if (u.pathname === '/sessions' && req.method === 'GET') {
      return sendJson(res, 200, { sessions: browser.listSessions() });
    }

    if (u.pathname === '/sessions' && req.method === 'POST') {
      const { god, label, url } = await readBody(req);
      if (!god) return sendJson(res, 400, { error: 'missing god (attribution required, e.g. "hermes", "atlas")' });
      const summary = await browser.openSession({ god, label });
      if (url) {
        await browser.open(summary.id, url);
        return sendJson(res, 200, browser.sessionSummary(browser.getSession(summary.id)));
      }
      return sendJson(res, 200, summary);
    }

    if (parts[0] === 'sessions' && parts.length === 2 && req.method === 'GET') {
      const s = browser.getSession(parts[1]);
      return sendJson(res, 200, browser.sessionSummary(s));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'close' && req.method === 'POST') {
      return sendJson(res, 200, await browser.closeSession(parts[1]));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'open' && req.method === 'POST') {
      const { url } = await readBody(req);
      if (!url) return sendJson(res, 400, { error: 'missing url' });
      return sendJson(res, 200, await browser.open(parts[1], url));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'read' && req.method === 'GET') {
      return sendJson(res, 200, await browser.readText(parts[1]));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'click' && req.method === 'POST') {
      const { selector } = await readBody(req);
      if (!selector) return sendJson(res, 400, { error: 'missing selector' });
      return sendJson(res, 200, await browser.click(parts[1], selector));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'type' && req.method === 'POST') {
      const { selector, text, enter } = await readBody(req);
      if (!selector || text === undefined) return sendJson(res, 400, { error: 'missing selector/text' });
      return sendJson(res, 200, await browser.type(parts[1], selector, text, { enter: !!enter }));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'fill' && req.method === 'POST') {
      const { selector, value } = await readBody(req);
      if (!selector || value === undefined) return sendJson(res, 400, { error: 'missing selector/value' });
      return sendJson(res, 200, await browser.fill(parts[1], selector, value));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'upload' && req.method === 'POST') {
      const { selector, path: filePath } = await readBody(req);
      if (!selector || !filePath) return sendJson(res, 400, { error: 'missing selector/path' });
      return sendJson(res, 200, await browser.upload(parts[1], selector, filePath));
    }

    // ---- form primitives (lib/form.js) ---------------------------------
    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'links' && req.method === 'GET') {
      return sendJson(res, 200, await browser.scanLinks(parts[1]));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'settle' && req.method === 'POST') {
      const { ms } = await readBody(req);
      return sendJson(res, 200, await browser.settle(parts[1], { ms }));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'form-scan' && req.method === 'GET') {
      return sendJson(res, 200, await browser.formScan(parts[1]));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'form-set' && req.method === 'POST') {
      const { ref, value } = await readBody(req);
      if (!ref || value === undefined) return sendJson(res, 400, { error: 'missing ref/value' });
      return sendJson(res, 200, await browser.formSet(parts[1], ref, value));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'form-values' && req.method === 'GET') {
      return sendJson(res, 200, await browser.formValues(parts[1]));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'form-check-combo' && req.method === 'POST') {
      const { ref, value } = await readBody(req);
      if (!ref || value === undefined) return sendJson(res, 400, { error: 'missing ref/value' });
      return sendJson(res, 200, await browser.formCheckCombo(parts[1], ref, value));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'form-submit' && req.method === 'POST') {
      const { ref, waitMs } = await readBody(req);
      if (!ref) return sendJson(res, 400, { error: 'missing ref' });
      return sendJson(res, 200, await browser.formSubmit(parts[1], ref, { waitMs }));
    }

    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'screenshot' && req.method === 'GET') {
      const { buf } = await browser.screenshotBuffer(parts[1], 'view');
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(buf);
    }

    // Human takeover input from the /view page. This is what turns a captcha
    // from a dead end (hunt for a hidden native window) into "open one URL,
    // point at the images, done" - solvable from any device, including a
    // phone, which is what the surface-blockers-to-the operator mission needs.
    // Token-gated like everything else (HOLE 3); the body is a single input
    // event already scaled to the real viewport by the page.
    if (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'input' && req.method === 'POST') {
      const event = await readBody(req);
      return sendJson(res, 200, await browser.dispatchInput(parts[1], event));
    }

    // ---- escalations (god-agnostic; works on any session, any god) ------
    if (u.pathname === '/escalate' && req.method === 'POST') {
      const { sessionId, reason, details, timeoutMs } = await readBody(req);
      if (!sessionId || !reason) return sendJson(res, 400, { error: 'missing sessionId/reason' });
      const s = browser.getSession(sessionId); // throws (-> 500 below) if unknown
      const { id, promise } = escalations.create({
        god: s.god,
        sessionId,
        reason,
        details,
        viewUrl: viewUrlFor(sessionId, timeoutMs),
        timeoutMs,
      });
      const result = await promise; // holds this request open; the session's page stays live and untouched throughout
      return sendJson(res, 200, { escalationId: id, ...result });
    }

    if (u.pathname === '/escalations' && req.method === 'GET') {
      return sendJson(res, 200, { escalations: escalations.list() });
    }

    if (parts[0] === 'escalations' && parts.length === 2 && req.method === 'GET') {
      const rec = escalations.get(parts[1]);
      if (!rec) return sendJson(res, 404, { error: 'no such escalation' });
      return sendJson(res, 200, rec);
    }

    if (parts[0] === 'escalations' && parts.length === 3 && parts[2] === 'answer' && req.method === 'POST') {
      const { answer } = await readBody(req);
      if (answer === undefined) return sendJson(res, 400, { error: 'missing answer' });
      return sendJson(res, 200, escalations.answer(parts[1], answer));
    }

    if (parts[0] === 'escalations' && parts.length === 3 && parts[2] === 'takeover' && req.method === 'POST') {
      const result = escalations.takeover(parts[1]);
      // make the session actually visible for the human taking over
      if (browser.headless) await browser.setHeadless(false);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'no such route', path: u.pathname });
  } catch (err) {
    return sendJson(res, 500, { error: String((err && err.message) || err) });
  }
};

const server = http.createServer(requestListener);

// Disable the idle-socket timeout: an /escalate request can legitimately
// hold its connection open for the full escalation timeout (default 10
// minutes, see lib/escalations.js), which is far past Node's old default
// socket timeout.
server.timeout = 0;
server.requestTimeout = 0;

// ---- WebSocket: the live screencast + input relay --------------------------
//
// A WS handshake cannot set an Authorization header from a browser, and it is
// NOT an http route, so the http request pipeline above never runs for it -
// the upgrade MUST re-apply the exact same fence itself before a single frame
// streams or a single input event lands:
//   - Host header on the same 127.0.0.1/localhost allowlist (HOLE 2).
//   - Origin: a WebSocket opened by our OWN /live page legitimately carries
//     Origin http://127.0.0.1:PORT, so - unlike the http path, which blanket-
//     rejects any Origin because no legitimate http caller is a web page -
//     the WS path allows ONLY our own origin and rejects every other. That is
//     the cross-site-WebSocket-hijack defense: a hostile page's WS carries
//     its own origin and is refused here even before the token check.
//   - bearer token via ?token= (HOLE 3), constant-time compared.
//   - session id restricted to the nextSessionId() charset, same as /view.
// maxPayload is tiny: every client->server message is one small input event.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function validateUpgrade(req) {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const parts = u.pathname.split('/').filter(Boolean);
  if (!(parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'live')) {
    return { ok: false, code: 404, reason: 'Not Found' };
  }
  const id = parts[1];
  if (!/^[a-z0-9]+$/.test(id)) return { ok: false, code: 400, reason: 'Bad Request' };

  const hostHeader = req.headers.host || '';
  if (!ALLOWED_HOST_HEADERS.has(hostHeader)) {
    return { ok: false, code: 403, reason: 'Forbidden' };
  }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return { ok: false, code: 403, reason: 'Forbidden' };
  }
  const suppliedToken = u.searchParams.get('token');
  // Master token, or a scoped token (t-355) bound to THIS exact session id.
  // A scoped token for a different session is rejected here just like a bad
  // token - the WS is the /live takeover's whole input+frame channel, so it
  // must be as tightly session-bound as scoped.allows() is on the http side.
  if (!safeTokenEqual(suppliedToken, TOKEN)) {
    const sc = scoped.resolve(suppliedToken);
    if (!sc || sc.sessionId !== id) {
      return { ok: false, code: 401, reason: 'Unauthorized' };
    }
  }
  return { ok: true, id };
}

function upgradeHandler(req, socket, head) {
  const check = validateUpgrade(req);
  if (!check.ok) {
    socket.write(`HTTP/1.1 ${check.code} ${check.reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onLiveConnection(ws, check.id));
}

server.on('upgrade', upgradeHandler);

async function onLiveConnection(ws, id) {
  const sendSafe = (obj) => { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch (_) {} } };
  let unsub = null;
  let metaTimer = null;
  const teardown = () => {
    if (metaTimer) { clearInterval(metaTimer); metaTimer = null; }
    if (unsub) { const fn = unsub; unsub = null; Promise.resolve(fn()).catch(() => {}); }
  };

  try {
    await browserReady;
    browser.getSession(id); // throws if unknown -> closed below
  } catch (err) {
    sendSafe({ type: 'error', error: String((err && err.message) || err) });
    ws.close();
    return;
  }

  ws.on('message', async (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch (_) { return sendSafe({ type: 'error', error: 'bad json' }); }
    try {
      // Route EVERY WS input through the same validated dispatchInput the
      // /input http endpoint uses - one clamp/whitelist path, never two.
      const result = await browser.dispatchInput(id, event);
      sendSafe({ type: 'ack', result });
    } catch (err) {
      sendSafe({ type: 'error', error: String((err && err.message) || err) });
    }
  });

  ws.on('close', teardown);
  ws.on('error', teardown);

  try {
    unsub = await browser.startScreencast(id, ({ data }) => sendSafe({ type: 'frame', data }));
  } catch (err) {
    sendSafe({ type: 'error', error: 'screencast failed: ' + String((err && err.message) || err) });
    ws.close();
    teardown();
    return;
  }

  // Push the current URL on connect and periodically, so the bar stays honest
  // as the page navigates. Cheap (one string every 1.5s), off the frame path.
  const pushMeta = () => {
    try { const s = browser.getSession(id); sendSafe({ type: 'meta', url: s.page.isClosed() ? null : s.page.url() }); }
    catch (_) { /* session went away; close path handles teardown */ }
  };
  pushMeta();
  metaTimer = setInterval(pushMeta, 1500);
}

server.listen(PORT, HOST, () => {
  console.log(`atlas-browser listening on http://${HOST}:${PORT} (localhost only)`);
});

// SECURITY (Tailscale /live, chosen approach over the alternatives below):
// binding ONLY 127.0.0.1 means a phone request over Tailscale to
// PUBLIC_HOST:PORT never reaches this process at all - Tailscale routes it
// to this Mac's Tailscale interface, not to loopback, and the two are
// different sockets. Three ways to close that gap were weighed:
//   (a) bind 0.0.0.0 - rejected outright, that is the whole LAN plus every
//       other interface, far wider than "the operator's own phone reaching his
//       own Mac over his own tailnet".
//   (b) an external proxy (`tailscale serve`, or a separate localhost
//       reverse-proxy) - safer in the abstract (this process never touches
//       a non-loopback socket at all) but adds a whole extra moving part
//       the operator would have to set up and keep running, for a feature whose
//       point is being usable with nothing more than his phone.
//   (c) bind the ONE specific Tailscale interface IP, in ADDITION to
//       127.0.0.1, never instead of it - what this does. Tailscale's own
//       network is itself a private, authenticated overlay (WireGuard,
//       device-keyed) - reaching 100.x.x.x at all already requires
//       being an authenticated device on the operator's tailnet, before this
//       server's own token + Host-allowlist fence is even reached. That is
//       a materially smaller exposure than (a), for zero extra moving
//       parts versus (b). Chosen.
// This second bind is CONDITIONAL: BIND_IP is null (see lib/network.js)
// unless state/tailscale_ip or ATLAS_BROWSER_TAILSCALE_IP says otherwise,
// so an untouched checkout - and every test in test/ , which sets neither -
// binds ONLY 127.0.0.1, unchanged from before this feature.
let tsServer = null;
if (BIND_IP) {
  tsServer = http.createServer(requestListener);
  tsServer.timeout = 0;
  tsServer.requestTimeout = 0;
  tsServer.on('upgrade', upgradeHandler);
  tsServer.listen(PORT, BIND_IP, () => {
    console.log(
      `atlas-browser ALSO listening on http://${BIND_IP}:${PORT} (Tailscale interface only - ` +
      `still token + Host-allowlist gated, see SECURITY comment above)`
    );
  });
}

process.on('SIGINT', async () => {
  console.log('shutting down atlas-browser...');
  await browser.close();
  if (tsServer) tsServer.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await browser.close();
  if (tsServer) tsServer.close();
  process.exit(0);
});
