#!/usr/bin/env node
// claude-transport.mjs — discover live Claude Code sessions and send one peer frame.
//
// Claude Code publishes each live session in ~/.claude/sessions/<pid>.json with a local message
// pipe and a peer credential in a sibling <pid>.<hash>.key file. This script reads that registry,
// verifies the process is alive, and writes one auth frame + one user frame with priority `next`
// (the message lands as the session's next input; it does not interrupt the current turn).
//
// Verified on Windows (named pipe \\.\pipe\LOCAL\cc-msg-*). On POSIX the registry shape is
// expected to be the same with a unix socket path; UNTESTED — see docs/FIELD-NOTES.md.
// This is an internal, version-sensitive protocol. If it breaks after a Claude Code update,
// inspect the installed runtime; do not guess new frames.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const home = process.env.USERPROFILE || os.homedir();
const registry = path.join(home, '.claude', 'sessions');
const [command, ...args] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localPipe(value) {
  if (typeof value !== 'string') return false;
  if (process.platform === 'win32') return /^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]+$/i.test(value);
  return path.isAbsolute(value) && /cc-msg-[0-9a-f]+/i.test(value); // POSIX: untested assumption
}

function liveSessions() {
  let files;
  try { files = fs.readdirSync(registry); } catch { return []; }
  return files.filter(f => /^\d+\.json$/.test(f)).flatMap(file => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(registry, file), 'utf8'));
      if (record.pid !== Number(file.slice(0, -5)) || !uuid.test(record.sessionId)) return [];
      process.kill(record.pid, 0);
      return [{ ...record, registryFile: file }];
    } catch { return []; }
  });
}

// The transcript's custom title is a HINT for a human choosing a target, never an identifier.
function titleHint(record) {
  if (!record.cwd) return null;
  const project = record.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const file = path.join(home, '.claude', 'projects', project, `${record.sessionId}.jsonl`);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(128 * 1024);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    let title = null;
    for (const line of buffer.subarray(0, count).toString('utf8').split('\n')) {
      try { const r = JSON.parse(line); if (r.type === 'custom-title') title = r.customTitle; } catch {}
    }
    return title;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function main() {
  if (command === 'list' && args.length === 0) {
    console.log(JSON.stringify(liveSessions().map(r => ({ pid: r.pid, sessionId: r.sessionId, titleHint: titleHint(r), name: r.name, cwd: r.cwd, entrypoint: r.entrypoint, localMessagePipe: localPipe(r.messagingSocketPath) })), null, 2));
    return;
  }
  if (command !== 'send') throw Error('Usage: claude-transport.mjs list | send --session UUID --from provider:UUID --message-file ABSOLUTE_PATH [--message-id UUID] [--dry-run]');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--dry-run' && !options[flag]) { options[flag] = true; continue; }
    if (!['--session', '--from', '--message-file', '--message-id'].includes(flag) || options[flag] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Invalid/repeated argument: ${flag}`);
    options[flag] = args[++i];
  }
  if (!uuid.test(options['--session'] || '')) throw Error('A full Claude CLI session UUID is required');
  if (!/^[a-z]+:[0-9a-f-]+$/i.test(options['--from'] || '') || !uuid.test(options['--from'].split(':')[1])) throw Error('Sender must be an exact provider:session-uuid');
  if (options['--message-id'] && !uuid.test(options['--message-id'])) throw Error('Invalid stable message ID');
  const file = options['--message-file'];
  if (!file || !path.isAbsolute(file)) throw Error('Message file must be an absolute path');
  const body = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!body.trim() || Buffer.byteLength(body) > 32768) throw Error('Message must contain 1–32768 UTF-8 bytes');
  const matches = liveSessions().filter(r => r.sessionId === options['--session']);
  if (matches.length !== 1) throw Error(`Expected exactly one live target; found ${matches.length}`);
  const target = matches[0];
  if (!localPipe(target.messagingSocketPath)) throw Error('Target has no recognized local Claude message pipe');
  if (options['--dry-run']) { console.log(JSON.stringify({ dryRun: true, sessionId: target.sessionId, pid: target.pid, bytes: Buffer.byteLength(body) })); return; }
  const keys = fs.readdirSync(registry).filter(f => f.startsWith(`${target.pid}.`) && /^\d+\.[0-9a-f]{64}\.key$/.test(f));
  if (keys.length !== 1) throw Error(`Expected one peer key for target PID; found ${keys.length}`);
  const { peerToken } = JSON.parse(fs.readFileSync(path.join(registry, keys[0]), 'utf8'));
  if (!/^[0-9a-f]{32}$/.test(peerToken || '')) throw Error('Unrecognized peer credential format');
  const current = JSON.parse(fs.readFileSync(path.join(registry, target.registryFile), 'utf8'));
  if (current.sessionId !== target.sessionId || current.messagingSocketPath !== target.messagingSocketPath || current.startedAt !== target.startedAt) throw Error('Target changed during discovery; retry discovery');
  process.kill(target.pid, 0);
  const messageId = options['--message-id'] || randomUUID();
  await new Promise((resolve, reject) => {
    let connected = false;
    const socket = net.createConnection(target.messagingSocketPath);
    socket.setTimeout(5000);
    socket.on('error', reject);
    socket.on('timeout', () => socket.destroy(Error('Pipe timeout; delivery unknown; inspect recipient before retry')));
    socket.on('connect', () => {
      connected = true;
      socket.end(JSON.stringify({ type: 'auth', token: peerToken }) + '\n' + JSON.stringify({
        type: 'user', session_id: target.sessionId, from: options['--from'], msg_id: messageId,
        message: { role: 'user', content: body }, priority: 'next',
      }) + '\n');
    });
    socket.on('data', () => {});
    socket.on('close', hadError => { if (!hadError && connected) resolve(); });
  });
  console.log(JSON.stringify({ transport: 'closed', sessionId: target.sessionId, messageId, recipientAcknowledged: false, note: 'Pipe completion is not proof of delivery; inspect the recipient.' }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
