import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { enqueue, archive, wireHealth, leaseAcquire } from '../lib/wire-store.mjs';
import { sessionFile, transaction } from '../lib/store.mjs';
const from = 'codex:11111111-1111-4111-8111-111111111111';
const to = 'claude:22222222-2222-4222-8222-222222222222';
const root = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-recovery-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const msg = (overrides = {}) => ({ id: randomUUID(), from, to, kind: 'assignment', task: 'recovery', revision: 'abc123', summary: 'A task', ...overrides });
const age = (p, at) => transaction(path.join(p, '.wire/wire.json'), state => { for (const m of state.messages) m.createdAt = at; return state; });

test('orphan reap requires old assignment, absent sender lease and absent recent sender event', t => {
  const now = new Date();
  for (const guard of ['none', 'young', 'boundary', 'lease', 'event']) {
    const p = root(t), m = enqueue(p, msg());
    age(p, new Date(now.getTime() - (guard === 'young' ? 1000 : guard === 'boundary' ? 86400000 : 86400001)).toISOString());
    if (guard === 'lease') leaseAcquire(p, 'sender', from, [], 60000);
    if (guard === 'event') transaction(sessionFile(p, ...from.split(':')), () => ({events:[{at:now.toISOString()}]}));
    if (guard === 'none') {
      leaseAcquire(p, 'recipient', to, [], 60000);
      assert.equal(wireHealth(p, now).archivableOrphanedAssignments, 1);
      const result = archive(p, now);
      assert.deepEqual(result.orphaned, [m.envelope.id]);
      const saved = JSON.parse(fs.readFileSync(path.join(p, result.archive)));
      assert.equal(saved.messages[0].work, 'orphaned');
      assert.equal(saved.messages[0].archive.disposition, 'orphaned');
      assert.equal(saved.messages[0].hash, m.hash);
    } else {
      assert.equal(wireHealth(p, now).archivableOrphanedAssignments, 0);
      assert.equal(archive(p, now).retained, 1);
    }
  }
});

test('recent recipient event does not protect an abandoned sender assignment', t => {
  const p = root(t), now = new Date(); enqueue(p, msg());
  age(p, new Date(now.getTime() - 86400001).toISOString());
  transaction(sessionFile(p, ...to.split(':')), () => ({ events: [{ at: now.toISOString() }] }));
  assert.equal(archive(p, now).orphaned.length, 1);
});

import { operatorCancel, get, status, receive, WIRE_CAPACITY } from '../lib/wire-store.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../bin/the-wire.mjs', import.meta.url));
test('operator cancellation works at capacity, audits reason and retries without duplicates', t => {
  const p = root(t), m = enqueue(p, msg());
  for(let i=1;i<WIRE_CAPACITY;i++) enqueue(p, msg({kind:'notice'}));
  const r = spawnSync(process.execPath, [cli, 'cancel', '--root', p, '--id', m.envelope.id, '--operator', 'carlos', '--reason', 'Sender session ended'], {encoding:'utf8', windowsHide:true});
  assert.equal(r.status, 0, r.stderr);
  const cancelled = JSON.parse(r.stdout);
  assert.equal(cancelled.status.operator, 'carlos');
  assert.equal(cancelled.status.reason, 'Sender session ended');
  assert.equal(cancelled.work, 'cancelled');
  assert.equal(wireHealth(p).used, WIRE_CAPACITY);
  const log = fs.readFileSync(path.join(p, '.wire/operator.log'), 'utf8');
  assert.equal(JSON.parse(log).operationId, cancelled.status.operationId);
  operatorCancel(p, m.envelope.id, 'carlos', 'Sender session ended');
  assert.equal(fs.readFileSync(path.join(p, '.wire/operator.log'), 'utf8'), log);
  receive(p, m.envelope.id, to, m.hash);
  assert.throws(() => status(p, m.envelope.id, to, 'working', 'abc123', 'late'), /closed/);
});
test('operator cancel guards live sender, invalid operator/reason, terminal states and audit failure', t => {
  const p = root(t), m = enqueue(p, msg());
  for (const [op, reason] of [['peer','exited'], ['carlos',' '], ['carlos','password=unsafe']]) assert.throws(() => operatorCancel(p,m.envelope.id,op,reason));
  leaseAcquire(p,'sender',from,[],60000);
  assert.throws(() => operatorCancel(p,m.envelope.id,'carlos','exited'), /live lease/);
  assert.equal(get(p,m.envelope.id).work,'queued');
  assert.equal(fs.existsSync(path.join(p,'.wire/operator.log')),false);
  const q=root(t), n=enqueue(q,msg());
  fs.mkdirSync(path.join(q,'.wire/operator.log'));
  assert.throws(() => operatorCancel(q,n.envelope.id,'carlos','exited'));
  assert.equal(get(q,n.envelope.id).work,'queued');
  const r=root(t), o=enqueue(r,msg());
  operatorCancel(r,o.envelope.id,'carlos','exited');
  assert.throws(() => operatorCancel(r,o.envelope.id,'carlos','different'), /closed/);
});

import { list, pull, cursorRead } from '../lib/wire-store.mjs';
test('rolling archive partitions mixed work, preserves cursors, hashes and ID deduplication', t => {
  const p=root(t), open=enqueue(p,msg());
  const done=enqueue(p,msg({kind:'notice'})); receive(p,done.envelope.id,to,done.hash);
  const pending=enqueue(p,msg({kind:'notice'}));
  const before=cursorRead(p,to);
  const r=archive(p);
  assert.equal(r.messages,1); assert.equal(r.retained,2);
  assert.deepEqual(list(p).map(m=>m.envelope.id),[open.envelope.id,pending.envelope.id]);
  assert.deepEqual(cursorRead(p,to),before);
  assert.equal(get(p,done.envelope.id).hash,done.hash);
  assert.equal(enqueue(p,done.envelope).hash,done.hash);
  assert.equal(list(p).length,2);
  assert.throws(()=>enqueue(p,{...done.envelope,summary:'changed'}),/reused/);
  assert.equal(pull(p,to).at(-1).seq,pending.seq);
  assert.equal(enqueue(p,msg({kind:'notice'})).seq,pending.seq+1);
});
test('send archives at ninety percent and leaves open assignment intact', t => {
  const p=root(t), open=enqueue(p,msg());
  for(let i=1;i<Math.ceil(WIRE_CAPACITY*0.9);i++) {const m=enqueue(p,msg({kind:'notice'}));receive(p,m.envelope.id,to,m.hash);}
  assert.equal(wireHealth(p).used,Math.ceil(WIRE_CAPACITY*0.9));
  const sent=enqueue(p,msg({kind:'notice'}));
  assert.equal(wireHealth(p).used,2);
  assert.equal(get(p,open.envelope.id).work,'queued');
  assert.equal(sent.seq,Math.ceil(WIRE_CAPACITY*0.9)+1);
});
test('archive write failure never removes live messages', t => {
  const p=root(t), m=enqueue(p,msg({kind:'notice'}));receive(p,m.envelope.id,to,m.hash);
  fs.writeFileSync(path.join(p,'.wire/archive'),'not a directory');
  assert.throws(()=>archive(p));
  assert.equal(list(p)[0].hash,m.hash);
});
