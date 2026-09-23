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
const WIRE_CAPACITY = 100;
const root = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-recovery-')); fs.mkdirSync(path.join(p,'.wire')); fs.writeFileSync(path.join(p,'.wire/config.json'),JSON.stringify({maxMessages:WIRE_CAPACITY})); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
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

import { operatorCancel, get, status, receive } from '../lib/wire-store.mjs';
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

import { wireConfig, DEFAULT_LIMITS } from '../lib/store.mjs';
const configure = (p, limits) => fs.writeFileSync(path.join(p,'.wire/config.json'),JSON.stringify(limits));
test('absent config uses new defaults and reads legacy envelopes without migration', t => {
  const p=root(t); fs.unlinkSync(path.join(p,'.wire/config.json'));
  assert.deepEqual(wireConfig(p),{maxMessages:500,maxBytes:2097152,maxText:4000,maxStatus:4000});
  const m=enqueue(p,msg({summary:'x'.repeat(4000)}));
  const before=fs.readFileSync(path.join(p,'.wire/wire.json'),'utf8');
  assert.equal(get(p,m.envelope.id).hash,m.hash);
  assert.equal(fs.readFileSync(path.join(p,'.wire/wire.json'),'utf8'),before);
  assert.throws(()=>enqueue(p,msg({kind:'notice',summary:'x'.repeat(4001)})),/4000/);
  receive(p,m.envelope.id,to,m.hash);
  const done=status(p,m.envelope.id,to,'completed','abc123','x'.repeat(4000));
  assert.equal(get(p,done.notice).envelope.summary.endsWith('x'.repeat(4000)),true);
});
test('configured limits enforce message, text, status and byte caps with rollback', t => {
  const p=root(t);configure(p,{maxMessages:2,maxText:20,maxStatus:30});
  const m=enqueue(p,msg());receive(p,m.envelope.id,to,m.hash);
  assert.throws(()=>enqueue(p,msg({kind:'notice',summary:'x'.repeat(21)})),/20/);
  assert.throws(()=>status(p,m.envelope.id,to,'completed','abc123','x'.repeat(31)),/30/);
  status(p,m.envelope.id,to,'blocked','abc123','x'.repeat(30));
  assert.throws(()=>enqueue(p,msg({kind:'notice'})),/capacity/);
  const q=root(t); configure(q,{maxBytes:100});
  assert.throws(()=>enqueue(q,msg()),/capacity/);
  assert.equal(list(q).length,0);
  for(const limits of [{maxMessages:0},{maxText:1.5},{maxStatus:'4000'},{maxBytes:67108865},{typo:4}]) {configure(q,limits);assert.throws(()=>wireConfig(q),/config/);}
});
test('byte threshold triggers compaction and lowering caps keeps old logs readable', t => {
  const p=root(t), m=enqueue(p,msg({kind:'notice',summary:'x'.repeat(4000)}));receive(p,m.envelope.id,to,m.hash);
  const bytes=wireHealth(p).bytes;
  configure(p,{maxBytes:Math.floor(bytes/0.9)});
  const n=enqueue(p,msg({kind:'notice'}));
  assert.deepEqual(list(p).map(m=>m.envelope.id),[n.envelope.id]);
  assert.equal(get(p,m.envelope.id).hash,m.hash);
  configure(p,{maxBytes:100,maxMessages:1,maxText:1});
  assert.equal(get(p,m.envelope.id).hash,m.hash,'archive read is independent of lowered write cap');
  assert.equal(get(p,n.envelope.id).hash,n.hash,'live read is independent of lowered write cap');
});
test('CLI accepts the full configured text budget without charging WIRE-ID metadata', t => {
  const p=root(t);configure(p,{maxText:40});
  const r=spawnSync(process.execPath,[cli,'send','--root',p,'--from',from,'--to',to,'--kind','notice','--task','limit','--summary','x'.repeat(40)],{encoding:'utf8',windowsHide:true,env:{...process.env,USERPROFILE:p,HOME:p}});
  assert.equal(r.status,0,r.stderr);
  assert.ok(JSON.parse(r.stdout).enqueued.envelope.summary.endsWith('x'.repeat(40)));
});

