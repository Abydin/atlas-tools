'use strict';

// SECURITY BOUNDARY (t-350 hardening, HOLE 5: destination host guard).
// url-guard.js answers "is this SCHEME safe" (http/https only). This file
// answers a different question: "does this HOST resolve to an address
// inside the operator's own machine or LAN". Both gates run before every
// navigation - a safe scheme pointed at an internal address is still an
// SSRF vector, and that is exactly the realistic attack here: a hostile
// page carries text aimed at the caller reading it ("open
// http://127.0.0.1:9000/api/admin"), the caller complies, and an
// unauthenticated local admin API (a real, verified case: some local
// dev services return 200 with no credentials at all) reads or writes
// back into this session.
//
// DENYLIST, not allowlist. The README used to argue an allowlist would
// defeat the browser's purpose - true, and still the reason this is a
// denylist of internal ranges rather than a list of permitted external
// sites. No legitimate target site lives on loopback, RFC1918,
// link-local, or Tailscale CGNAT space, so blocking those ranges costs
// nothing operationally while closing the SSRF path.
//
// NOT a string check on the URL. `new URL()` in atlas-browser.js/url-guard.js
// already forces WHATWG normalization before this ever runs, which turns
// out to do most of the encoding-bypass work for free - confirmed by hand:
//   new URL('http://2130706433/x').hostname   -> '127.0.0.1'  (decimal)
//   new URL('http://0x7f000001/x').hostname   -> '127.0.0.1'  (hex)
//   new URL('http://017700000001/x').hostname -> '127.0.0.1'  (octal)
//   new URL('http://127.1/x').hostname        -> '127.0.0.1'  (short form)
//   new URL('http://[::ffff:127.0.0.1]/x').hostname -> '[::ffff:7f00:1]'
// So by the time this module sees a hostname, decimal/hex/octal/short-form
// IPv4 encodings are already canonical dotted-quad. What is NOT solved by
// URL normalization is a hostname that RESOLVES to an internal address
// (the actual DNS-rebinding case) or an IPv4-mapped IPv6 literal - both
// handled below via `dns.lookup({ all: true })` (every resolved address is
// checked, not just the first) and Node's built-in `net.BlockList`, which
// natively treats IPv4-mapped IPv6 (`::ffff:127.0.0.1`) as the embedded
// IPv4 address for matching purposes (verified directly: a BlockList with
// only `127.0.0.0/8` added as 'ipv4' correctly matches
// `bl.check('::ffff:127.0.0.1', 'ipv6')`).
//
// RESIDUAL GAP, stated plainly rather than papered over: this is a
// TOCTOU, not a closed hole. `assertSafeDestination()` resolves the
// hostname and checks it BEFORE `page.goto()` runs; Chromium's own network
// stack resolves the SAME hostname again, independently, when it actually
// connects. A hostile DNS server serving a very-low-TTL record could
// answer "public IP" to our check and "127.0.0.1" moments later to
// Chromium's own resolver - classic DNS rebinding, and this module's
// pre-check alone does not close it. What DOES partially close it:
// `assertSafeServerAddress()` in atlas-browser.js's `open()` calls
// Playwright's `response.serverAddress()` after `goto()` returns, which
// reports the IP the browser ACTUALLY connected to (not a fresh, separately
// racy re-resolution) - if that lands inside the denylist, the page is
// blanked immediately and open() throws, so the calling god's request
// fails and never receives page content or a screenshot back over the
// API. The rendered bytes did briefly exist inside the Chromium renderer
// process before that check ran (this is inherent to any check that isn't
// a network-layer proxy pinning the resolved IP before the TCP connection
// opens, which this service does not have), but nothing here reads them out
// to the caller once the address is found unsafe. A real network-layer fix
// (e.g. a local proxy that resolves once and connects to the pinned IP) is
// future work if this ever needs to be airtight rather than substantially
// hardened.
//
// ESCAPE HATCH: ATLAS_BROWSER_ALLOW_INTERNAL=1, off by default, read fresh
// on every check (not cached at module load) so it is a deliberate,
// loudly-logged per-run choice - e.g. legitimately pointing this browser
// at a local dev server to demo/inspect it - never a silent default.

const dns = require('dns').promises;
const net = require('net');

const DENIED_V4 = [
  ['0.0.0.0', 8],       // "this network" / unspecified
  ['127.0.0.0', 8],     // loopback
  ['10.0.0.0', 8],      // RFC1918
  ['172.16.0.0', 12],   // RFC1918
  ['192.168.0.0', 16],  // RFC1918
  ['169.254.0.0', 16],  // link-local, includes cloud metadata 169.254.169.254
  ['100.64.0.0', 10],   // Tailscale CGNAT - both machines in a mesh VPN live here
];

