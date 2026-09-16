import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, enqueueReplace, get, list, beginAttempt, finishAttempt, receive, pull, cursorRead, cursorClaim, cursorComplete, leaseAcquire, leaseRenew, leaseRelease, leaseResolve, leaseList, leaseRenewEndpoint, leasesByPrefix, activeAssignment, status, observePrompt, context, notification, wireHealth, archive, endpoint } from '../lib/wire-store.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { wake as codexWake, codexBin, probeCodex, parseQueueAcceptance } from '../lib/drivers/codex-queue.mjs';
import { sweep } from '../lib/steward.mjs';
import { validateReferences, validateText, transaction, stateDir } from '../lib/store.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'bin', 'the-wire.mjs');
const from = 'codex:11111111-1111-4111-8111-111111111111';
const to = 'claude:22222222-2222-4222-8222-222222222222';
const root = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'the-wire-test-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const msg = (o = {}) => ({ id: randomUUID(), from, to, task: 'test', revision: 'abc123', kind: 'assignment', summary: 'Review the specified revision', references: ['docs/PROTOCOL.md'], ...o });
const stubCodex = (dir, stdout) => { const f = path.join(dir, 'codex-stub.js'); fs.writeFileSync(f, `const a=process.argv.slice(2);const t=a[a.indexOf('--thread')+1];console.log(${JSON.stringify(stdout)}.replace('THREAD',t));`); return f; };

test('endpoints are exact provider:session-uuid', () => {
  assert.equal(endpoint(from), from);
  assert.throws(() => endpoint('codex:latest'), /uuid/i);
  assert.throws(() => endpoint('gemini:11111111-1111-4111-8111-111111111111'), /claude\|codex/);
});
test('text and reference validation fail closed', () => {
  assert.throws(() => validateText('x'.repeat(1201)), /1200/);
  assert.throws(() => validateText('password=hunter2'), /Sensitive/);
  assert.throws(() => validateText('token ghp_abcdefghijklmnopqrstuvwxyz'), /Sensitive/);
  assert.deepEqual(validateReferences(['src/a.mjs:12', 'docs/x.md']), ['src/a.mjs:12', 'docs/x.md']);
  for (const bad of ['../x', '/abs/path', 'C:/abs', 'a/../b', 'vault/notes.md', 'id.pem']) assert.throws(() => validateReferences([bad]), /Unsafe/, bad);
});
test('stable ID deduplicates intent and rejects content reuse', t => {
  const p = root(t), e = msg(); enqueue(p, e); enqueue(p, e);
  assert.equal(list(p).length, 1);
  assert.throws(() => enqueue(p, { ...e, summary: 'Different work' }), /reused/);
  assert.throws(() => enqueue(p, msg()), /active assignment/);
  assert.throws(() => enqueue(p, msg({ summary: 'password=secret' })), /Sensitive/);
  assert.throws(() => enqueue(p, msg({ references: ['../vault/data.md'] })), /Unsafe/);
});
test('supersession is explicit; a late receipt cannot revive superseded work', t => {
  const p = root(t), a = enqueue(p, msg());
  assert.throws(() => enqueue(p, msg({ from: 'codex:33333333-3333-4333-8333-333333333333', supersedes: a.envelope.id })), /supersession/);
  const b = enqueue(p, msg({ supersedes: a.envelope.id, revision: 'def456' }));
  assert.equal(get(p, a.envelope.id).work, 'superseded');
  assert.throws(() => beginAttempt(p, a.envelope.id, from), /closed/);
  receive(p, a.envelope.id, to, a.hash);
  assert.equal(get(p, a.envelope.id).work, 'superseded');
  assert.throws(() => status(p, a.envelope.id, to, 'completed', 'abc123', 'Done'), /closed/);
  receive(p, b.envelope.id, to, b.hash);
  assert.throws(() => status(p, b.envelope.id, to, 'completed', 'abc123', 'Done'), /Revision/);
});
test('a crash after the attempt claim never causes an automatic resend', t => {
  const p = root(t), m = enqueue(p, msg()); beginAttempt(p, m.envelope.id, from);
  assert.equal(get(p, m.envelope.id).delivery, 'attempting');
  let calls = 0;
  assert.throws(() => dispatch(p, m.envelope.id, from, () => { calls++; }), /retry/);
  assert.equal(calls, 0);
});
test('transport cannot fabricate receipt; a late transport result cannot downgrade one', t => {
  const p = root(t), m = enqueue(p, msg()), a = beginAttempt(p, m.envelope.id, from);
  assert.throws(() => finishAttempt(p, m.envelope.id, a.attempt.id, { state: 'received' }), /cannot assert/);
  assert.throws(() => receive(p, m.envelope.id, from, m.hash), /mismatch/);
  assert.throws(() => receive(p, m.envelope.id, to, 'bad'), /mismatch/);
  receive(p, m.envelope.id, to, m.hash);
  finishAttempt(p, m.envelope.id, a.attempt.id, { state: 'unconfirmed' });
  assert.equal(get(p, m.envelope.id).delivery, 'received');
});
test('blocked/completed status atomically creates ONE return notice; receiving it creates no ACK loop', t => {
  const p = root(t), m = enqueue(p, msg()); receive(p, m.envelope.id, to, m.hash);
  assert.throws(() => status(p, m.envelope.id, to, 'blocked', 'abc123', '   '), /required/);
  const a = status(p, m.envelope.id, to, 'blocked', 'abc123', 'Permission classifier rejected the configuration Edit');
  const b = status(p, m.envelope.id, to, 'blocked', 'abc123', 'Permission classifier rejected the configuration Edit');
  assert.equal(a.notice, b.notice); assert.equal(list(p).length, 2);
  const n = get(p, a.notice); assert.equal(n.envelope.to, from);
  receive(p, n.envelope.id, from, n.hash); assert.equal(list(p).length, 2);
  assert.match(context(p, from), /blocked.*Permission classifier/);
  assert.equal(status(p, m.envelope.id, to, 'working', 'abc123', 'Approved edit can proceed').notice, null);
  assert.notEqual(status(p, m.envelope.id, to, 'completed', 'abc123', 'Checks passed', ['docs/PROTOCOL.md']).notice, a.notice);
});
test('only the sender cancels; only the recipient reports', t => {
  const p = root(t), m = enqueue(p, msg()); receive(p, m.envelope.id, to, m.hash);
  assert.throws(() => status(p, m.envelope.id, from, 'completed', 'abc123', 'nope'), /Wrong status author/);
  assert.throws(() => status(p, m.envelope.id, to, 'cancelled', 'abc123', 'nope'), /Wrong status author/);
  const c = status(p, m.envelope.id, from, 'cancelled', 'abc123', 'Withdrawn');
  assert.equal(get(p, m.envelope.id).work, 'cancelled'); assert.equal(get(p, c.notice).envelope.to, to);
});
test('replyTo redirects return notices to a different endpoint', t => {
  const p = root(t);
  const replyDest = 'claude:33333333-3333-4333-8333-333333333333';
  const m = enqueue(p, msg({ replyTo: replyDest }));
  assert.equal(m.envelope.replyTo, replyDest);
  receive(p, m.envelope.id, to, m.hash);
  const result = status(p, m.envelope.id, to, 'completed', 'abc123', 'Done');
  const n = get(p, result.notice);
  assert.equal(n.envelope.to, replyDest, 'return notice should go to replyTo, not from');
  assert.equal(n.envelope.from, to, 'notice sender is the recipient who completed');
});

