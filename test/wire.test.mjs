import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, get, list, beginAttempt, finishAttempt, receive, pull, cursorRead, cursorClaim, cursorComplete, leaseAcquire, leaseRenew, leaseRelease, leaseResolve, leaseList, status, observePrompt, context, notification, wireHealth, archive, endpoint } from '../lib/wire-store.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { wake as codexWake, codexBin, probeCodex, parseQueueAcceptance } from '../lib/drivers/codex-queue.mjs';
import { sweep } from '../lib/steward.mjs';
import { validateReferences, validateText } from '../lib/store.mjs';

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
test('capacity failure rolls back status and notice together', t => {
  const p = root(t), m = enqueue(p, msg()); receive(p, m.envelope.id, to, m.hash);
  for (let i = 0; i < 99; i++) enqueue(p, msg({ kind: 'notice', summary: 'Notice' }));
  assert.throws(() => status(p, m.envelope.id, to, 'blocked', 'abc123', 'Denied'), /capacity/);
  assert.equal(get(p, m.envelope.id).work, 'received');
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
