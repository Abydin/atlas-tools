'use strict';

// Per-session audit trail: a JSONL transcript plus a screenshot for every
// action, so a headless run is auditable AFTER the fact - including WHICH
// god drove it. Writes are confined to ARTIFACTS_DIR (see paths.js) - this
// is the only module that touches the filesystem for logging.

const fs = require('fs');
const path = require('path');
const { ARTIFACTS_DIR } = require('./paths');

let recorderSeq = 0;

class Recorder {
  // `tag` (typically the owning god's name, e.g. "hermes") makes the
  // artifacts directory attributable at a glance. A monotonic in-process
  // counter is appended so two sessions opened in the same millisecond
  // (real under concurrent Round Table use) never collide.
  constructor(tag) {
    recorderSeq += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTag = String(tag || 'session').replace(/[^a-z0-9_-]/gi, '_');
    this.runId = `${stamp}-${safeTag}-${recorderSeq}`;
    this.dir = path.join(ARTIFACTS_DIR, this.runId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.transcriptPath = path.join(this.dir, 'transcript.jsonl');
    this.seq = 0;
  }

  log(event) {
    const entry = { ts: new Date().toISOString(), ...event };
    fs.appendFileSync(this.transcriptPath, JSON.stringify(entry) + '\n');
    return entry;
  }

  nextScreenshotPath(label) {
    this.seq += 1;
    const safeLabel = String(label || 'action').replace(/[^a-z0-9_-]/gi, '_');
    return path.join(this.dir, `${String(this.seq).padStart(3, '0')}-${safeLabel}.png`);
  }
}

module.exports = { Recorder };