test('replyTo null falls back to sender for return notices', t => {
  const p = root(t), m = enqueue(p, msg());
  assert.equal(m.envelope.replyTo, undefined);
  receive(p, m.envelope.id, to, m.hash);
  const result = status(p, m.envelope.id, to, 'completed', 'abc123', 'Done');
  const n = get(p, result.notice);
  assert.equal(n.envelope.to, from, 'without replyTo, notice goes to original sender');
});

test('replyTo same as sender is rejected', () => {
  assert.throws(() => enqueue(root({ after() {} }), msg({ replyTo: from })), /replyTo must differ from sender/);
});

test('sender cancel notice ignores replyTo and goes to recipient', t => {
  const p = root(t);
  const replyDest = 'claude:33333333-3333-4333-8333-333333333333';
  const m = enqueue(p, msg({ replyTo: replyDest }));
  const result = status(p, m.envelope.id, from, 'cancelled', 'abc123', 'Withdrawn');
  const n = get(p, result.notice);
  assert.equal(n.envelope.to, to, 'cancel notice goes to recipient, not replyTo');
});

test('capacity failure rolls back status and notice together', t => {
  const p = root(t), m = enqueue(p, msg()); receive(p, m.envelope.id, to, m.hash);
  for (let i = 0; i < 99; i++) enqueue(p, msg({ kind: 'notice', summary: 'Notice' }));
  assert.throws(() => status(p, m.envelope.id, to, 'blocked', 'abc123', 'Denied'), /capacity/);
  assert.equal(get(p, m.envelope.id).work, 'received');
});
test('stale lock is recovered automatically', t => {
  const p = root(t);
  const wireDir = path.join(p, '.wire');
  fs.mkdirSync(wireDir, { recursive: true });
  const stateFile = path.join(wireDir, 'wire.json');
  const lockDir = stateFile + '.lock';
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), JSON.stringify({ pid: 999999999, ts: Date.now() - 60000 }));
  const m = enqueue(p, msg());
  assert.ok(m.envelope.id, 'enqueue should succeed after recovering stale lock');
  assert.ok(!fs.existsSync(lockDir), 'stale lock should be cleaned up');
});

test('orphaned temp files are cleaned on next transaction', t => {
  const p = root(t);
  const wireDir = path.join(p, '.wire');
  fs.mkdirSync(wireDir, { recursive: true });
  const stateFile = path.join(wireDir, 'wire.json');
  const orphan = stateFile + '.deadbeef.tmp';
  fs.writeFileSync(orphan, 'garbage');
  const mtime = Date.now() - 60000;
  fs.utimesSync(orphan, new Date(mtime), new Date(mtime));
  enqueue(p, msg());
  assert.ok(!fs.existsSync(orphan), 'orphaned temp older than 30s should be cleaned up');
});

test('hash check uses stored envelope, not re-canonicalized form', t => {
  const p = root(t);
  const m = enqueue(p, msg());
  const wireFile = path.join(p, '.wire', 'wire.json');
  const state = JSON.parse(fs.readFileSync(wireFile, 'utf8'));
  state.messages[0].envelope.futureField = 'v2-extension';
  state.messages[0].hash = crypto.createHash('sha256').update(JSON.stringify(state.messages[0].envelope)).digest('hex');
  fs.writeFileSync(wireFile, JSON.stringify(state, null, 2) + '\n');
  const loaded = list(p);
  assert.equal(loaded.length, 1, 'message with extra field should load when hash matches stored form');
});

test('repair recovers from corrupt wire.json using backup', t => {
  const p = root(t);
  enqueue(p, msg());
  const wireFile = path.join(p, '.wire', 'wire.json');
  const backup = wireFile + '.bak';
  assert.ok(fs.existsSync(wireFile));
  enqueue(p, msg({ kind: 'notice', summary: 'second message creates a backup' }));
  assert.ok(fs.existsSync(backup), 'backup should exist after second transaction');
  const bakContent = fs.readFileSync(backup, 'utf8');
  fs.writeFileSync(wireFile, 'NOT JSON!!!');
  assert.throws(() => list(p), /Unexpected token/);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--root', p], { encoding: 'utf8' });
  const result = JSON.parse(run(['repair']).stdout);
  assert.ok(result.fixes.some(f => f.fix && f.fix.includes('restored from backup')));
  const recovered = list(p);
  assert.equal(recovered.length, 1, 'backup had one message (before the second write)');
});

test('repair reports clean state when nothing is wrong', t => {
  const p = root(t);
  enqueue(p, msg());
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--root', p], { encoding: 'utf8' });
  const result = JSON.parse(run(['repair']).stdout);
  assert.equal(result.ok, true);
  assert.equal(result.fixes.length, 0);
});

test('backup is created on every transaction', t => {
  const p = root(t);
  enqueue(p, msg());
  const wireFile = path.join(p, '.wire', 'wire.json');
  const backup = wireFile + '.bak';
  assert.ok(!fs.existsSync(backup), 'no backup after first write (no prior state to back up)');
  enqueue(p, msg({ kind: 'notice', summary: 'triggers backup of first write' }));
  assert.ok(fs.existsSync(backup), 'backup exists after second write');
  const bak = JSON.parse(fs.readFileSync(backup, 'utf8'));
  assert.equal(bak.messages.length, 1, 'backup contains state before the second write');
});

