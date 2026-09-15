// store.mjs — the durable primitives everything else is built on.
//
// One rule: every write is a transaction (mkdir-lock → read → update → write temp → fsync →
// rename). A crash leaves either the old file or the new one, never a torn one, and a stale
// lock is loud rather than silently stolen. No dependencies; sha256 + fs only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_STATE_BYTES = 256 * 1024;
export const MAX_TEXT = 1200;

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

export function read(file) {
  try {
    let parent = path.dirname(path.resolve(file));
    while (fs.existsSync(parent)) {
      if (fs.lstatSync(parent).isSymbolicLink()) throw Error('State path contains a link');
      const up = path.dirname(parent); if (up === parent) break; parent = up;
    }
    if (fs.lstatSync(file).isSymbolicLink()) throw Error('State file is a link');
    if (fs.statSync(file).size > MAX_STATE_BYTES) throw Error('State too large');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export function transaction(file, update) {
  safeDir(path.dirname(file));
  const lock = file + '.lock';
  try { fs.mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') throw Error('State busy; retry. Never remove an unverified live lock.'); throw e; }
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const result = update(read(file));
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw Error('State capacity exceeded; archive before retrying');
    fs.writeFileSync(temp, serialized, { flag: 'wx' });
    const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    return result;
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    fs.rmdirSync(lock);
  }
}

// Text that crosses the wire is a curated summary, never a raw document. The secret patterns
// below are a backstop, not a guarantee — the sender is responsible for what it puts on the wire.
export function validateText(s) {
  if (typeof s !== 'string' || s.length > MAX_TEXT || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) throw Error(`Invalid text (must be a string of at most ${MAX_TEXT} characters, no control bytes)`);
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