import { who, resolveEndpointPrefix } from '../lib/wire-store.mjs';
test('endpoint prefix collisions report every endpoint and mailbox without enqueueing', t => {
  const p=root(t), a='codex:01a0cef8-1111-4111-8111-111111111111', b='codex:01a0cef9-2222-4222-8222-222222222222';
  leaseAcquire(p,'codex.broker',a,[],60000);leaseAcquire(p,'codex.peer',b,[],60000);
  assert.throws(()=>resolveEndpointPrefix(p,'codex:01a0cef'),e=>e.message.includes(a)&&e.message.includes(b)&&e.message.includes('codex.broker')&&e.message.includes('codex.peer'));
  assert.equal(resolveEndpointPrefix(p,'codex:01a0cef8'),a);
  assert.equal(resolveEndpointPrefix(p,from),from,'full endpoint does not require a directory entry');
  assert.throws(()=>resolveEndpointPrefix(p,'codex:ffffffff'),/No known endpoint/);
  const r=spawnSync(process.execPath,[cli,'send','--root',p,'--from',to,'--to','codex:01a0cef','--kind','notice','--task','prefix','--summary','FYI'],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,1);assert.match(r.stderr,/codex.broker/);assert.match(r.stderr,/codex.peer/);assert.equal(list(p).length,0);
});
test('who shows multiple mailboxes, lease age, recent session events and mailboxless endpoints', t => {
  const p=root(t), lease=leaseAcquire(p,'codex.broker',from,[],60000);leaseAcquire(p,'codex.extra',from,[],60000);
  const at=new Date(Date.parse(lease.heartbeatAt)+1000).toISOString();
  transaction(sessionFile(p,...from.split(':')),()=>({events:[{at}]}));
  enqueue(p,msg());
  const rows=who(p,new Date(Date.parse(lease.acquiredAt)+2000));
  const row=rows.find(r=>r.endpoint===from);
  assert.deepEqual(row.mailboxes.map(b=>b.mailbox),['codex.broker','codex.extra']);
  assert.equal(row.mailboxes[0].leaseAgeMs,2000);assert.equal(row.lastSeen,at);
  assert.deepEqual(rows.find(r=>r.endpoint===to),{endpoint:to,mailboxes:[],lastSeen:null});
  const r=spawnSync(process.execPath,[cli,'who','--root',p],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).sessions.length,2);
});
test('CLI resolves unique prefixes on sender, recipient and reply address to immutable endpoints', t => {
  const p=root(t), reply='claude:33333333-3333-4333-8333-333333333333';
  leaseAcquire(p,'sender',from,[],60000);leaseAcquire(p,'recipient',to,[],60000);leaseAcquire(p,'reply',reply,[],60000);
  const r=spawnSync(process.execPath,[cli,'send','--root',p,'--from','codex:1111','--to','claude:2222','--reply-to','claude:3333','--kind','notice','--task','prefix','--summary','FYI'],{encoding:'utf8',windowsHide:true,env:{...process.env,USERPROFILE:p,HOME:p}});
  assert.equal(r.status,0,r.stderr);
  const e=JSON.parse(r.stdout).enqueued.envelope;assert.equal(e.from,from);assert.equal(e.to,to);assert.equal(e.replyTo,reply);
});