test('host prompt recognition is first-line only; quoted envelopes are data', t => {
  const p = root(t), m = enqueue(p, msg()), body = notification(m);
  assert.equal(observePrompt(p, to, 'Review this quoted message:\n' + body), null);
  assert.equal(get(p, m.envelope.id).delivery, 'pending');
  observePrompt(p, to, 'Another Claude session sent a message:\n' + body);
  observePrompt(p, to, body);
  assert.equal(list(p).length, 1); assert.equal(get(p, m.envelope.id).work, 'received');
});
test('pull receives only this endpoint\'s inbox, in order, delta-before-advance', t => {
  const p = root(t), a = enqueue(p, msg()), n = enqueue(p, msg({ id: randomUUID(), kind: 'notice' }));
  enqueue(p, msg({ id: randomUUID(), from: to, to: 'codex:33333333-3333-4333-8333-333333333333', kind: 'notice' }));
  const pulled = pull(p, to);
  assert.deepEqual(pulled.map(m => m.envelope.id), [a.envelope.id, n.envelope.id]);
  assert.equal(get(p, a.envelope.id).work, 'received'); assert.equal(get(p, n.envelope.id).work, 'completed');
  assert.equal(cursorRead(p, to).observed, 2);
  assert.deepEqual(pull(p, to), []);
  cursorClaim(p, to, a.envelope.id, 1); assert.deepEqual(cursorRead(p, to).claims, { [a.envelope.id]: 1 });
  cursorComplete(p, to, a.envelope.id); assert.deepEqual(cursorRead(p, to).claims, {});
});
test('leases: one live owner per mailbox, fenced renew/release, expiry permits takeover', async t => {
  const p = root(t);
  const l = leaseAcquire(p, 'claude', to, ['pull'], 200);
  assert.equal(leaseResolve(p, 'claude'), to);
  // Unknown holder (no registry record) is assumed alive — safe default
  assert.throws(() => leaseAcquire(p, 'claude', 'claude:44444444-4444-4444-8444-444444444444', [], 200), /live lease/);
  assert.equal(leaseAcquire(p, 'claude', to, [], 200).fence, l.fence, 'same owner re-acquire is a renew');
  assert.throws(() => leaseRenew(p, 'claude', l.fence + 1, 200), /stale/);
  leaseRenew(p, 'claude', l.fence, 200);
  await new Promise(r => setTimeout(r, 250));
  assert.equal(leaseResolve(p, 'claude'), null);
  assert.equal(leaseList(p)[0].status, 'expired');
  const l2 = leaseAcquire(p, 'claude', 'claude:44444444-4444-4444-8444-444444444444', [], 200);
  assert.equal(l2.fence, l.fence + 1);
  assert.throws(() => leaseRelease(p, 'claude', l.fence), /stale/);
  leaseRelease(p, 'claude', l2.fence); assert.equal(leaseList(p).length, 0);
});
test('leases: dead-process holder is auto-evicted on acquire', t => {
  const p = root(t);
  const deadPid = 99999;
  const deadSession = '66666666-6666-4666-8666-666666666666';
  const deadEndpoint = `claude:${deadSession}`;
  // Use a temp USERPROFILE so we never touch the real session registry
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-test-'));
  const sessDir = path.join(tmpHome, '.claude', 'sessions');
  const origProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = tmpHome;
  t.after(() => { if (origProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origProfile; fs.rmSync(tmpHome, { recursive: true, force: true }); });
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, `${deadPid}.json`), JSON.stringify({ pid: deadPid, sessionId: deadSession, cwd: p }));
  // Holder with that dead PID gets a lease
  const l = leaseAcquire(p, 'claude', deadEndpoint, ['pull'], 60000);
  // A new session can evict the dead holder
  const newEndpoint = 'claude:77777777-7777-4777-8777-777777777777';
  const evicted = leaseAcquire(p, 'claude', newEndpoint, [], 60000);
  assert.equal(evicted.fence, l.fence + 1, 'dead holder evicted; fence advances');
  assert.equal(leaseResolve(p, 'claude'), newEndpoint);
});
test('codex driver: accepts only exit 0 + a queued id for the exact thread; env override works', t => {
  const p = root(t), thread = '22222222-2222-4222-8222-222222222222';
  const ok = () => ({ status: 0, stdout: `Queued message 0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f for thread ${thread}.\n` });
  assert.deepEqual(codexWake(thread, 'body', { run: ok }), { delivered: true, transportId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' });
  assert.equal(codexWake(thread, 'body', { run: () => ({ status: 1, stdout: '' }) }).delivered, false);
  assert.equal(codexWake(thread, 'body', { run: () => ({ status: 0, stdout: 'Queued message 0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f for thread 99999999-9999-4999-8999-999999999999.' }) }).delivered, false, 'wrong thread');
  assert.equal(codexWake('not-a-uuid', 'body', { run: ok }).delivered, false);
  assert.deepEqual(codexBin({ THE_WIRE_CODEX_BIN: '/x/codex.js' }), { cmd: process.execPath, args: ['/x/codex.js'] });
  assert.deepEqual(codexBin({ THE_WIRE_CODEX_BIN: '/x/codex' }), { cmd: '/x/codex', args: [] });
});
test('codex driver: resolves a real Windows executable before a phantom npm entrypoint', () => {
  const native = 'C:\\Codex\\bin\\codex.exe';
  const bin = codexBin(
    { Path: 'C:\\missing;C:\\Codex\\bin', APPDATA: 'C:\\Users\\person\\AppData\\Roaming' },
    { platform: 'win32', isFile: file => file.toLowerCase() === native.toLowerCase() },
  );
  assert.deepEqual(bin, { cmd: native, args: [] });
});
test('codex driver: capability probe requires version plus queue thread/message flags', () => {
  const run = (_cmd, args) => {
    if (args.at(-1) === '--version') return { status: 0, stdout: 'codex-cli test\n' };
    if (args.slice(-2).join(' ') === 'queue --help') return { status: 0, stdout: 'Usage: codex queue --thread <THREAD> --message <TEXT>\n' };
    return { status: 1, stdout: '' };
  };
  assert.deepEqual(probeCodex({ run, env: { THE_WIRE_CODEX_BIN: '/x/codex' } }), {
    resolved: '/x/codex', version: 'codex-cli test', queueSupported: true,
  });
  const noQueue = probeCodex({ run: (_cmd, args) => args.at(-1) === '--version' ? { status: 0, stdout: 'codex-cli test' } : { status: 0, stdout: 'Usage: codex queue' }, env: { THE_WIRE_CODEX_BIN: '/x/codex' } });
  assert.equal(noQueue.queueSupported, false);
});
test('codex driver: acceptance parser is exact and fail-closed', () => {
  const thread = '22222222-2222-4222-8222-222222222222';
  const message = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
  assert.equal(parseQueueAcceptance(`Queued message ${message} for thread ${thread}.`, thread), message);
  assert.equal(parseQueueAcceptance(`diagnostic: Queued message ${message} for thread ${thread}.`, thread), null);
  assert.equal(parseQueueAcceptance(`Queued message not-a-uuid for thread ${thread}.`, thread), null);
  assert.equal(parseQueueAcceptance(`Queued message ${message} for thread 99999999-9999-4999-8999-999999999999.`, thread), null);
});
test('dispatch marks accepted only when the codex driver confirms; claude pipe close is never accepted', t => {
  const p = root(t);
  const toCodex = enqueue(p, msg({ from: to, to: from }));
  const r1 = dispatch(p, toCodex.envelope.id, to, () => ({ status: 0, stdout: `Queued message 0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f for thread ${from.split(':')[1]}.` }));
  assert.equal(r1.delivery, 'accepted'); assert.equal(r1.attempt.transportId, '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f');
  const toClaude = enqueue(p, msg({ kind: 'notice' }));
  const r2 = dispatch(p, toClaude.envelope.id, from, () => ({ status: 0, stdout: JSON.stringify({ sessionId: to.split(':')[1], transport: 'closed', messageId: toClaude.envelope.id }) }));
  assert.equal(r2.delivery, 'unconfirmed', 'a closed pipe is transport completion, not acceptance');
  assert.equal(r2.attempt.transportId, toClaude.envelope.id);
});
test('steward: dispatches pending once, re-wakes unconfirmed with a cap, never touches delivery state', t => {
  const p = root(t), m = enqueue(p, msg());
  const wakes = [];
  const opts = { dispatch: (r, id, actor) => dispatch(r, id, actor, () => ({ status: 1 })), wake: (...a) => { wakes.push(a[1]); return { delivered: false }; } };
  assert.deepEqual(sweep(p, opts).map(r => r.op), ['dispatch']);
  assert.equal(get(p, m.envelope.id).delivery, 'unconfirmed');
  assert.deepEqual(sweep(p, opts).map(r => r.op), ['rewake']);
  assert.deepEqual(sweep(p, opts), [], 'backoff holds the second rewake');
  assert.equal(get(p, m.envelope.id).delivery, 'unconfirmed');
  assert.equal(wakes[0], to.split(':')[1], 'wakes the exact addressee');
});
test('health + archive: refuses with outstanding work, preserves sequences and leases', t => {
  const p = root(t), m = enqueue(p, msg());
  leaseAcquire(p, 'claude', to, [], 60000);
  assert.equal(wireHealth(p).archiveReady, false);
  assert.throws(() => archive(p), /outstanding/);
  receive(p, m.envelope.id, to, m.hash);
  const done = status(p, m.envelope.id, to, 'completed', 'abc123', 'ok');
  assert.throws(() => archive(p), /unsent notice/);
  receive(p, done.notice, from, get(p, done.notice).hash);
  const r = archive(p);
  assert.equal(r.messages, 2); assert.equal(list(p).length, 0);
  assert.ok(fs.existsSync(path.join(p, r.archive)));
  assert.equal(enqueue(p, msg()).seq, 2, 'sequence continues after archive');
  assert.equal(leaseResolve(p, 'claude'), to, 'leases survive archive');
});
test('CLI end to end: lease → send by mailbox name → inbox → status → health', t => {
  const p = root(t), stub = stubCodex(p, 'Queued message 0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f for thread THREAD.');
  const env = { ...process.env, THE_WIRE_CODEX_BIN: stub };
  const cli = (args, input) => { const r = spawnSync(process.execPath, [CLI, ...args, '--root', p], { encoding: 'utf8', input, env, windowsHide: true }); if (r.status !== 0) throw Error(`${args.join(' ')} → ${r.stderr}`); return JSON.parse(r.stdout); };
  const claude = 'claude:11111111-1111-4111-8111-111111111111', codex = 'codex:22222222-2222-4222-8222-222222222222';
  cli(['lease', 'acquire', '--mailbox', 'claude', '--as', claude]);
  cli(['lease', 'acquire', '--mailbox', 'codex', '--as', codex]);
  const sent = cli(['send', '--from', 'claude', '--to', 'codex', '--kind', 'assignment', '--task', 'canary', '--summary', 'CANARY 1', '--revision', 'r1']);
  assert.equal(sent.enqueued.envelope.from, claude); assert.equal(sent.enqueued.envelope.to, codex);
  assert.match(sent.enqueued.envelope.summary, /^WIRE-ID: [0-9a-f-]{36}\. CANARY 1$/);
  assert.equal(sent.dispatched.delivery, 'accepted');
  const inbox = cli(['inbox', '--as', codex]);
  assert.equal(inbox.length, 1); assert.equal(inbox[0].work, 'received');
  const st = cli(['status', '--id', sent.enqueued.envelope.id, '--as', codex, '--state', 'completed', '--revision', 'r1'], JSON.stringify({ summary: 'canary seen', references: ['README.md'] }));
  assert.equal(st.message.work, 'completed'); assert.ok(st.notice);
  assert.equal(cli(['health']).outstandingAssignments, 0);
  const r = spawnSync(process.execPath, [CLI, 'send', '--from', 'claude', '--to', 'nobody', '--kind', 'notice', '--task', 't', '--summary', 'x', '--root', p], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(r.status, 1); assert.match(r.stderr, /No live lease for mailbox "nobody"/);
});

test('CLI send --reply-to redirects return notice to a different session', t => {
  const p = root(t), stub = stubCodex(p, 'Queued message 0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f for thread THREAD.');
  const env = { ...process.env, THE_WIRE_CODEX_BIN: stub };
  const cli = (args, input) => { const r = spawnSync(process.execPath, [CLI, ...args, '--root', p], { encoding: 'utf8', input, env, windowsHide: true }); if (r.status !== 0) throw Error(`${args.join(' ')} → ${r.stderr}`); return JSON.parse(r.stdout); };
  const desk = 'claude:11111111-1111-4111-8111-111111111111';
  const minecraft = 'claude:33333333-3333-4333-8333-333333333333';
  const codex = 'codex:22222222-2222-4222-8222-222222222222';
  cli(['lease', 'acquire', '--mailbox', 'claude.desk', '--as', desk]);
  cli(['lease', 'acquire', '--mailbox', 'claude.minecraft', '--as', minecraft]);
  cli(['lease', 'acquire', '--mailbox', 'codex', '--as', codex]);
  const sent = cli(['send', '--from', 'claude.desk', '--to', 'codex', '--kind', 'assignment', '--task', 'review', '--summary', 'Review arch', '--revision', 'r1', '--reply-to', 'claude.minecraft']);
  assert.equal(sent.enqueued.envelope.replyTo, minecraft);
  cli(['inbox', '--as', codex]);
  const st = cli(['status', '--id', sent.enqueued.envelope.id, '--as', codex, '--state', 'completed', '--revision', 'r1'], JSON.stringify({ summary: 'Done', references: [] }));
  const notice = cli(['read', '--id', st.notice]);
  assert.equal(notice.envelope.to, minecraft, 'return notice must go to replyTo, not the original sender');
  assert.equal(notice.envelope.from, codex);
});

test('prompt hook is quiet when nothing is new and nothing awaits action', t => {
  const r = root(t);
  const hook = path.join(REPO, 'lib', 'hook.mjs');
  const session = '22222222-2222-4222-8222-222222222222';
  const run = () => spawnSync(process.execPath, [hook, '--root', r, '--provider', 'claude'], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'hello', cwd: r }),
    encoding: 'utf8',
  });
  const empty = run();
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout.trim()), {}, 'an empty inbox must inject nothing');
  enqueue(r, msg({ kind: 'notice', summary: 'A notice that needs no reply' }));
  const first = run();
  const out = JSON.parse(first.stdout.trim());
  assert.ok(out.hookSpecificOutput?.additionalContext?.includes('NEW this pull'), 'the pull that first sees a message surfaces it');
  const again = run();
  assert.deepEqual(JSON.parse(again.stdout.trim()), {}, 'the same received notice must not be re-injected on the next prompt');
  enqueue(r, msg({ kind: 'assignment', summary: 'Review this revision please' }));
  run();
  const pending = run();
  assert.match(JSON.parse(pending.stdout.trim()).hookSpecificOutput.additionalContext, /ACTION PENDING/, 'an assignment awaiting action stays visible until acted on');
});

