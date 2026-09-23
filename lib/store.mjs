// store.mjs — the durable primitives everything else is built on.
//
// One rule: every write is a transaction (mkdir-lock → read → update → write temp → fsync →
// rename). A crash leaves either the old file or the new one, never a torn one, and a stale
// lock is loud rather than silently stolen. No dependencies; sha256 + fs only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_STATE_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT = 4000;
export const MAX_READ_BYTES = 64 * 1024 * 1024;
export const DEFAULT_LIMITS = Object.freeze({ maxMessages: 500, maxBytes: MAX_STATE_BYTES, maxText: MAX_TEXT, maxStatus: 4000 });
export function wireConfig(root) {
  const configured = read(path.join(stateDir(root), 'config.json'), 256 * 1024) ?? {};
  if (typeof configured !== 'object' || Array.isArray(configured)) throw Error('Invalid wire config');
  const limits = { ...DEFAULT_LIMITS, ...configured };
  const ceilings = { maxMessages: 100000, maxBytes: MAX_READ_BYTES, maxText: 1000000, maxStatus: 1000000 };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(ceilings, key) || !Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) throw Error(`Invalid wire config limit: ${key}`);
  }
  return limits;
}

export const id = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw Error('Invalid identity');
  return value;
};
export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function stateDir(root) { return path.join(root, '.wire'); }

function safeDir(dir) {
  let p = path.resolve(dir);
  while (true) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('State path contains a link');
    const up = path.dirname(p); if (up === p) break; p = up;
  }
  fs.mkdirSync(dir, { recursive: true });
}

export function read(file, maxBytes = MAX_STATE_BYTES) {
  try {
    let parent = path.dirname(path.resolve(file));
    while (fs.existsSync(parent)) {
      if (fs.lstatSync(parent).isSymbolicLink()) throw Error('State path contains a link');
      const up = path.dirname(parent); if (up === parent) break; parent = up;
    }
    if (fs.lstatSync(file).isSymbolicLink()) throw Error('State file is a link');
    if (fs.statSync(file).size > maxBytes) throw Error('State too large');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = [50, 100, 200, 500];

function acquireTransactionLock(file) {
  const lock = file + '.lock';
  const sentinel = path.join(lock, 'pid');
  for (let attempt = 0; attempt <= LOCK_RETRY_MS.length; attempt++) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(sentinel, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const info = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
        const age = Date.now() - info.ts;
        if (age > LOCK_STALE_MS) {
          try { process.kill(info.pid, 0); } catch { fs.rmSync(lock, { recursive: true }); continue; }
        }
      } catch { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { recursive: true }); continue; } }
      if (attempt < LOCK_RETRY_MS.length) { sleepSync(LOCK_RETRY_MS[attempt]); continue; }
      throw Error(`State busy after ${LOCK_RETRY_MS.length} retries. Lock held >30s with a live process means a hang; investigate before removing ${lock}`);
    }
  }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function cleanOrphanedTemps(file) {
  const dir = path.dirname(file), base = path.basename(file) + '.';
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(base) && entry.endsWith('.tmp')) {
        const full = path.join(dir, entry);
        try { if (Date.now() - fs.statSync(full).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(full); } catch {}
      }
    }
  } catch {}
}

export function transaction(file, update, { maxBytes = MAX_STATE_BYTES, readMaxBytes = maxBytes } = {}) {
  safeDir(path.dirname(file));
  cleanOrphanedTemps(file);
  const lock = acquireTransactionLock(file);
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const result = update(read(file, readMaxBytes));
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > maxBytes) throw Error('State capacity exceeded; archive before retrying');
    fs.writeFileSync(temp, serialized, { flag: 'wx' });
    const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(file)) try { fs.copyFileSync(file, file + '.bak'); } catch {}
    fs.renameSync(temp, file);
    return result;
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    fs.rmSync(lock, { recursive: true });
  }
}

