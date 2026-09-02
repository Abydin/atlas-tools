'use strict';

// Core browser manager. Owns exactly ONE Playwright persistent Chromium
// context (one profile, one login state) shared by MULTIPLE concurrent,
// NAMED sessions - one page/tab per session, each attributed to the god
// that opened it. This is a shared surface for the whole pantheon (a
// Round Table with several gods active must not have them fighting over
// one page), not an Atlas-only singleton.
//
// Headless by default; can flip to headed on request (see setHeadless).
// Headless/headed is a property of the shared context, not of a single
// session: flipping it relaunches the context and reopens every currently
// open session as a tab in that one window (or back to invisible). There
// is no per-session headless - Playwright does not support that, and
// the operator watching "the browser" watching every god's open tab in one
// real window is the intended shape, not a limitation to work around.
//
// Never touches the operator's Arc profile - USER_DATA_DIR is a dedicated
// directory under this project only.
//
// BROWSER CHANNEL: default is Playwright's OWN pinned bundled build
// (chromium-1228, Chrome for Testing 149.0.7827.55) - this is what
// Playwright is tested against and cannot silently auto-update under us.
// The automatic `npx playwright install chromium` download stalled dead
// on this connection (0 bytes moved over an 8s sample); the operator downloaded
// the release ZIPs by hand and they were installed via
// scripts/install_playwright_chromium.sh into the standard
// ~/Library/Caches/ms-playwright/ location, so Playwright's own
// executablePath() resolution finds it with no extra config.
// ATLAS_BROWSER_CHANNEL=chrome remains available as a documented fallback
// (drives locally installed /Applications/Google Chrome.app instead) for a
// machine where the pinned build isn't installed yet - same sandbox
// boundary, but subject to Chrome's own auto-update shifting behavior
// between runs, which the pinned build does not.
//
// SECURITY (carried from t-349 / t-350 spec, do not weaken):
//   - Sandbox stays on. We never pass --no-sandbox or --disable-web-security.
//   - We never pass --remote-debugging-port/--remote-debugging-address.
//     Playwright's default launch uses a local pipe transport for CDP, not
//     a TCP port, so there is no debug port to leak off localhost in the
//     first place as long as we don't add one ourselves.
//   - This module never shells out (no child_process, no eval of page
//     content). Every string read off a page (innerText, attribute values,
//     console messages) is treated as inert data, never as a command.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { USER_DATA_DIR, STORAGE_STATE, UPLOADS_DIR } = require('./paths');
const { Recorder } = require('./recorder');
const { assertSafeUrl } = require('./url-guard');
const { assertSafeDestination, assertSafeServerAddress } = require('./host-guard');
const formLib = require('./form');
const { getProxyProfile, playwrightProxyOption } = require('./proxies');
const { FINGERPRINT_INIT_SCRIPT, getDesktopUserAgent } = require('./fingerprint-normalize');

const LAUNCH_ARGS_FORBIDDEN_CHECK = (args) => {
  const banned = ['--no-sandbox', '--disable-web-security', '--remote-debugging-port', '--remote-debugging-address'];
  for (const a of args || []) {
    if (banned.some((b) => a.startsWith(b))) {
      throw new Error(`refusing to launch: forbidden Chromium arg ${a}`);
    }
  }
};

// Headless-vs-desktop browser parity (see lib/fingerprint-normalize.js for
// the full "why"): some ATS-hosted application forms flag and reject
// fully-honest, correctly-filled submissions as spam purely because the
// Chromium instance reads as headless (navigator.webdriver, missing
// plugins/chrome object, an old-style "HeadlessChrome" UA). This flag
// alone was measured to flip navigator.webdriver to false at the Chromium
// level (not just a page-side shim) - it belongs in the launch args, not
// the init script, which is why it lives here rather than in
// fingerprint-normalize.js.
const PARITY_LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];

// undefined (default) = Playwright's own pinned bundled Chromium.
// 'chrome' = locally installed Google Chrome, the documented fallback.
// Never anything else.
const BROWSER_CHANNEL = process.env.ATLAS_BROWSER_CHANNEL === 'chrome' ? 'chrome' : undefined;

