// steward.mjs — background sweep: dispatch pending messages, re-wake unconfirmed ones with
// bounded backoff. Runs from a scheduler (cron / Task Scheduler) every minute. Lockfile-guarded;
// a concurrent sweep is safe. Re-wakes never touch delivery state — correctness stays pull-driven.
import fs from 'node:fs';
import path from 'node:path';
import { list, notification } from './wire-store.mjs';
import { stateDir } from './store.mjs';
import { dispatch } from './dispatch.mjs';
import { wake as claudeWake } from './drivers/claude-pipe.mjs';
import { wake as codexWake } from './drivers/codex-queue.mjs';

const BACKOFF_MS = [5000, 30000, 120000];
const MAX_REWAKES = 3;
// Slow phase (Carlos-approved 2026-09-21 15:11 CDT, FIELD-NOTES §18): a Claude-bound frame that the
// steward reports `ok` is routinely never consumed by the target session, so three fast re-wakes
// within two minutes stop long before the session is next idle. After the fast phase, keep re-waking
// an unreceived message every SLOW_MS for up to MAX_SLOW more attempts (one hour), then stop for
// good. Correctness is still the recipient's pull; this only widens the window a push can land in.
const SLOW_MS = 5 * 60 * 1000;
const MAX_SLOW = 12;
const LOG_CAP = 500, LOG_TRIM = 400;
const terminal = new Set(['completed', 'cancelled', 'superseded']);
const logFile = root => path.join(stateDir(root), 'wake.log');
const lockFile = root => path.join(stateDir(root), 'steward.lock');

export function acquireLock(root) {
  const file = lockFile(root);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: 'wx' }); return true; }
  catch {
    try {
      const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - new Date(lock.ts).getTime() > 120000) { fs.unlinkSync(file); return acquireLock(root); }
      process.kill(lock.pid, 0); return false;
    } catch { try { fs.unlinkSync(file); return acquireLock(root); } catch { return false; } }
  }
}
export function releaseLock(root) { try { fs.unlinkSync(lockFile(root)); } catch {} }

function appendLog(root, entry) {
  const f = logFile(root);
  fs.appendFileSync(f, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n');
  try { const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); if (lines.length > LOG_CAP) fs.writeFileSync(f, lines.slice(-LOG_TRIM).join('\n') + '\n'); } catch {}
}
function readLog(root) { try { return fs.readFileSync(logFile(root), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }
function wakeTarget(provider, session, from, body, messageId) { return provider === 'codex' ? codexWake(session, body) : claudeWake(session, from, body, messageId); }

export function sweep(root, opts = {}) {
  const doDispatch = opts.dispatch || ((r, id, actor) => dispatch(r, id, actor));
  const doWake = opts.wake || wakeTarget;
  const results = [], log = readLog(root);
  for (const m of list(root)) {
    if (terminal.has(m.work)) continue;
    // The envelope's `to` is exact and immutable once enqueued. Wake the addressee, nobody else —
    // never re-resolve through a mailbox lease here (that once delivered three copies to the wrong session).
    const [provider, session] = m.envelope.to.split(':');
    if (m.delivery === 'pending' && !m.attempt) {
      let ok = false;
      try { const r = doDispatch(root, m.envelope.id, m.envelope.from); ok = r.delivery === 'accepted' || r.delivery === 'received'; } catch {}
      appendLog(root, { op: 'dispatch', id: m.envelope.id, provider, ok }); results.push({ id: m.envelope.id, op: 'dispatch', ok });
      continue;
    }
    if (m.delivery === 'unconfirmed' || m.delivery === 'attempting') {
      const prior = log.filter(e => e.id === m.envelope.id && e.op === 'rewake');
      if (prior.length >= MAX_REWAKES + MAX_SLOW) continue;
      const since = prior.length > 0 ? Date.now() - new Date(prior.at(-1).ts).getTime() : Infinity;
      const wait = prior.length >= MAX_REWAKES ? SLOW_MS : prior.length > 0 ? BACKOFF_MS[Math.min(prior.length - 1, BACKOFF_MS.length - 1)] : 0;
      if (since < wait) continue;
      let ok = false;
      try { ok = doWake(provider, session, m.envelope.from, notification(m), m.envelope.id).delivered; } catch {}
      appendLog(root, { op: 'rewake', id: m.envelope.id, provider, ok, n: prior.length + 1 }); results.push({ id: m.envelope.id, op: 'rewake', ok });
    }
  }
  return results;
}
