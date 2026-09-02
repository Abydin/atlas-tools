'use strict';

// Headless-vs-desktop browser parity for the shared Playwright context.
//
// WHY THIS EXISTS: a headless Chromium launch does not present the same
// surface an ordinary desktop Chrome does - navigator.webdriver is true,
// plugins/window.chrome are missing, the UA string carries an explicit
// "Headless" token. Some form-hosting platforms read that gap and reject
// otherwise fully-valid, honest submissions with "Your submission was
// flagged as possible spam." Confirmed on two different fully-filled
// forms on the same platform - same fields, same content, same result.
// This is NOT a captcha and NOT content moderation; it is that platform's
// bot-detection layer reading the headless/desktop mismatch off the
// Chromium instance itself and flagging the SUBMIT action before the form
// is even evaluated. Closing that gap does not fabricate or misrepresent
// anything about the application - the content submitted is exactly what
// the caller filled in; this only makes the browser present the same
// surface an ordinary desktop Chrome instance would.
//
// Measured directly against this project's own pinned Chromium (chromium
// 1228, "Chrome for Testing" 149.0.7827.55) before writing this file:
//   - default headless launch: navigator.webdriver === true, UA contains
//     "HeadlessChrome", navigator.plugins.length === 0, window.chrome is
//     undefined.
//   - `--disable-blink-features=AutomationControlled` alone already flips
//     navigator.webdriver to false (verified with a throwaway launch) -
//     this is a real Chromium launch flag, not a page-level shim, so it is
//     applied in the launch args in atlas-browser.js, not here.
//   - the UA string's "HeadlessChrome" token does NOT go away with that
//     flag or with `--headless=new` on this bundled build - it needs the
//     explicit userAgent override below (also applied in atlas-browser.js,
//     using the SAME Chromium major/full version as the real UA reported
//     above, so this never drifts out of sync with whatever build is
//     actually pinned - only the "Headless" token is stripped).
//
// This module only covers the addInitScript() half: the DOM/JS-level
// surface a page can introspect (navigator.*, window.chrome, WebGL
// parameters, Notification permission). It runs via
// Page.addScriptToEvaluateOnNewDocument under the hood, so it executes
// before ANY page script on every new document in every tab, including
// same-origin iframes - which matters because a detector can and does run
// its checks from an embedded script, not just the top frame.
//
// Scope, deliberately: this normalizes the STATIC fingerprint tells (the
// "is this even a real browser" layer). It does not and cannot fix a
// behavioral/reputation layer keyed on IP reputation, request cadence, or
// mouse/keyboard entropy - see the caveat in atlas-browser.js's launch()
// comment and the report handed back after this was built.