test('multi-session: one endpoint can hold multiple named mailboxes, all renewed together', (t) => {
  const r = root(t);
  const sessionA = 'codex:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionB = 'codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  leaseAcquire(r, 'codex.inflow', sessionA, ['pull', 'context'], 30000);
  leaseAcquire(r, 'codex', sessionA, ['pull', 'context'], 30000);
  leaseAcquire(r, 'codex.minecraft', sessionB, ['pull', 'context'], 30000);
  assert.equal(leaseResolve(r, 'codex'), sessionA);
  assert.equal(leaseResolve(r, 'codex.inflow'), sessionA);
  assert.equal(leaseResolve(r, 'codex.minecraft'), sessionB);
  const renewed = leaseRenewEndpoint(r, sessionA, 60000);
  assert.deepEqual(renewed.sort(), ['codex', 'codex.inflow']);
  const renewedB = leaseRenewEndpoint(r, sessionB, 60000);
  assert.deepEqual(renewedB, ['codex.minecraft']);
  const all = leasesByPrefix(r, 'codex');
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(a => a.mailbox), ['codex', 'codex.inflow', 'codex.minecraft']);
  assert.equal(all.find(a => a.mailbox === 'codex.inflow').endpoint, sessionA);
  assert.equal(all.find(a => a.mailbox === 'codex.minecraft').endpoint, sessionB);
});