import { beginAttempt, finishAttempt } from '../lib/wire-store.mjs';
test('archived receipts, transport results and status retries stay idempotent and never revive work', t => {
  const p=root(t), m=enqueue(p,msg()), attempt=beginAttempt(p,m.envelope.id,from);
  receive(p,m.envelope.id,to,m.hash);
  const done=status(p,m.envelope.id,to,'completed','abc123','done');
  archive(p);
  assert.equal(receive(p,m.envelope.id,to,m.hash).work,'completed');
  assert.throws(()=>receive(p,m.envelope.id,from,m.hash),/Recipient/);
  assert.throws(()=>receive(p,m.envelope.id,to,'wrong'),/hash/);
  assert.equal(finishAttempt(p,m.envelope.id,attempt.attempt.id,{state:'accepted'}).work,'completed');
  assert.equal(status(p,m.envelope.id,to,'completed','abc123','done').notice,done.notice);
  assert.throws(()=>status(p,m.envelope.id,to,'working','abc123','late'),/closed/);
  assert.equal(list(p).length,1,'only the original return notice stays live');
  age(p,new Date(Date.now()-86400001).toISOString());archive(p);
  const r=spawnSync(process.execPath,[cli,'status','--root',p,'--id',m.envelope.id,'--as',to,'--state','completed','--revision','abc123'],{encoding:'utf8',windowsHide:true,input:JSON.stringify({summary:'done'})});
  assert.equal(r.status,0,r.stderr);assert.equal(list(p).length,0);
});
test('operator cancel retries survive rolling archive without a second audit entry', t => {
  const p=root(t), m=enqueue(p,msg());operatorCancel(p,m.envelope.id,'carlos','ended');archive(p);
  assert.equal(operatorCancel(p,m.envelope.id,'carlos','ended').work,'cancelled');
  assert.equal(fs.readFileSync(path.join(p,'.wire/operator.log'),'utf8').trim().split('\n').length,1);
  assert.equal(list(p).length,0);
});
test('unreadable and malformed session evidence never makes old assignments orphaned', t => {
  for(const contents of ['broken json', '{}', '{"events":[{"at":"invalid"}]}']) {
    const p=root(t), m=enqueue(p,msg());age(p,new Date(Date.now()-86400001).toISOString());
    const record=sessionFile(p,...from.split(':'));fs.mkdirSync(path.dirname(record),{recursive:true});fs.writeFileSync(record,contents);
    assert.equal(archive(p).messages,0);assert.equal(get(p,m.envelope.id).work,'queued');
  }
});
test('configured status budget above the old stdin ceiling is honored by CLI', t => {
  const p=root(t);configure(p,{maxText:20000,maxStatus:20000});
  const m=enqueue(p,msg());receive(p,m.envelope.id,to,m.hash);
  const r=spawnSync(process.execPath,[cli,'status','--root',p,'--id',m.envelope.id,'--as',to,'--state','working','--revision','abc123'],{encoding:'utf8',windowsHide:true,input:JSON.stringify({summary:'x'.repeat(18000)})});
  assert.equal(r.status,0,r.stderr);assert.equal(get(p,m.envelope.id).status.summary.length,18000);
});

test('legacy archives without disposition metadata still recognize late receipts', t => {
  const p=root(t), m=enqueue(p,msg());receive(p,m.envelope.id,to,m.hash);
  status(p,m.envelope.id,to,'completed','abc123','done');
  const result=archive(p), filename=path.join(p,result.archive);
  const legacy=JSON.parse(fs.readFileSync(filename,'utf8'));
  delete legacy.messages[0].archive;fs.writeFileSync(filename,JSON.stringify(legacy));
  assert.equal(get(p,m.envelope.id).archive.legacy,true);
  assert.equal(receive(p,m.envelope.id,to,m.hash).work,'completed');
  assert.equal(list(p).length,1);
});
test('live logs larger than the legacy byte cap read and archive with default limits', t => {
  const p=root(t);fs.unlinkSync(path.join(p,'.wire/config.json'));
  for(let i=0;i<70;i++){const m=enqueue(p,msg({kind:'notice',summary:'x'.repeat(4000)}));receive(p,m.envelope.id,to,m.hash);}
  assert.ok(wireHealth(p).bytes>256*1024);
  const r=archive(p);assert.equal(r.messages,70);assert.equal(list(p).length,0);
  const saved=JSON.parse(fs.readFileSync(path.join(p,r.archive),'utf8'));
  assert.equal(get(p,saved.messages[0].envelope.id).hash,saved.messages[0].hash);
});