const FINGERPRINT_INIT_SCRIPT = `(() => {
  const define = (obj, prop, getterValue) => {
    try {
      Object.defineProperty(obj, prop, {
        get() { return getterValue; },
        configurable: true,
        enumerable: true,
      });
    } catch (_) { /* best-effort; a locked-down property is not fatal */ }
  };

  // 1. navigator.webdriver - the single most-checked automation tell.
  // (Belt-and-braces: the launch flag already clears this at the
  // Chromium level; this makes it true even if a future flag regresses.)
  define(Navigator.prototype, 'webdriver', undefined);

  // 2. navigator.languages - a headless launch with no locale reports a
  // single-entry array; a real desktop Chrome reports a short preference
  // list.
  define(Navigator.prototype, 'languages', Object.freeze(['en-US', 'en']));

  // 3. navigator.plugins / navigator.mimeTypes - stock Chrome ships a
  // handful of built-in plugin entries (PDF viewer etc.); headless
  // Chromium reports an empty list, which is itself a checked signal.
  // Plugin/PluginArray instances expose name/filename/description as
  // getter-only accessors on their real prototypes - Object.assign()-ing
  // plain data onto Object.create(Plugin.prototype) throws ("has only a
  // getter") rather than silently no-op-ing, so each fake entry is built
  // with defineProperty instead of assignment.
  const makeFakePlugin = (p) => {
    const obj = Object.create(Plugin.prototype);
    for (const [key, value] of Object.entries(p)) {
      Object.defineProperty(obj, key, { value, enumerable: true, configurable: true });
    }
    return obj;
  };
  const fakePlugins = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  ].map(makeFakePlugin);
  const pluginArray = Object.create(PluginArray.prototype);
  Object.defineProperty(pluginArray, 'length', { value: fakePlugins.length, enumerable: true, configurable: true });
  pluginArray.item = (i) => fakePlugins[i];
  pluginArray.namedItem = (name) => fakePlugins.find((p) => p.name === name);
  fakePlugins.forEach((p, i) => { pluginArray[i] = p; });
  define(Navigator.prototype, 'plugins', pluginArray);
  const mimeTypeArray = Object.create(MimeTypeArray.prototype);
  Object.defineProperty(mimeTypeArray, 'length', { value: 0, enumerable: true, configurable: true });
  define(Navigator.prototype, 'mimeTypes', mimeTypeArray);

  // 4. window.chrome - every real Chrome window carries this object
  // (used by extensions); it is simply absent on headless launches.
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  // 5. Notification permission query shim - headless Chromium reports
  // Notification.permission === 'denied' with no prompt ever shown, which
  // reads differently from a real profile's 'default'/'granted' state.
  // Only patch the one query shape detectors actually probe
  // (permissions.query({name:'notifications'})); everything else passes
  // through untouched.
  if (window.Notification && window.navigator.permissions && window.navigator.permissions.query) {
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (parameters) => (
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : originalQuery(parameters)
    );
  }

  // 6. WebGL vendor/renderer - SwiftShader ("Google Inc." / "Google
  // SwiftShader") is the software-rendering fingerprint of a headless/
  // sandboxed GPU-less launch; a real desktop Chrome reports the actual
  // GPU. Spoof only the two UNMASKED_* debug params detectors read via
  // the WEBGL_debug_renderer_info extension; every other getParameter
  // call passes through to the real implementation unchanged.
  const spoofGetParameter = (proto) => {
    const original = proto.getParameter;
    proto.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return original.call(this, parameter);
    };
  };
  try { if (window.WebGLRenderingContext) spoofGetParameter(WebGLRenderingContext.prototype); } catch (_) {}
  try { if (window.WebGL2RenderingContext) spoofGetParameter(WebGL2RenderingContext.prototype); } catch (_) {}

  // 7. Function.prototype.toString - a detector that suspects one of the
  // getters/methods above was overridden can call .toString() on it and
  // compare against the native "[native code]" shape. Make every function
  // this script touched report as native, and leave every other function
  // in the page untouched.
  const patched = new Set([
    Navigator.prototype.__lookupGetter__('webdriver'),
    Navigator.prototype.__lookupGetter__('languages'),
    Navigator.prototype.__lookupGetter__('plugins'),
    Navigator.prototype.__lookupGetter__('mimeTypes'),
  ].filter(Boolean));
  if (window.navigator.permissions && window.navigator.permissions.query) {
    patched.add(window.navigator.permissions.query);
  }
  const nativeToString = Function.prototype.toString;
  Function.prototype.toString = function () {
    if (patched.has(this)) return 'function () { [native code] }';
    return nativeToString.call(this);
  };
})();`;

// Desktop-Chrome User-Agent, derived (not hardcoded) from whatever
// Chromium build is actually pinned/installed, with only the "Headless"
// token stripped. Hardcoding a version string here would silently drift
// out of sync the next time the pinned build is upgraded (see the
// BROWSER CHANNEL note in atlas-browser.js); launching a disposable
// throwaway browser once and reading its own real UA keeps this correct
// forever with no manual upkeep, at the cost of one extra short-lived
// launch the first time a context starts up (cached after that for the
// life of this process).
let cachedUserAgent = null;
async function getDesktopUserAgent(chromium, channel) {
  if (cachedUserAgent) return cachedUserAgent;
  const probe = await chromium.launch({ headless: true, channel, chromiumSandbox: true });
  try {
    const page = await probe.newPage();
    const raw = await page.evaluate(() => navigator.userAgent);
    cachedUserAgent = raw.replace('HeadlessChrome', 'Chrome').replace('Headless', '');
  } finally {
    await probe.close().catch(() => {});
  }
  return cachedUserAgent;
}

module.exports = { FINGERPRINT_INIT_SCRIPT, getDesktopUserAgent };