test('multi-session: send resolves named mailboxes and messages reach the right endpoint', (t) => {
  const r = root(t);
  const codexInflow = 'codex:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const codexMinecraft = 'codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const claude = 'claude:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  leaseAcquire(r, 'codex.inflow', codexInflow, ['pull', 'context'], 30000);
  leaseAcquire(r, 'codex.minecraft', codexMinecraft, ['pull', 'context'], 30000);
  leaseAcquire(r, 'claude', claude, ['pull', 'context'], 30000);
  const m1 = enqueue(r, msg({ from: claude, to: codexInflow, task: 'inflow-review', summary: 'Review inflow build' }));
  assert.equal(m1.envelope.to, codexInflow);
  const m2 = enqueue(r, msg({ from: claude, to: codexMinecraft, task: 'minecraft-build', summary: 'Build the thing' }));
  assert.equal(m2.envelope.to, codexMinecraft);
  const inflowInbox = pull(r, codexInflow);
  assert.equal(inflowInbox.length, 1);
  assert.equal(inflowInbox[0].envelope.task, 'inflow-review');
  const mcInbox = pull(r, codexMinecraft);
  assert.equal(mcInbox.length, 1);
  assert.equal(mcInbox[0].envelope.task, 'minecraft-build');
});

test('multi-session: CLI roster groups by provider and resolveAddress suggests named mailboxes', (t) => {
  const r = root(t);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--root', r], { encoding: 'utf8' });
  run('lease', 'acquire', '--mailbox', 'codex.inflow', '--as', 'codex:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  run('lease', 'acquire', '--mailbox', 'codex.minecraft', '--as', 'codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  run('lease', 'acquire', '--mailbox', 'claude', '--as', 'claude:cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const roster = run('roster');
  assert.equal(roster.status, 0, roster.stderr);
  const result = JSON.parse(roster.stdout);
  assert.equal(result.providers.codex.length, 2);
  assert.equal(result.providers.claude.length, 1);
  const allMailboxes = result.providers.codex.flatMap(s => s.mailboxes);
  assert.ok(allMailboxes.includes('codex.inflow'));
  assert.ok(allMailboxes.includes('codex.minecraft'));
  const sendBare = run('send', '--from', 'claude', '--to', 'codex', '--kind', 'notice', '--task', 'test', '--summary', 'hello');
  assert.equal(sendBare.status, 1);
  assert.match(sendBare.stderr, /codex\.inflow/);
  assert.match(sendBare.stderr, /codex\.minecraft/);
  const sendNamed = run('send', '--from', 'claude', '--to', 'codex.inflow', '--kind', 'notice', '--task', 'test', '--summary', 'hello');
  assert.equal(sendNamed.status, 0, sendNamed.stderr);
  const sent = JSON.parse(sendNamed.stdout);
  assert.equal(sent.enqueued.envelope.to, 'codex:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('multi-session: hook renews all mailboxes held by the session and leases a --mailbox name', (t) => {
  const r = root(t);
  const session = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const actor = `claude:${session}`;
  leaseAcquire(r, 'claude.desk', actor, ['pull', 'context'], 5000);
  const hookPath = path.join(REPO, 'lib', 'hook.mjs');
  const run = (prompt = 'hello') => spawnSync(process.execPath, [hookPath, '--root', r, '--provider', 'claude', '--mailbox', 'claude.desk'], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt, cwd: r }),
    encoding: 'utf8',
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const leases = leaseList(r).filter(l => l.status === 'active');
  assert.ok(leases.some(l => l.mailbox === 'claude.desk'), 'hook must renew the named mailbox');
  assert.ok(leases.some(l => l.mailbox === 'claude'), 'hook must also acquire the bare provider mailbox');
  assert.equal(leases.filter(l => l.endpoint === actor).length, 2);
});

test('roster shows working state and pending inbox per session', (t) => {
  const r = root(t);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--root', r], { encoding: 'utf8' });
  const codexA = 'codex:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const claudeC = 'claude:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  run('lease', 'acquire', '--mailbox', 'codex.worker', '--as', codexA);
  run('lease', 'acquire', '--mailbox', 'claude', '--as', claudeC);
  const sent = run('send', '--from', 'claude', '--to', 'codex.worker', '--kind', 'assignment', '--task', 'heavy-lift', '--summary', 'do the thing', '--revision', 'abc');
  assert.equal(sent.status, 0, sent.stderr);
  const assignmentId = JSON.parse(sent.stdout).enqueued.envelope.id;
  const roster = run('roster');
  assert.equal(roster.status, 0, roster.stderr);
  const result = JSON.parse(roster.stdout);
  const codexSession = result.providers.codex[0];
  assert.deepEqual(codexSession.mailboxes, ['codex.worker']);
  assert.ok(codexSession.working);
  assert.equal(codexSession.working.task, 'heavy-lift');
  assert.equal(codexSession.working.id, assignmentId);
  assert.equal(codexSession.pendingInbox, 1);
  const claudeSession = result.providers.claude[0];
  assert.equal(claudeSession.working, undefined);
  assert.equal(claudeSession.pendingInbox, undefined);
});

test('activeAssignment returns the blocking message and error includes its id and task', (t) => {
  const r = root(t);
  const m1 = enqueue(r, msg({ task: 'old-build' }));
  const active = activeAssignment(r, to);
  assert.ok(active);
  assert.equal(active.envelope.id, m1.envelope.id);
  assert.equal(active.envelope.task, 'old-build');
  try { enqueue(r, msg({ task: 'new-build' })); assert.fail('should throw'); } catch (err) {
    assert.match(err.message, /old-build/);
    assert.match(err.message, new RegExp(m1.envelope.id));
    assert.match(err.message, /--supersedes.*auto/);
    assert.equal(err.activeId, m1.envelope.id);
  }
});

test('enqueueReplace cancels active cross-task assignment and enqueues new one atomically', (t) => {
  const r = root(t);
  const m1 = enqueue(r, msg({ task: 'stale-build' }));
  assert.ok(activeAssignment(r, to));
  const result = enqueueReplace(r, msg({ task: 'fresh-work' }));
  assert.equal(result.replaced.id, m1.envelope.id);
  assert.equal(result.replaced.task, 'stale-build');
  assert.equal(get(r, m1.envelope.id).work, 'cancelled');
  assert.equal(activeAssignment(r, to).envelope.id, result.message.envelope.id);
  assert.equal(result.message.envelope.task, 'fresh-work');
});

test('enqueueReplace is a no-op when no active assignment exists', (t) => {
  const r = root(t);
  const result = enqueueReplace(r, msg({ task: 'first-job' }));
  assert.equal(result.replaced, null);
  assert.equal(result.message.envelope.task, 'first-job');
  assert.equal(activeAssignment(r, to).envelope.id, result.message.envelope.id);
});

test('CLI send --supersedes auto replaces active assignment without knowing its id', (t) => {
  const r = root(t);
  leaseAcquire(r, 'claude', from, ['pull', 'context'], 60000);
  leaseAcquire(r, 'codex', to, ['pull', 'context'], 60000);
  const send = (task, supersedes) => {
    const args = [CLI, 'send', '--root', r, '--from', 'claude', '--to', 'codex', '--kind', 'assignment', '--task', task, '--summary', 'test', '--revision', 'abc'];
    if (supersedes) args.push('--supersedes', supersedes);
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
  };
  const r1 = send('build-a');
  assert.equal(r1.status, 0, r1.stderr);
  const id1 = JSON.parse(r1.stdout).enqueued.envelope.id;
  const r2 = send('build-b');
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /build-a/);
  assert.match(r2.stderr, new RegExp(id1));
  const r3 = send('build-b', 'auto');
  assert.equal(r3.status, 0, r3.stderr);
  const result = JSON.parse(r3.stdout);
  assert.equal(result.enqueued.envelope.task, 'build-b');
  assert.ok(result.replaced);
  assert.equal(result.replaced.id, id1);
  assert.equal(get(r, id1).work, 'cancelled');
});

test('CLI send --in-reply-to auto-routes to the original sender endpoint and inherits revision', t => {
  const r = root(t);
  const desk = 'claude:11111111-1111-4111-8111-111111111111';
  const mc   = 'claude:22222222-2222-4222-8222-222222222222';
  const cx   = 'codex:33333333-3333-4333-8333-333333333333';
  leaseAcquire(r, 'claude.desk', desk, ['pull'], 60000);
  leaseAcquire(r, 'claude.minecraft', mc, ['pull'], 60000);
  leaseAcquire(r, 'codex.minecraft', cx, ['pull'], 60000);
  const cli = (args) => { const res = spawnSync(process.execPath, [CLI, ...args, '--root', r], { encoding: 'utf8' }); return res; };
  const sent = JSON.parse(cli(['send', '--from', 'codex.minecraft', '--to', 'claude.minecraft', '--kind', 'notice', '--task', 'canary', '--summary', 'CANARY hello', '--revision', 'abc']).stdout);
  const reply = JSON.parse(cli(['send', '--from', 'claude.minecraft', '--in-reply-to', sent.enqueued.envelope.id, '--kind', 'notice', '--summary', 'CANARY reply']).stdout);
  assert.equal(reply.enqueued.envelope.to, cx, '--in-reply-to routes to original sender endpoint');
  assert.equal(reply.enqueued.envelope.task, 'canary', '--in-reply-to inherits task');
  assert.equal(reply.enqueued.envelope.revision, 'abc', '--in-reply-to inherits revision');
  // --to and --in-reply-to are mutually exclusive
  const conflict = cli(['send', '--from', 'claude.minecraft', '--to', 'claude.desk', '--in-reply-to', sent.enqueued.envelope.id, '--kind', 'notice', '--task', 'x', '--summary', 'bad']);
  assert.equal(conflict.status, 1, '--to with --in-reply-to must fail');
  assert.match(conflict.stderr, /mutually exclusive/);
  // only the original recipient can use --in-reply-to
  const thirdParty = cli(['send', '--from', 'claude.desk', '--in-reply-to', sent.enqueued.envelope.id, '--kind', 'notice', '--summary', 'impostor reply']);
  assert.equal(thirdParty.status, 1, 'third-party --in-reply-to must fail');
  assert.match(thirdParty.stderr, /only the original recipient/);
});

test('error messages include the message ID for diagnostics', t => {
  const p = root(t);
  const m = enqueue(p, msg());
  const bogusId = randomUUID();
  assert.throws(() => status(p, bogusId, to, 'working', 'abc123', 'test'), { message: new RegExp(bogusId) });
  const wireFile = path.join(p, '.wire', 'wire.json');
  const state = JSON.parse(fs.readFileSync(wireFile, 'utf8'));
  state.messages[0].hash = 'deadbeef'.repeat(8);
  fs.writeFileSync(wireFile, JSON.stringify(state));
  assert.throws(() => receive(p, m.envelope.id, to, m.hash), { message: new RegExp(m.envelope.id) });
});

test('context degrades gracefully when cursor state is corrupt', t => {
  const p = root(t);
  enqueue(p, msg());
  const cursorsFile = path.join(p, '.wire', 'cursors.json');
  fs.mkdirSync(path.dirname(cursorsFile), { recursive: true });
  fs.writeFileSync(cursorsFile, '{"schema":"bad"}');
  const result = context(p, to, []);
  assert.ok(result.includes('the-wire inbox'), 'context returned despite corrupt cursors');
});

test('archive filenames are unique across same-second calls', t => {
  const p = root(t);
  const m = enqueue(p, msg({ kind: 'notice' }));
  receive(p, m.envelope.id, to, m.hash);
  const r1 = archive(p);
  enqueue(p, msg({ id: randomUUID(), kind: 'notice' }));
  receive(p, list(p)[0].envelope.id, list(p)[0].envelope.to, list(p)[0].hash);
  const r2 = archive(p);
  assert.notEqual(r1.archive, r2.archive);
  const archiveFiles = fs.readdirSync(path.join(p, '.wire', 'archive'));
  assert.equal(archiveFiles.length, 2);
});

test('N×N isolation: 3 Claude + 2 Codex sessions route correctly with no cross-contamination', t => {
  const r = root(t);
  const claudeDesk = 'claude:11111111-1111-4111-8111-111111111111';
  const claudeMC   = 'claude:22222222-2222-4222-8222-222222222222';
  const claudeFlow = 'claude:33333333-3333-4333-8333-333333333333';
  const codexMC    = 'codex:44444444-4444-4444-8444-444444444444';
  const codexFlow  = 'codex:55555555-5555-4555-8555-555555555555';

  leaseAcquire(r, 'claude',           claudeDesk, ['pull', 'context'], 60000);
  leaseAcquire(r, 'claude.minecraft', claudeMC,   ['pull', 'context'], 60000);
  leaseAcquire(r, 'claude.inflow',    claudeFlow, ['pull', 'context'], 60000);
  leaseAcquire(r, 'codex.minecraft',  codexMC,    ['pull', 'context'], 60000);
  leaseAcquire(r, 'codex.inflow',     codexFlow,  ['pull', 'context'], 60000);

  // 1. Desk sends MC work to codex.minecraft
  const a1 = enqueue(r, msg({ from: claudeDesk, to: codexMC, task: 'mc-build', summary: 'Build the server' }));
  // 2. Desk sends inflow work to codex.inflow, replyTo → claude.inflow
  const a2 = enqueue(r, msg({ from: claudeDesk, to: codexFlow, task: 'jd-fetch', summary: 'Fetch the JDs', replyTo: claudeFlow }));
  // 3. Claude.minecraft sends its own work to same codex.minecraft (blocked — one active)
  assert.throws(() => enqueue(r, msg({ from: claudeMC, to: codexMC, task: 'mc-review', summary: 'Review arch' })), /active assignment/);

  // Each Codex pulls only its own inbox
  const mcPull = pull(r, codexMC);
  assert.equal(mcPull.length, 1);
  assert.equal(mcPull[0].envelope.task, 'mc-build');

  const flowPull = pull(r, codexFlow);
  assert.equal(flowPull.length, 1);
  assert.equal(flowPull[0].envelope.task, 'jd-fetch');

  // Claude sessions see nothing in their pull yet (no messages addressed TO them)
  assert.deepEqual(pull(r, claudeDesk), []);
  assert.deepEqual(pull(r, claudeMC), []);
  assert.deepEqual(pull(r, claudeFlow), []);

  // 4. Codex.minecraft completes — notice goes to desk (the sender)
  const s1 = status(r, a1.envelope.id, codexMC, 'completed', 'abc123', 'Server built', []);
  const notice1 = get(r, s1.notice);
  assert.equal(notice1.envelope.to, claudeDesk, 'MC completion notice → desk');
  assert.notEqual(notice1.envelope.to, claudeMC, 'MC notice must NOT go to claude.minecraft');

  // 5. Codex.inflow completes — notice goes to claude.inflow (via replyTo), NOT desk
  const s2 = status(r, a2.envelope.id, codexFlow, 'completed', 'abc123', 'JDs fetched', []);
  const notice2 = get(r, s2.notice);
  assert.equal(notice2.envelope.to, claudeFlow, 'Inflow completion notice → claude.inflow via replyTo');
  assert.notEqual(notice2.envelope.to, claudeDesk, 'Inflow notice must NOT go to desk');

  // 6. Each Claude session's pull returns only its own notices
  const deskPull = pull(r, claudeDesk);
  assert.equal(deskPull.length, 1);
  assert.equal(deskPull[0].envelope.id, notice1.envelope.id, 'desk gets MC notice');

  const flowPull2 = pull(r, claudeFlow);
  assert.equal(flowPull2.length, 1);
  assert.equal(flowPull2[0].envelope.id, notice2.envelope.id, 'claude.inflow gets inflow notice');

  const mcPull2 = pull(r, claudeMC);
  assert.equal(mcPull2.length, 0, 'claude.minecraft gets nothing — it sent nothing, received nothing');

  // 7. Context isolation — each session's context only contains its own messages
  const deskCtx = context(r, claudeDesk, []);
  assert.ok(deskCtx.includes('mc-build'), 'desk sees its outgoing MC assignment');
  assert.ok(deskCtx.includes('jd-fetch'), 'desk sees its outgoing inflow assignment');

  // claude.inflow only has the return notice; context shows it when passed as fresh
  const flowCtx = context(r, claudeFlow, [notice2]);
  assert.ok(flowCtx.includes(notice2.envelope.id), 'claude.inflow sees its return notice when fresh');
  assert.ok(!flowCtx.includes('mc-build'), 'claude.inflow does NOT see MC work');

  // list() isolation — claude.inflow only has the return notice
  const flowMsgs = list(r, claudeFlow);
  assert.equal(flowMsgs.length, 1, 'claude.inflow has exactly 1 message');
  assert.equal(flowMsgs[0].envelope.id, notice2.envelope.id);

  const mcCtx = context(r, claudeMC, []);
  assert.equal(mcCtx, '', 'claude.minecraft has no messages at all');

  // 8. After a1 is complete, claude.minecraft CAN now send to codex.minecraft
  const a3 = enqueue(r, msg({ from: claudeMC, to: codexMC, task: 'mc-review', summary: 'Review arch' }));
  assert.equal(a3.envelope.from, claudeMC);
  assert.equal(a3.envelope.to, codexMC);
  const mcPull3 = pull(r, codexMC);
  assert.equal(mcPull3.length, 1);
  assert.equal(mcPull3[0].envelope.task, 'mc-review');
  assert.equal(mcPull3[0].envelope.from, claudeMC, 'codex.minecraft sees sender is claude.minecraft');
});

test('N×N CLI: named mailbox routing end-to-end through the CLI', t => {
  const r = root(t);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--root', r], { encoding: 'utf8' });
  const runWithInput = (input, ...args) => spawnSync(process.execPath, [CLI, ...args, '--root', r], { input: JSON.stringify(input), encoding: 'utf8' });

  // Set up 2 Claude + 2 Codex sessions
  run('lease', 'acquire', '--mailbox', 'claude.desk',      '--as', 'claude:11111111-1111-4111-8111-111111111111');
  run('lease', 'acquire', '--mailbox', 'claude.minecraft',  '--as', 'claude:22222222-2222-4222-8222-222222222222');
  run('lease', 'acquire', '--mailbox', 'codex.minecraft',   '--as', 'codex:33333333-3333-4333-8333-333333333333');
  run('lease', 'acquire', '--mailbox', 'codex.inflow',      '--as', 'codex:44444444-4444-4444-8444-444444444444');

  // Desk sends to codex.minecraft with replyTo claude.minecraft
  const send1 = run('send', '--from', 'claude.desk', '--to', 'codex.minecraft', '--reply-to', 'claude.minecraft',
    '--kind', 'assignment', '--task', 'mc-build', '--summary', 'Build', '--revision', 'abc');
  assert.equal(send1.status, 0, send1.stderr);
  const sent1 = JSON.parse(send1.stdout).enqueued;
  assert.equal(sent1.envelope.to, 'codex:33333333-3333-4333-8333-333333333333');
  assert.equal(sent1.envelope.replyTo, 'claude:22222222-2222-4222-8222-222222222222');

  // Desk sends to codex.inflow (no replyTo — notice returns to desk)
  const send2 = run('send', '--from', 'claude.desk', '--to', 'codex.inflow',
    '--kind', 'assignment', '--task', 'jd-fetch', '--summary', 'Fetch', '--revision', 'abc');
  assert.equal(send2.status, 0, send2.stderr);
  const sent2 = JSON.parse(send2.stdout).enqueued;
  assert.equal(sent2.envelope.to, 'codex:44444444-4444-4444-8444-444444444444');

  // Codex.minecraft receives and completes
  const inbox1 = run('inbox', '--as', 'codex:33333333-3333-4333-8333-333333333333');
  assert.equal(inbox1.status, 0, inbox1.stderr);
  const pulled1 = JSON.parse(inbox1.stdout);
  assert.equal(pulled1.length, 1);
  assert.equal(pulled1[0].envelope.task, 'mc-build');

  const complete1 = runWithInput({ summary: 'Server built', references: [] },
    'status', '--id', sent1.envelope.id, '--as', 'codex:33333333-3333-4333-8333-333333333333',
    '--state', 'completed', '--revision', 'abc');
  assert.equal(complete1.status, 0, complete1.stderr);

  // Codex.inflow receives and completes
  const inbox2 = run('inbox', '--as', 'codex:44444444-4444-4444-8444-444444444444');
  assert.equal(inbox2.status, 0, inbox2.stderr);
  const pulled2 = JSON.parse(inbox2.stdout);
  assert.equal(pulled2.length, 1);
  assert.equal(pulled2[0].envelope.task, 'jd-fetch');

  const complete2 = runWithInput({ summary: 'JDs fetched', references: [] },
    'status', '--id', sent2.envelope.id, '--as', 'codex:44444444-4444-4444-8444-444444444444',
    '--state', 'completed', '--revision', 'abc');
  assert.equal(complete2.status, 0, complete2.stderr);

  // claude.minecraft gets the MC notice (via replyTo), desk gets the inflow notice
  const mcInbox = run('inbox', '--as', 'claude:22222222-2222-4222-8222-222222222222');
  assert.equal(mcInbox.status, 0, mcInbox.stderr);
  const mcNotices = JSON.parse(mcInbox.stdout);
  assert.equal(mcNotices.length, 1, 'claude.minecraft gets exactly 1 notice');
  assert.ok(mcNotices[0].envelope.summary.includes('mc-build') || mcNotices[0].envelope.summary.includes(sent1.envelope.id));

  const deskInbox = run('inbox', '--as', 'claude:11111111-1111-4111-8111-111111111111');
  assert.equal(deskInbox.status, 0, deskInbox.stderr);
  const deskNotices = JSON.parse(deskInbox.stdout);
  assert.equal(deskNotices.length, 1, 'claude.desk gets exactly 1 notice (inflow, not MC)');
  assert.ok(deskNotices[0].envelope.summary.includes('jd-fetch') || deskNotices[0].envelope.summary.includes(sent2.envelope.id));

  // Roster shows all 4 sessions correctly
  const roster = run('roster');
  assert.equal(roster.status, 0, roster.stderr);
  const r2 = JSON.parse(roster.stdout);
  assert.equal(r2.total, 4);
});

test('session replacement: new session takes over mailbox but cannot read predecessor mail', async t => {
  const r = root(t);
  const claudeDesk = 'claude:11111111-1111-4111-8111-111111111111';
  const codexV1    = 'codex:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const codexV2    = 'codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  leaseAcquire(r, 'claude', claudeDesk, ['pull', 'context'], 60000);
  leaseAcquire(r, 'codex', codexV1, ['pull', 'context'], 200);

  // Send assignment to codex (resolves to codexV1)
  const a = enqueue(r, msg({ from: claudeDesk, to: codexV1, task: 'build', summary: 'Build it' }));
  assert.equal(a.envelope.to, codexV1);

  // CodexV1 dies — lease expires
  await new Promise(ok => setTimeout(ok, 250));
  assert.equal(leaseResolve(r, 'codex'), null, 'codexV1 lease expired');

  // CodexV2 takes over the mailbox
  leaseAcquire(r, 'codex', codexV2, ['pull', 'context'], 60000);
  assert.equal(leaseResolve(r, 'codex'), codexV2);

  // CodexV2 cannot pull codexV1's messages — pull is endpoint-scoped
  const v2Pull = pull(r, codexV2);
  assert.equal(v2Pull.length, 0, 'codexV2 cannot see codexV1 mail');

  // The message is still pending for codexV1
  const m = get(r, a.envelope.id);
  assert.equal(m.envelope.to, codexV1, 'envelope.to is immutable — still codexV1');
  assert.equal(m.delivery, 'pending', 'never delivered to anyone');

  // Sender can cancel the stranded message and re-send to the new session
  status(r, a.envelope.id, claudeDesk, 'cancelled', 'abc123', 'CodexV1 died; re-sending', []);
  const a2 = enqueue(r, msg({ from: claudeDesk, to: codexV2, task: 'build', summary: 'Build it (retry)' }));
  assert.equal(a2.envelope.to, codexV2);

  const v2Pull2 = pull(r, codexV2);
  assert.equal(v2Pull2.length, 1);
  assert.equal(v2Pull2[0].envelope.task, 'build');
});

test('concurrent senders: two Claude sessions cannot both assign to the same Codex', t => {
  const r = root(t);
  const claudeA = 'claude:11111111-1111-4111-8111-111111111111';
  const claudeB = 'claude:22222222-2222-4222-8222-222222222222';
  const codex   = 'codex:33333333-3333-4333-8333-333333333333';

  leaseAcquire(r, 'claude.desk', claudeA, ['pull', 'context'], 60000);
  leaseAcquire(r, 'claude.mc',   claudeB, ['pull', 'context'], 60000);
  leaseAcquire(r, 'codex',       codex,   ['pull', 'context'], 60000);

  // Claude A sends first
  const a1 = enqueue(r, msg({ from: claudeA, to: codex, task: 'build-a', summary: 'From A' }));
  assert.equal(a1.envelope.from, claudeA);

  // Claude B tries to send — blocked by active assignment
  assert.throws(
    () => enqueue(r, msg({ from: claudeB, to: codex, task: 'build-b', summary: 'From B' })),
    /active assignment/
  );

  // Claude B cannot supersede A's assignment (different sender)
  assert.throws(
    () => enqueue(r, msg({ from: claudeB, to: codex, task: 'build-b', summary: 'From B', supersedes: a1.envelope.id })),
    /Invalid supersession/
  );

  // Claude A CAN supersede its own assignment (same task required)
  const a2 = enqueue(r, msg({ from: claudeA, to: codex, task: 'build-a', summary: 'From A v2', supersedes: a1.envelope.id }));
  assert.equal(get(r, a1.envelope.id).work, 'superseded');
  assert.equal(a2.envelope.from, claudeA);

  // Now Claude B still can't send (A's new assignment is active)
  assert.throws(
    () => enqueue(r, msg({ from: claudeB, to: codex, task: 'build-b', summary: 'From B' })),
    /active assignment/
  );

  // Claude B cannot use enqueueReplace either — different sender rejected
  assert.throws(
    () => { const raw = { id: randomUUID(), from: claudeB, to: codex, task: 'build-b', kind: 'assignment', revision: 'abc123', summary: 'From B via replace', references: [] }; enqueueReplace(r, raw); },
    /Cannot replace another sender/
  );

  // After A completes, B can send
  pull(r, codex);
  status(r, a2.envelope.id, codex, 'completed', 'abc123', 'Done', []);
  const b1 = enqueue(r, msg({ from: claudeB, to: codex, task: 'build-b', summary: 'From B finally' }));
  assert.equal(b1.envelope.from, claudeB);
});