const DENIED_V6 = [
  ['::1', 128],   // loopback
  ['fe80::', 10], // link-local
  ['fc00::', 7],  // unique-local
];

function buildBlockList() {
  const bl = new net.BlockList();
  for (const [addr, prefix] of DENIED_V4) bl.addSubnet(addr, prefix, 'ipv4');
  for (const [addr, prefix] of DENIED_V6) bl.addSubnet(addr, prefix, 'ipv6');
  return bl;
}

const blockList = buildBlockList();

const ALLOW_INTERNAL_ENV = 'ATLAS_BROWSER_ALLOW_INTERNAL';

function internalAllowed() {
  // read fresh every call, deliberately - see file header.
  return process.env[ALLOW_INTERNAL_ENV] === '1';
}

function stripBrackets(hostname) {
  if (hostname.length > 1 && hostname[0] === '[' && hostname[hostname.length - 1] === ']') {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function familyToBlockListFamily(family) {
  return family === 6 || family === 'IPv6' ? 'ipv6' : 'ipv4';
}

function isBlockedAddress(address, family) {
  return blockList.check(address, familyToBlockListFamily(family));
}

async function resolveAddresses(hostname) {
  const bare = stripBrackets(hostname);
  const literalFamily = net.isIP(bare); // 0 = not an IP literal, 4 or 6 otherwise
  if (literalFamily) return [{ address: bare, family: literalFamily }];
  const results = await dns.lookup(bare, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
}

// Called BEFORE goto(). Resolves the hostname to every address it maps to
// and blocks if ANY of them is internal - not just the first, since a
// hostname can round-robin between a public and an internal address.
async function assertSafeDestination(input) {
  const parsed = new URL(String(input));
  const hostname = stripBrackets(parsed.hostname);

  let addresses;
  try {
    addresses = await resolveAddresses(hostname);
  } catch (err) {
    throw new Error(`refusing to navigate: could not resolve host "${hostname}": ${err.message}`);
  }
  if (!addresses.length) {
    throw new Error(`refusing to navigate: host "${hostname}" resolved to no addresses`);
  }

  const blocked = addresses.filter((a) => isBlockedAddress(a.address, a.family));
  if (blocked.length) {
    const blockedList = blocked.map((b) => b.address).join(', ');
    if (internalAllowed()) {
      console.error(
        `[atlas-browser] SECURITY: ${ALLOW_INTERNAL_ENV}=1 escape hatch in use - ` +
        `allowing internal destination "${hostname}" (${blockedList}) for "${input}". ` +
        `This should be an intentional, temporary choice, not a standing setting.`
      );
      return { parsed, addresses, allowedInternal: true };
    }
    throw new Error(
      `refusing to navigate: host "${hostname}" resolves to an internal/private address ` +
      `(${blockedList}) - this browser does not visit loopback/RFC1918/link-local/Tailscale ` +
      `destinations by default. Set ${ALLOW_INTERNAL_ENV}=1 to override for this run.`
    );
  }
  return { parsed, addresses, allowedInternal: false };
}

// Called AFTER goto() resolves, with the real connected address Playwright
// reports via response.serverAddr() (Playwright 1.61's actual method name -
// confirmed directly against this project's installed version; it is NOT
// called serverAddress() despite that being the more commonly documented
// name in older docs). serverAddr() returns { ipAddress, port } with no
// family field, so family is derived here via net.isIP(). See the
// RESIDUAL GAP note above for exactly what this call site does and does
// not close.
function assertSafeServerAddress(serverAddr, context) {
  if (!serverAddr || !serverAddr.ipAddress) return; // nothing reported, nothing to check
  const family = net.isIP(serverAddr.ipAddress);
  if (!family || !isBlockedAddress(serverAddr.ipAddress, family)) return;
  if (internalAllowed()) {
    console.error(
      `[atlas-browser] SECURITY: ${ALLOW_INTERNAL_ENV}=1 escape hatch in use - the actual ` +
      `connection for "${context.url}" landed on internal address ${serverAddr.ipAddress}.`
    );
    return;
  }
  throw new Error(
    `refusing to keep page open: the actual connection for "${context.url}" landed on ` +
    `internal address ${serverAddr.ipAddress} (this is the case a hostname-only pre-check ` +
    `cannot catch - see DNS-rebinding note in lib/host-guard.js). Set ${ALLOW_INTERNAL_ENV}=1 ` +
    `to override for this run.`
  );
}

module.exports = {
  assertSafeDestination,
  assertSafeServerAddress,
  isBlockedAddress,
  ALLOW_INTERNAL_ENV,
  DENIED_V4,
  DENIED_V6,
};
