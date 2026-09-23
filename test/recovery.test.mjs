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
      assert.throws(() => archive(p, now), /outstanding assignment/);
    }
  }
});

test('recent recipient event does not protect an abandoned sender assignment', t => {
  const p = root(t), now = new Date(); enqueue(p, msg());
  age(p, new Date(now.getTime() - 86400001).toISOString());
  transaction(sessionFile(p, ...to.split(':')), () => ({ events: [{ at: now.toISOString() }] }));
  assert.equal(archive(p, now).orphaned.length, 1);
});
