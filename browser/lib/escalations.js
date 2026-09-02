'use strict';

// The push-escalation channel: ANY god, on hitting something it cannot
// resolve on a live session, hands that exact page to the operator instead of
// guessing or silently dropping it. Same principle as
// feedback-surface-never-silent-drop and the approvals rail, applied to a
// live browser page instead of a diff.
//
// TRIGGERS (caller's responsibility to call escalate() for): a captcha or
// bot challenge, a form field the driving god cannot confidently map, a
// required answer it must not invent (salary, notice period, any personal
// fact), an unexpected page (login wall, error), or any irreversible-
// looking action.
//
// MECHANICS: create() registers a PENDING escalation, fires an ntfy push,
// and returns a promise (see wait()) that the caller `await`s - this is
// what keeps the HTTP request (and therefore the calling script) PAUSED
// and the session's page untouched and live, rather than tearing anything
// down. The promise settles one of three ways:
//   - answer(id, text)   -> {outcome:'answered', answer:text}   the operator answered
//   - takeover(id)        -> {outcome:'takeover'}                 he took the wheel
//   - timeout elapses     -> {outcome:'timeout'}                  see TIMEOUT below
//
// TIMEOUT: defaults to 10 minutes (ESCALATION_DEFAULT_TIMEOUT_MS). Chosen
// as long enough that a phone push realistically gets noticed and acted on
// (this is not a same-second interrupt - the operator may be away from his
// phone briefly) but short enough that one unanswered escalation cannot
// hang an entire job-lead run for hours. On timeout the caller gets
// {outcome:'timeout'} and is expected to mark its own work item
// NEEDS_HUMAN (with the session's artifacts/screenshots attached) and move
// on to its next item - this module does not know what "next item" means
// for any given god's workflow, so it only ever reports the timeout, never
// silently retries or guesses an answer.
//
// DURABLE RECORD: every state transition is appended (JSONL, one line per
// transition, mirrors cockpit/lib/alerts.ts's append-only logs/alerts.jsonl
// pattern) to state/escalations.jsonl so it survives a server restart and
// is readable by a cockpit route without depending on this process's
// in-memory Map. The in-memory Map is what actually unblocks a held HTTP
// request; the file is the audit trail + cross-process visibility.

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths');
const ntfy = require('./ntfy');

const ESCALATIONS_LOG = process.env.ATLAS_BROWSER_ESCALATIONS_LOG || path.join(ROOT, 'state', 'escalations.jsonl');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, see TIMEOUT above

let seq = 0;
function nextId() {
  seq += 1;
  return `esc-${Date.now().toString(36)}-${seq}`;
}

function appendRecord(rec) {
  try {
    fs.mkdirSync(path.dirname(ESCALATIONS_LOG), { recursive: true });
    fs.appendFileSync(ESCALATIONS_LOG, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    // an escalation we can't log to disk is still an escalation we are
    // actively holding in memory; never let logging failure eat the pause.
    console.error('[escalations] failed to append record:', err.message);
  }
}

/** Folds the JSONL append log down to latest-state-per-id, newest first. */
function readAll(limit = 100) {
  let raw;
  try {
    raw = fs.readFileSync(ESCALATIONS_LOG, 'utf8');
  } catch (_) {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      byId.set(rec.id, { ...(byId.get(rec.id) || {}), ...rec });
    } catch (_) {
      // skip a torn line, never abort the read
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, limit);
}

class EscalationManager {
  constructor() {
    this.pending = new Map(); // id -> { resolve, timer }
  }

  /**
   * Raises an escalation for a live session. `god` and `sessionId` say WHO
   * hit the blocker and on WHICH page; `reason` is one of the trigger
   * categories in the header comment; `details` is free text (what the god
   * was doing, what it's stuck on) - never a secret, this gets pushed to a
   * phone. `viewUrl` is the direct link to the live session (built by the
   * caller, which knows its own host/port). Returns { id, promise }: await
   * the promise to block until answered/taken-over/timed-out.
   */
  create({ god, sessionId, reason, details, viewUrl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const id = nextId();
    const createdAt = new Date().toISOString();

    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._settle(id, { outcome: 'timeout' }, 'NEEDS_HUMAN');
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });

    appendRecord({ id, ts: createdAt, status: 'PENDING', god, sessionId, reason, details, viewUrl, timeoutMs });

    const title = `Atlas Browser - ${god} needs you`;
    // SECURITY: viewUrl carries a SCOPED token (see server.js viewUrlFor(),
    // lib/scoped-tokens.js), never the master bearer token - this message
    // goes out over ntfy, an unauthenticated third-party relay. The scoped
    // token is bound to this one sessionId, expires with this escalation's
    // own timeout, and authorizes only the /live and /view surface of that
    // session - not open/close/upload/proxy or any other session. A
    // stranger who reads the ntfy topic can drive that one captcha page
    // for a bounded window, nothing more; that is still why
    // ATLAS_NTFY_TOPIC should be a private topic, not the shared default.
    const message = [
      `god: ${god}`,
      `stuck on: ${reason}`,
      details ? `detail: ${details}` : null,
      viewUrl ? `session: ${sessionId} - on the Mac, run: node cli.js view --session ${sessionId}` : null,
      `(auto-parks as NEEDS_HUMAN in ${Math.round(timeoutMs / 60000)} min if unanswered)`,
    ].filter(Boolean).join('\n');

    ntfy.send({ title, message, click: viewUrl, tags: 'warning' }).then((r) => {
      appendRecord({ id, ts: new Date().toISOString(), status: 'PENDING', pushDelivered: r.delivered, pushReason: r.reason });
    });

    return { id, promise };
  }

  _settle(id, result, status) {
    const p = this.pending.get(id);
    if (!p) return false; // already settled
    clearTimeout(p.timer);
    this.pending.delete(id);
    appendRecord({ id, ts: new Date().toISOString(), status, result });
    p.resolve(result);
    return true;
  }

  /** the operator answered the question; the waiting god continues with the answer text. */
  answer(id, answerText) {
    const ok = this._settle(id, { outcome: 'answered', answer: answerText }, 'ANSWERED');
    if (!ok) throw new Error(`no pending escalation: ${id}`);
    return { id, outcome: 'answered' };
  }

  /** the operator took the wheel himself; the waiting god stops driving this session. */
  takeover(id) {
    const ok = this._settle(id, { outcome: 'takeover' }, 'TAKEN_OVER');
    if (!ok) throw new Error(`no pending escalation: ${id}`);
    return { id, outcome: 'takeover' };
  }

  isPending(id) {
    return this.pending.has(id);
  }

  list(limit) {
    return readAll(limit);
  }

  get(id) {
    return readAll(1000).find((r) => r.id === id) || null;
  }
}

module.exports = { EscalationManager, DEFAULT_TIMEOUT_MS, ESCALATIONS_LOG };