let sessionSeq = 0;
function nextSessionId() {
  sessionSeq += 1;
  return `s${Date.now().toString(36)}${sessionSeq}`;
}

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
function guessMimeType(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

class AtlasBrowser {
  constructor() {
    this.context = null;
    this.headless = true;
    // Active proxy/VPN exit profile NAME (see lib/proxies.js), or null =
    // off = direct connection. Property of the whole shared context/launch,
    // exactly like `headless` above - Playwright has no per-page proxy on a
    // shared context, only per-context/per-launch, and this service already
    // committed to ONE shared context for every god's sessions (see file
    // header). setProxy() below relaunches under the chosen proxy the same
    // way setHeadless() relaunches under the chosen headless value.
    this.proxyProfile = null;
    // The resolved profile object (server/timezoneId/geolocation/locale) for
    // whatever this.proxyProfile currently names, or null. Kept alongside
    // the name so status()/checkEgressIp() don't have to re-read
    // state/proxies.json (which could have changed under us) to describe
    // what is ACTUALLY live in this launched context.
    this._activeProxyConfig = null;
    // Last confirmed egress IP check (see checkEgressIp()). null until the
    // first check ever runs. This is the PROOF surface: status() and the
    // return value of setProxy() both expose this so switching a profile
    // is confirmed, not just assumed to have taken effect.
    this.lastEgressCheck = null;
    // sessionId -> { id, god, label, page, recorder, createdAt }
    this.sessions = new Map();
    this.startedAt = new Date().toISOString();
  }

  async launch({ headless = true, proxyProfileName = null } = {}) {
    LAUNCH_ARGS_FORBIDDEN_CHECK(PARITY_LAUNCH_ARGS);
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    // HOLE 4 fix: the staging dir upload() confines itself to must exist
    // before any session can try to use it.
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    // Resolve the named profile (throws a clear "unknown profile" error if
    // it doesn't exist in state/proxies.json) BEFORE launching, so a typo'd
    // profile name fails loudly instead of silently launching direct.
    const profile = proxyProfileName ? getProxyProfile(proxyProfileName) : null;
    const proxyOption = playwrightProxyOption(profile);

    // Real desktop-Chrome UA (see lib/fingerprint-normalize.js) - derived from this same
    // pinned build, not hardcoded, so it can never drift out of sync with
    // whichever Chromium/Chrome the channel above actually resolves to.
    const desktopUserAgent = await getDesktopUserAgent(chromium, BROWSER_CHANNEL);

    const hasState = fs.existsSync(STORAGE_STATE);
    this.context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless,
      channel: BROWSER_CHANNEL, // 'chrome' fallback, see BROWSER CHANNEL note above
      // CRITICAL: Playwright's own default is `chromiumSandbox !== true` ->
      // pushes --no-sandbox onto the launch args. Confirmed by inspecting
      // node_modules/playwright-core/lib/coreBundle.js directly: without
      // this explicit `true`, EVERY launch silently got --no-sandbox even
      // though nothing in this file ever passes that flag itself. This
      // caught a real violation of the "sandbox stays on" rule during
      // build verification (2026-07-21) - do not remove this line.
      chromiumSandbox: true,
      // Headless-vs-desktop browser parity, see PARITY_LAUNCH_ARGS above and
      // lib/fingerprint-normalize.js for the measured "why". Passed through
      // the same LAUNCH_ARGS_FORBIDDEN_CHECK as every other arg this file
      // could ever pass, so the sandbox/no-debug-port guarantees above stay
      // load-bearing rather than bypassed by a second unchecked args list.
      args: PARITY_LAUNCH_ARGS,
      userAgent: desktopUserAgent,
      // HOLE 5 hardening: this is a job-application browser (fill forms,
      // upload a staged resume) - the flow never needs to PULL a file down
      // from a visited page. acceptDownloads defaults to true in Playwright;
      // explicitly false turns "nothing here calls download.saveAs()" (true
      // today, but incidental) into a guarantee that a visited page cannot
      // make Chromium write a file to disk at all, regardless of what any
      // future code path does or doesn't call.
      acceptDownloads: false,
      viewport: { width: 1280, height: 900 },
      // Proxy/VPN support: `proxy` is undefined (Playwright's
      // own "no proxy" contract) when no profile is active. When a profile
      // IS active, timezoneId/locale/geolocation come from the SAME
      // profile so a US exit IP also reports America/New_York + NYC
      // coords - a mismatched timezone/IP pair is a well-known bot tell.
      // permissions:['geolocation'] is only granted when a profile sets
      // one, so an off/no-profile launch behaves exactly as before this
      // feature (no new permission grant with nothing to back it).
      proxy: proxyOption,
      timezoneId: profile && profile.timezoneId ? profile.timezoneId : undefined,
      // Default to a real desktop locale (en-US) rather than leaving this
      // undefined - Playwright/Chromium reports a single-entry
      // navigator.languages with no locale set, which is itself a checked
      // automation tell; a proxy profile's own locale still wins when set,
      // exactly as before.
      locale: (profile && profile.locale) || 'en-US',
      geolocation: profile && profile.geolocation ? profile.geolocation : undefined,
      permissions: profile && profile.geolocation ? ['geolocation'] : undefined,
      // storageState only applies on first-ever profile creation in Playwright's
      // model; when using launchPersistentContext there is no separate
      // storageState param, so we import cookies into the context below instead.
    });
    this.headless = headless;
    this.proxyProfile = proxyProfileName || null;
    this._activeProxyConfig = profile;

    // Apply the JS/DOM-level fingerprint normalization (lib/fingerprint-normalize.js) to every
    // page in this context from here on - addInitScript() runs before any
    // page script on every new document, including iframes, in every tab
    // opened after this call. Must run before the "close the stray blank
    // page" loop below is relied upon by anything, and well before any
    // session ever calls openSession()/newPage(), so there is no window
    // where a page exists without it.
    await this.context.addInitScript(FINGERPRINT_INIT_SCRIPT);

    if (hasState) {
      try {
        const state = JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf8'));
        if (Array.isArray(state.cookies) && state.cookies.length) {
          await this.context.addCookies(state.cookies);
        }
        // origins (localStorage) require a page per origin; best-effort only,
        // cookies cover the common auth case.
        this._importedState = true;
      } catch (err) {
        // no session yet to attribute this to; log to stderr, not fatal.
        console.error('[atlas-browser] failed to import storageState:', err.message);
      }
    }

    // Playwright always opens one blank page on persistent-context launch.
    // Close it - sessions create their own pages explicitly, so the
    // context never carries a stray untracked tab.
    for (const p of this.context.pages()) {
      await p.close().catch(() => {});
    }

    return this;
  }

  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.sessions.clear();
    }
  }

  // ---- session management -------------------------------------------------

  /** Opens a new named, god-attributed tab. Returns the session summary. */
  async openSession({ god, label } = {}) {
    if (!god) throw new Error('openSession requires a god name');
    const id = nextSessionId();
    const page = await this.context.newPage();
    const recorder = new Recorder(god); // per-session transcript + screenshots, tagged by god
    const session = { id, god, label: label || null, page, recorder, createdAt: new Date().toISOString() };
    this.sessions.set(id, session);
    // SSRF fix: open()'s pre/post-navigation checks below only cover
    // navigations WE initiate via goto(). A hostile page can navigate
    // itself afterward - a client-side redirect, a <meta refresh>, a form
    // that auto-submits, `window.location` from injected/compromised JS -
    // and none of that goes through open()'s call path. `framenavigated`
    // fires for every top-level navigation regardless of who caused it, so
    // it is the one hook that actually covers page-initiated navigation,
    // closing the gap the README's SSRF claim used to overstate (it
    // described the guard as covering "a hostile page" in general, when
    // in fact only OUR OWN goto() calls were checked). Same denylist,
    // fire-and-forget from this sync event handler since page.on() cannot
    // be awaited; unsafe destinations get blanked immediately.
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return; // only the top-level document matters for SSRF
      this._guardFrameNavigation(session, frame.url()).catch(() => {});
    });
    recorder.log({ type: 'session-open', id, god, label: session.label });
    return this.sessionSummary(session);
  }

  // Re-validates a navigation the PAGE itself caused (see framenavigated
  // listener above). Mirrors open()'s post-navigation checks but has no
  // caller to throw back to, so on an unsafe destination it logs and
  // blanks the page rather than raising - the guard closes the exposure
  // window, it can't fail the request that's no longer in flight.
  async _guardFrameNavigation(session, url) {
    if (!url || url === 'about:blank') return;
    try {
      assertSafeUrl(url);
      await assertSafeDestination(url);
    } catch (err) {
      session.recorder.log({ type: 'ssrf-blocked-page-navigation', god: session.god, url, error: err.message });
      console.error(`[atlas-browser] SECURITY: blocked page-initiated navigation to "${url}" (session ${session.id}): ${err.message}`);
      if (!session.page.isClosed()) {
        await session.page.goto('about:blank').catch(() => {});
      }
    }
  }

  getSession(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no such session: ${id}`);
    return s;
  }

  sessionSummary(s) {
    return {
      id: s.id,
      god: s.god,
      label: s.label,
      url: s.page.isClosed() ? null : s.page.url(),
      createdAt: s.createdAt,
      artifactsDir: s.recorder.dir,
    };
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => this.sessionSummary(s));
  }

  async closeSession(id) {
    const s = this.getSession(id);
    // Tear down any live screencast first so its CDP session and Chromium-side
    // capture do not dangle once the page is gone. stopScreencast reads from
    // the live map, so run it BEFORE deleting the session below.
    if (s.screencast) {
      try { if (s.screencast.started) await s.screencast.cdp.send('Page.stopScreencast'); } catch (_) {}
      try { await s.screencast.cdp.detach(); } catch (_) {}
      s.screencast = null;
    }
    s.recorder.log({ type: 'session-close' });
    await s.page.close().catch(() => {});
    this.sessions.delete(id);
    return { closed: id };
  }

  // Shared relaunch machinery behind setHeadless() and setProxy() below.
  // Playwright cannot toggle headless OR change the proxy on a live
  // context - both are launch-time-only properties - so both callers close
  // and relaunch the ONE shared context under the new (headless,
  // proxyProfileName) pair, and every currently open session is recreated
  // as a fresh tab at its last known URL so the SET of god-owned sessions
  // survives the relaunch; in-page form state within each tab does not.
  async _relaunchPreservingSessions({ headless, proxyProfileName }) {
    const toRestore = Array.from(this.sessions.values()).map((s) => ({
      god: s.god,
      label: s.label,
      url: s.page.isClosed() ? null : s.page.url(),
    }));

    await this.close();
    await this.launch({ headless, proxyProfileName });

    for (const r of toRestore) {
      const summary = await this.openSession({ god: r.god, label: r.label });
      // r.url only ever came from a page that was already live in THIS
      // process (it was read back via page.url(), never caller input), so
      // this is not the same trust boundary as open()'s `url` argument.
      // Still runs it through the same guard for defense in depth, so
      // url-guard.js's "the ONLY place that decides" comment stays true in
      // practice, not just in the common path.
      if (r.url && r.url !== 'about:blank') {
        try {
          assertSafeUrl(r.url);
        } catch (_) {
          continue; // was already impossible in practice; skip rather than throw mid-restore
        }
        const s = this.getSession(summary.id);
        await s.page.goto(r.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }

    return this.listSessions();
  }

  // Flips headless <-> headed for ALL sessions. Proxy stays whatever it
  // currently is - this only ever changes `headless`.
  async setHeadless(headless) {
    if (headless === this.headless) return { changed: false, headless: this.headless };
    const sessions = await this._relaunchPreservingSessions({ headless, proxyProfileName: this.proxyProfile });
    return { changed: true, headless: this.headless, sessions };
  }

  // Switches the whole shared context to a named proxy/VPN exit profile
  // (state/proxies.json, see lib/proxies.js), or back to direct with
  // `null`/`'off'`. Headless stays whatever it currently is - this only
  // ever changes the proxy. Relaunches (see _relaunchPreservingSessions
  // above) and then immediately runs an egress-IP check against the NEW
  // context, so the return value is proof the switch took effect, not just
  // an assertion that it did - see checkEgressIp() below and README "Proxy
  // / VPN exit profiles" for what this can and cannot prove without a real
  // proxy endpoint configured.
  async setProxy(profileName) {
    const normalized = profileName === 'off' ? null : (profileName || null);
    if (normalized) {
      // Resolve up front so an unknown name fails BEFORE tearing down the
      // current (working) context, not after - a typo should never cost a
      // live session set.
      getProxyProfile(normalized);
    }
    if (normalized === this.proxyProfile) {
      return { changed: false, proxyProfile: this.proxyProfile };
    }
    const sessions = await this._relaunchPreservingSessions({ headless: this.headless, proxyProfileName: normalized });
    const egressCheck = await this.checkEgressIp().catch((err) => ({ error: err.message }));
    return {
      changed: true,
      proxyProfile: this.proxyProfile,
      server: this._activeProxyConfig ? this._activeProxyConfig.server : null,
      headless: this.headless,
      sessions,
      egressCheck,
    };
  }

  // Opens (or reuses) a session and fetches api.ipify.org through it to see
  // what IP this context is ACTUALLY egressing as right now - the proof
  // that a proxy switch really changed the route, not just that the config
  // loaded and setProxy() didn't throw. Uses a transient session (closed
  // afterward) unless an existing sessionId is passed in. Stores the result
  // on this.lastEgressCheck so status() reflects the last-known egress
  // without every /status call needing a fresh network round trip.
  async checkEgressIp({ sessionId } = {}) {
    let session;
    let transient = false;
    if (sessionId) {
      session = this.getSession(sessionId);
    } else {
      const summary = await this.openSession({ god: 'system', label: 'proxy-check' });
      session = this.getSession(summary.id);
      transient = true;
    }
    try {
      let result;
      try {
        await this.open(session.id, 'https://api.ipify.org/?format=json');
        const { text } = await this.readText(session.id);
        let ip = null;
        try {
          ip = JSON.parse(text).ip || null;
        } catch (_) {
          // ipify is expected to return clean JSON; if it ever doesn't, fall
          // through with ip: null rather than throwing - this check itself
          // is diagnostic, not a page the rest of the service depends on.
        }
        result = { ip, raw: text, proxyProfile: this.proxyProfile, checkedAt: new Date().toISOString() };
      } catch (err) {
        // A dead/unreachable proxy makes THIS fail (connection refused/DNS
        // error through the proxy) - that failure IS the proof the proxy is
        // really in the path rather than silently ignored, so it is
        // recorded here rather than left as an uncaught rejection. Callers
        // (the /proxy-check route, setProxy()'s own bundled check) inspect
        // `.error` to tell success from failure; status() needs this
        // recorded too, which is exactly why this is caught here rather
        // than thrown past this method.
        result = { ip: null, error: err.message, proxyProfile: this.proxyProfile, checkedAt: new Date().toISOString() };
      }
      this.lastEgressCheck = result;
      return result;
    } finally {
      if (transient) await this.closeSession(session.id).catch(() => {});
    }
  }

  async saveState() {
    const state = await this.context.storageState();
    fs.writeFileSync(STORAGE_STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { fs.chmodSync(STORAGE_STATE, 0o600); } catch (_) {}
    return { cookies: state.cookies.length, origins: state.origins.length };
  }

  // ---- per-session actions --------------------------------------------------

  async screenshotBuffer(id, label) {
    const s = this.getSession(id);
    // Bounded: the default is 30s and a page with slow webfonts can sit on
    // "waiting for fonts to load" for the whole of it. Observed live on
    // zeitlabs during the first form-runner pass, where an audit screenshot
    // timing out took down the whole navigation that had already succeeded.
    const buf = await s.page.screenshot({ type: 'png', timeout: 10000, animations: 'disabled' });
    const outPath = s.recorder.nextScreenshotPath(label);
    fs.writeFileSync(outPath, buf);
    return { buf, path: outPath };
  }

  // Audit-trail screenshots are evidence, not the operation. A page that
  // cannot be photographed has still been navigated/clicked successfully, so
  // these call sites must not inherit the screenshot's failure. The strict
  // screenshotBuffer stays strict for /screenshot and the live view, which
  // genuinely have nothing to return without an image.
  async screenshotSafe(id, label) {
    try {
      return await this.screenshotBuffer(id, label);
    } catch (err) {
      return { buf: null, path: null, error: err.message };
    }
  }

  async open(id, url) {
    const s = this.getSession(id);
    // HOLE 1 fix: validate the scheme BEFORE goto is ever called. See
    // lib/url-guard.js for why this is boundary validation, not
    // page.route() interception, and why string-prefix matching is not
    // used. Throws (-> 500 at the HTTP layer) on file:/data:/javascript:/etc.
    assertSafeUrl(url);
    // HOLE 5 fix: validate the destination HOST before goto too - a safe
    // scheme pointed at an internal address is still an SSRF vector (see
    // lib/host-guard.js header for the full threat model and the DNS-
    // rebinding TOCTOU this pre-check alone does not close).
    await assertSafeDestination(url);
    const response = await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Re-check AFTER navigation: a redirect chain is a second place a
    // disallowed scheme OR an internal host could be reached even though
    // the URL we were asked to visit was fine (see README "Security
    // scoping" for the redirect probe that verified Chromium's own
    // behavior here - it already refuses to hand a network-scheme
    // navigation off to file:, but this assertion makes that refusal
    // load-bearing rather than assumed). If the final URL is ever unsafe,
    // blank the page immediately so no disallowed content is left loaded
    // in this session.
    try {
      assertSafeUrl(s.page.url());
      await assertSafeDestination(s.page.url());
      // Belt-and-braces beyond the hostname re-check above: ask Playwright
      // for the address it ACTUALLY connected to for this response (see
      // host-guard.js's assertSafeServerAddress doc for exactly what this
      // does and does not close against DNS rebinding).
      // When a proxy profile is active (e.g. the local Cloudflare WARP SOCKS5
      // at 127.0.0.1:40000), Playwright connects through the proxy socket, so
      // response.serverAddr() reports the LOCAL proxy address (127.0.0.1), not
      // the real destination. That carries no SSRF signal and would false-
      // positive on every page, so skip this belt-and-braces check while a
      // proxy is active. The hostname guards (assertSafeDestination, run both
      // pre- and post-navigation just above) still protect against navigating
      // to an internal host.
      if (response && !this.proxyProfile) {
        const serverAddr = await response.serverAddr().catch(() => null);
        assertSafeServerAddress(serverAddr, { url: s.page.url() });
      }
    } catch (err) {
      await s.page.goto('about:blank').catch(() => {});
      throw err;
    }
    const shot = await this.screenshotSafe(id, 'open');
    const result = { url: s.page.url(), title: await s.page.title() };
    s.recorder.log({ type: 'open', god: s.god, url, resultUrl: result.url, title: result.title, screenshot: shot.path });
    return result;
  }

  async readText(id) {
    const s = this.getSession(id);
    const text = await s.page.evaluate(() => (document.body ? document.body.innerText : ''));
    const title = await s.page.title();
    s.recorder.log({ type: 'read', god: s.god, url: s.page.url(), chars: text.length });
    return { url: s.page.url(), title, text };
  }

  async click(id, selector) {
    const s = this.getSession(id);
    await s.page.click(selector, { timeout: 10000 });
    const shot = await this.screenshotSafe(id, 'click');
    s.recorder.log({ type: 'click', god: s.god, selector, screenshot: shot.path });
    return { clicked: selector };
  }

  async type(id, selector, text, { enter = false } = {}) {
    const s = this.getSession(id);
    await s.page.fill(selector, text, { timeout: 10000 });
    if (enter) await s.page.press(selector, 'Enter');
    const shot = await this.screenshotSafe(id, 'type');
    s.recorder.log({ type: 'type', god: s.god, selector, length: text.length, enter, screenshot: shot.path });
    return { typed: selector };
  }

  // Raw human input dispatched at viewport coordinates, NOT at a selector.
  // This is what makes the /view stream a real takeover surface instead of a
  // watch-only mirror: a captcha (hcaptcha image grid, "type the text")
  // renders inside a cross-origin iframe with no selector we can reach, but a
  // human watching the screenshot can point at it. The coordinates arrive
  // already scaled to the real 1280x900 viewport by the /view page, which
  // knows the displayed image size; here we just play them into the page.
  // Everything is logged, because this is a human acting AS the operator through
  // our process and the audit trail must show it was a person, not the runner.
  async dispatchInput(id, event) {
    const s = this.getSession(id);
    const kind = event && event.kind;
    if (kind === 'click') {
      const x = Number(event.x);
      const y = Number(event.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('click needs finite x,y');
      }
      // Clamp into the viewport so a mis-scaled coord can never dispatch
      // off-page (Playwright would throw, but a clamp is a cleaner boundary).
      const cx = Math.max(0, Math.min(1279, x));
      const cy = Math.max(0, Math.min(899, y));
      await s.page.mouse.click(cx, cy);
      s.recorder.log({ type: 'human_click', god: s.god, x: cx, y: cy });
      return { dispatched: 'click', x: cx, y: cy };
    }
    if (kind === 'drag') {
      // The whole reason the /live surface exists: a slider/"move-the-tile"
      // captcha needs a real press-move-release, not a click. Coordinates
      // arrive already scaled to the 1280x900 viewport by the /live page;
      // clamp each end into the viewport exactly like click does so a
      // mis-scaled coord can never dispatch off-page.
      const fromX = Number(event.fromX);
      const fromY = Number(event.fromY);
      const toX = Number(event.toX);
      const toY = Number(event.toY);
      if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
        throw new Error('drag needs finite fromX,fromY,toX,toY');
      }
      const clamp = (v, max) => Math.max(0, Math.min(max, v));
      const fx = clamp(fromX, 1279), fy = clamp(fromY, 899);
      const tx = clamp(toX, 1279), ty = clamp(toY, 899);
      // Bound the interpolation step count: a human-solvable drag never needs
      // hundreds of intermediate moves, and an unbounded value from the wire
      // is a needless way to make the page do work. 12 is the spec default.
      const steps = Math.max(1, Math.min(60, Math.floor(Number(event.steps)) || 12));
      await s.page.mouse.move(fx, fy);
      await s.page.mouse.down();
      await s.page.mouse.move(tx, ty, { steps });
      await s.page.mouse.up();
      s.recorder.log({ type: 'human_drag', god: s.god, fromX: fx, fromY: fy, toX: tx, toY: ty, steps });
      return { dispatched: 'drag', fromX: fx, fromY: fy, toX: tx, toY: ty, steps };
    }
    if (kind === 'type') {
      const text = String(event.text == null ? '' : event.text);
      // Playwright caps nothing here, but a human typing a captcha answer is
      // short; a runaway paste is not what this path is for.
      if (text.length > 2000) throw new Error('type text too long');
      await s.page.keyboard.type(text);
      s.recorder.log({ type: 'human_type', god: s.god, length: text.length });
      return { dispatched: 'type', length: text.length };
    }
    if (kind === 'key') {
      // A named key: Enter, Backspace, Tab, ArrowDown, etc. Whitelist the
      // shape so this cannot be turned into an arbitrary key-combo channel.
      const key = String(event.key || '');
      if (!/^[A-Za-z0-9]+$/.test(key)) throw new Error('unsupported key');
      await s.page.keyboard.press(key);
      s.recorder.log({ type: 'human_key', god: s.god, key });
      return { dispatched: 'key', key };
    }
    if (kind === 'scroll') {
      const dy = Number(event.dy) || 0;
      await s.page.mouse.wheel(0, dy);
      s.recorder.log({ type: 'human_scroll', god: s.god, dy });
      return { dispatched: 'scroll', dy };
    }
    throw new Error(`unknown input kind: ${kind}`);
  }

  // Live video feed via the Chrome DevTools Protocol screencast, on the SAME
  // headless page - no headed window, no context relaunch, so a filled form
  // survives untouched (the exact thing setHeadless(false) destroys). One CDP
  // session per browser session, stored on the session object and shared by
  // every /live client watching it; startScreencast is only sent to Chromium
  // once, on the first listener, and stopScreencast/detach only fire once the
  // last listener leaves. Returns an unsubscribe fn.
  //
  // ACKING: Page.startScreencast STALLS after a couple of frames if each
  // frame is not acked, so the single handler acks FIRST (before fanning out
  // to listeners, and even if a listener throws) - the stream must never wedge
  // because a client is slow or errored.
  async startScreencast(id, onFrame) {
    const s = this.getSession(id);
    if (typeof onFrame !== 'function') throw new Error('startScreencast needs an onFrame callback');
    if (!s.screencast) {
      const cdp = await s.page.context().newCDPSession(s.page);
      const listeners = new Set();
      cdp.on('Page.screencastFrame', async (payload) => {
        const { data, metadata, sessionId } = payload;
        try {
          await cdp.send('Page.screencastFrameAck', { sessionId });
        } catch (_) {
          // page navigated/closed mid-frame; the stop path will clean up
        }
        // Cache the most recent frame so a client that joins an ALREADY-running
        // screencast on a static page (CDP only emits on repaint) gets the
        // current picture at once instead of a blank canvas until the next paint.
        s.screencast.lastFrame = { data, metadata };
        for (const fn of listeners) {
          try { fn({ data, metadata }); } catch (_) { /* one bad listener never stalls the rest */ }
        }
      });
      s.screencast = { cdp, listeners, started: false, lastFrame: null };
    }
    const sc = s.screencast;
    sc.listeners.add(onFrame);
    // A late joiner gets the cached frame immediately (next tick, so the caller
    // has returned and wired up its own send path first).
    if (sc.started && sc.lastFrame) {
      const frame = sc.lastFrame;
      setImmediate(() => { try { onFrame(frame); } catch (_) {} });
    }
    if (!sc.started) {
      await sc.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        everyNthFrame: 1,
        maxWidth: 1280,
        maxHeight: 900,
      });
      sc.started = true;
      s.recorder.log({ type: 'screencast-start', god: s.god });
    }
    return () => this.stopScreencast(id, onFrame);
  }

  async stopScreencast(id, onFrame) {
    const s = this.sessions.get(id);
    if (!s || !s.screencast) return { stopped: false };
    const sc = s.screencast;
    if (onFrame) sc.listeners.delete(onFrame);
    if (sc.listeners.size > 0) return { stopped: false, listeners: sc.listeners.size };
    try { if (sc.started) await sc.cdp.send('Page.stopScreencast'); } catch (_) {}
    try { await sc.cdp.detach(); } catch (_) {}
    s.screencast = null;
    s.recorder.log({ type: 'screencast-stop', god: s.god });
    return { stopped: true };
  }

  async fill(id, selector, value) {
    return this.type(id, selector, value, { enter: false });
  }

  // Form primitives (lib/form.js). These are the "what is this page asking
  // for" half of the API, as opposed to the "click this selector" half above.
  // Added for a generic form runner, which arrives at unseen forms on
  // many different hosts and must map fields by meaning, not by selector.
  async formScan(id) {
    const s = this.getSession(id);
    const scan = await formLib.scanForm(s.page);
    s.recorder.log({ type: 'form-scan', god: s.god, url: s.page.url(), fields: scan.fields.length });
    return scan;
  }

  async scanLinks(id) {
    const s = this.getSession(id);
    const links = await formLib.scanLinks(s.page);
    s.recorder.log({ type: 'links', god: s.god, url: s.page.url(), count: links.length });
    return { url: s.page.url(), links };
  }

  // Waits for a page to settle before reading. Client-rendered form sites
  // return an empty body if read the instant goto() resolves, which silently
  // looks like "no form here" - verified directly against a real client-
  // rendered board, which read as 0 chars until it was given time.
  async settle(id, { ms = 3000 } = {}) {
    const s = this.getSession(id);
    try {
      await s.page.waitForLoadState('networkidle', { timeout: ms });
    } catch {
      // fall through to the fixed wait; networkidle often never fires
    }
    await s.page.waitForTimeout(800);
    return { url: s.page.url() };
  }

  async formSet(id, ref, value) {
    const s = this.getSession(id);
    // Text inputs / textareas: fill through Playwright's page.fill rather than
    // the in-page native-setter evaluate in setField. Both use React's native
    // value setter, but page.fill does the full focus/clear/set/event sequence
    // that a real React app's onChange handler reliably catches (and it
    // lands AFTER any autofill repaint). The evaluate path left fields
    // visually populated but React-empty, so a real form rejected the submit
    // with "missing required field". Verified: page.fill sticks where evaluate
    // did not. Selects / radios / checkboxes / comboboxes keep setField.
    const sel = formLib.selectorForRef(ref);
    try {
      const handle = await s.page.$(sel);
      if (handle) {
        const meta = await handle.evaluate((n) => ({
          tag: n.tagName.toLowerCase(),
          type: (n.getAttribute('type') || '').toLowerCase(),
          isCombobox: n.getAttribute('role') === 'combobox' || n.getAttribute('aria-haspopup') === 'listbox',
        }));
        // The comment above promises comboboxes "keep setField", but this
        // check never actually looked at role/aria-haspopup - only tag and
        // type. Some modern ATS boards render
        // their Country/Location/work-auth comboboxes as a plain <input
        // role="combobox">, which is not excluded by the type blocklist
        // below, so every one of them was silently taking the plain
        // page.fill() fast path meant for real text fields: a bare native-
        // setter value write with no click to open the widget and no
        // keyboard event to drive its filter/selection. page.fill() still
        // "succeeds" (the input accepts a value), so this returned
        // {ok:true} unconditionally, without the widget ever registering a
        // real pick - setCombobox()'s whole click+type+keyboard-select+
        // verify pipeline (built and proven live on a real production board,
        // see comments on setCombobox/comboboxShowsValue below) never ran at
        // all. Root cause of a Country/Location/work-auth combobox
        // regression across every board using that widget pattern: a caller
        // built on top of this kept "correcting" these fields for five
        // rounds and escalating them as "kept reverting to Select..." - in
        // truth nothing had ever committed in the first place, on any of
        // the rounds, because every one of those five retries took this
        // same broken fast path too.
        const fillable = !meta.isCombobox && (meta.tag === 'textarea'
          || (meta.tag === 'input' && !['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image'].includes(meta.type)));
        if (fillable) {
          await s.page.fill(sel, String(value), { timeout: 8000 });
          s.recorder.log({ type: 'form-set', god: s.god, ref, ok: true, via: 'page.fill' });
          return { ok: true, set: String(value).slice(0, 80) };
        }
      }
    } catch (err) {
      // Fall through to setField; a fill failure on an odd control should not
      // abort the field, setField may still handle it (custom combobox etc.).
    }
    const result = await formLib.setField(s.page, ref, value);
    // Never log the value itself: free-text answers and personal details go
    // through here, and artifacts/ is a shared pantheon surface.
    s.recorder.log({ type: 'form-set', god: s.god, ref, ok: !!result.ok });
    return result;
  }

  async formValues(id) {
    const s = this.getSession(id);
    return formLib.readValues(s.page);
  }

  // Check-only: does the combobox at `ref` currently display `value`, with
  // no click/type interaction at all. See lib/form.js checkComboboxValue for
  // why a caller's post-fill stabilization needs this instead of a
  // plain formScan().
  async formCheckCombo(id, ref, value) {
    const s = this.getSession(id);
    const matches = await formLib.checkComboboxValue(s.page, ref, value);
    return { matches };
  }

  // Submit and observe. The observation is the point: this returns what the
  // page looked like AFTER the click, so the caller can decide whether the
  // submission actually landed rather than assuming a click means success.
  async formSubmit(id, ref, { waitMs = 6000 } = {}) {
    const s = this.getSession(id);
    const beforeUrl = s.page.url();
    const selector = formLib.selectorForRef(ref);
    await s.page.click(selector, { timeout: 15000 });
    await s.page.waitForTimeout(waitMs);
    try {
      await s.page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      // networkidle never settling is normal on analytics-heavy pages; the
      // fixed wait above already gave the submission time to land.
    }
    assertSafeUrl(s.page.url());
    const after = {
      url: s.page.url(),
      title: await s.page.title().catch(() => ''),
      text: await s.page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => ''),
    };
    const shot = await this.screenshotSafe(id, 'form-submit');
    s.recorder.log({ type: 'form-submit', god: s.god, ref, urlBefore: beforeUrl, urlAfter: after.url, screenshot: shot.path });
    return { before: { url: beforeUrl }, after, screenshot: shot.path };
  }

  async upload(id, selector, filePath) {
    const s = this.getSession(id);
    if (!fs.existsSync(filePath)) throw new Error(`no such file: ${filePath}`);
    // HOLE 4 fix: confine uploads strictly to state/uploads/ (the staging
    // dir), never the operator's real document folders. Resolve with realpath
    // FIRST, then re-check the prefix AFTER resolution, so a symlink
    // planted inside the staging dir cannot point outside it and slip past
    // a plain string check on the un-resolved path.
    const resolvedUploadsDir = fs.realpathSync(UPLOADS_DIR);
    let resolved;
    try {
      resolved = fs.realpathSync(filePath);
    } catch (err) {
      throw new Error(`cannot resolve upload path: ${err.message}`);
    }
    const prefix = resolvedUploadsDir + path.sep;
    if (resolved !== resolvedUploadsDir && !resolved.startsWith(prefix)) {
      throw new Error(`refusing upload: "${filePath}" resolves outside the staging dir (${UPLOADS_DIR})`);
    }
    // Read the bytes NOW, at the resolved path, rather than handing
    // Playwright the path string to open later. Closes a TOCTOU window an
    // Athena review caught (2026-07-21): passing the path string means
    // whatever setInputFiles actually reads is decided at ITS open() call,
    // not at this check, so a path swapped for a symlink between this
    // check and that read would slip through. Reading the buffer here
    // means the bytes handed to the page are exactly the ones just proven
    // to live inside the staging dir.
    const buffer = fs.readFileSync(resolved);
    await s.page.setInputFiles(selector, {
      name: path.basename(resolved),
      mimeType: guessMimeType(resolved),
      buffer,
    });
    const shot = await this.screenshotSafe(id, 'upload');
    s.recorder.log({ type: 'upload', god: s.god, selector, filePath, screenshot: shot.path });
    return { uploaded: selector, filePath };
  }

  status() {
    return {
      headless: this.headless,
      channel: BROWSER_CHANNEL || 'chromium (bundled)',
      startedAt: this.startedAt,
      sessions: this.listSessions(),
      // Never includes username/password even though _activeProxyConfig
      // holds them - status() goes out over the HTTP API and this JSON is
      // what cli.js `status` prints to a terminal/log, not a place for a
      // proxy credential to sit around in.
      proxy: {
        profile: this.proxyProfile,
        server: this._activeProxyConfig ? this._activeProxyConfig.server : null,
        timezoneId: this._activeProxyConfig ? this._activeProxyConfig.timezoneId || null : null,
        locale: this._activeProxyConfig ? this._activeProxyConfig.locale || null : null,
        lastEgressCheck: this.lastEgressCheck,
      },
    };
  }
}

module.exports = { AtlasBrowser };
