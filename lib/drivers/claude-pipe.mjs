// claude-pipe.mjs — wake a live Claude Code session through its local peer message pipe.
// Delegates to claude-transport.mjs as a subprocess so the peer credential never enters this
// process. A closed pipe proves transport completion, not acceptance.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const transportScript = fileURLToPath(new URL('./claude-transport.mjs', import.meta.url));

export function wake(sessionId, from, body, messageId, opts = {}) {
  const run = opts.run || spawnSync;
  let temp;
  try {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'the-wire-claude-'));
    const messageFile = path.join(temp, 'message.txt');
    fs.writeFileSync(messageFile, body, { flag: 'wx', mode: 0o600 });
    const args = [transportScript, 'send', '--session', sessionId, '--from', from, '--message-file', messageFile];
    if (messageId) args.push('--message-id', messageId);
    const result = run(process.execPath, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true, shell: false });
    if (!result.error && result.status === 0) {
      try {
        const r = JSON.parse(result.stdout);
        if (r.sessionId === sessionId && r.transport === 'closed') return { delivered: true, transportId: r.messageId || null };
      } catch {}
    }
    return { delivered: false, transportId: null };
  } finally {
    if (temp) { try { fs.unlinkSync(path.join(temp, 'message.txt')); fs.rmdirSync(temp); } catch {} }
  }
}

export function discover(opts = {}) {
  const run = opts.run || spawnSync;
  const result = run(process.execPath, [transportScript, 'list'], { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true, shell: false });
  if (result.error || result.status !== 0) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}