// Text that crosses the wire is a curated summary, never a raw document. The secret patterns
// below are a backstop, not a guarantee — the sender is responsible for what it puts on the wire.
export function validateText(s, maxText = MAX_TEXT) {
  if (typeof s !== 'string' || s.length > maxText || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) throw Error(`Invalid text (must be a string of at most ${maxText} characters, no control bytes)`);
  if (/-----BEGIN .*PRIVATE KEY|\b(?:sk-|ghp_|gho_|xox[bpa]-)[A-Za-z0-9_-]{16,}|\b\d{3}-\d{2}-\d{4}\b|(?:password|passwd|access_token|api_key|secret_key)\s*[:=]\s*\S+/i.test(s)) throw Error('Sensitive material rejected; send a status or a pointer instead');
  return s;
}

// References are relative, forward-slash paths inside the shared root (optionally `:line`).
// Absolute paths, `..`, and anything that smells like a credential store are refused.
export function validateReferences(refs = []) {
  if (!Array.isArray(refs) || refs.length > 16) throw Error('References must be an array of at most 16 entries');
  for (const s of refs) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,399}(?::[1-9]\d*)?$/.test(s) || s.split('/').includes('..') || /(?:vault|secret|credential|\.pem$|\.key$)/i.test(s)) throw Error(`Unsafe reference: ${JSON.stringify(s)}`);
  }
  return [...refs];
}

export function sessionFile(root, provider, session) { return path.join(stateDir(root), 'sessions', id(provider) + '--' + id(session) + '.json'); }

export function repair(root) {
  const dir = stateDir(root);
  const fixes = [];
  const stateFiles = ['wire.json', 'leases.json', 'cursors.json'];
  for (const name of stateFiles) {
    const f = path.join(dir, name);
    const lockDir = f + '.lock';
    if (fs.existsSync(lockDir)) {
      let stale = false;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'));
        try { process.kill(info.pid, 0); } catch { stale = true; }
        if (!stale && Date.now() - info.ts > LOCK_STALE_MS) stale = true;
      } catch { stale = Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS; }
      if (stale) { fs.rmSync(lockDir, { recursive: true }); fixes.push({ file: name, fix: 'removed stale lock' }); }
      else fixes.push({ file: name, issue: 'lock held by live process', fix: null });
    }
    const parentDir = path.dirname(f), base = path.basename(f) + '.';
    try {
      for (const entry of fs.readdirSync(parentDir)) {
        if (entry.startsWith(base) && entry.endsWith('.tmp')) {
          fs.unlinkSync(path.join(parentDir, entry));
          fixes.push({ file: entry, fix: 'removed orphaned temp' });
        }
      }
    } catch {}
    if (fs.existsSync(f)) {
      try { JSON.parse(fs.readFileSync(f, 'utf8')); }
      catch {
        const bak = f + '.bak';
        if (fs.existsSync(bak)) {
          try {
            JSON.parse(fs.readFileSync(bak, 'utf8'));
            fs.copyFileSync(f, f + '.corrupt.' + Date.now());
            fs.copyFileSync(bak, f);
            fixes.push({ file: name, fix: 'restored from backup (corrupt file preserved as .corrupt.*)' });
          } catch { fixes.push({ file: name, issue: 'corrupt and backup also corrupt', fix: null }); }
        } else { fixes.push({ file: name, issue: 'corrupt with no backup available', fix: null }); }
      }
    }
  }
  let integrity = null;
  const wireFile = path.join(dir, 'wire.json');
  if (fs.existsSync(wireFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(wireFile, 'utf8'));
      if (state.schema === 'the-wire/v1' && Array.isArray(state.messages)) {
        const bad = state.messages.filter(m => digest(m.envelope) !== m.hash);
        if (bad.length) {
          integrity = { tampered: bad.length, ids: bad.map(m => m.envelope?.id || 'unknown') };
          fixes.push({ file: 'wire.json', issue: `${bad.length} message(s) with hash mismatch`, fix: null });
        }
      }
    } catch {}
  }
  return { fixes, integrity, ok: fixes.every(f => f.fix || !f.issue) };
}
