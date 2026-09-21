// Wire grammar canaries (session review 2026-09-21, proposal-v2 item 1). Each case replays a real
// envelope from the 2026-09-15..21 ledger, quoted from .wire/wire.json, or a near miss the rule must
// let through. The structured fields (--done-state / --notice-reason) are the proof; the regex is
// only the detector for a notice that reads like an ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { leaseAcquire, get } from '../lib/wire-store.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'bin', 'the-wire.mjs');
const claude = 'claude:aaaaaaaa-1111-4111-8111-111111111111';
const codexA = 'codex:bbbbbbbb-2222-4222-8222-222222222222';
const codexB = 'codex:cccccccc-3333-4333-8333-333333333333';
const root = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'the-wire-grammar-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const run = (p, args, stdin) => spawnSync(process.execPath, [CLI, ...args, '--root', p], { encoding: 'utf8', input: stdin, windowsHide: true });
const send = (p, kind, task, summary, extra = []) => run(p, ['send', '--from', claude, '--to', codexA, '--kind', kind, '--task', task, '--revision', 'abc1234', '--summary', summary, ...extra]);

// real: 2026-09-20 05:04 UTC, work split sent as a notice (codex-on-claude F1, reconciliation C1)
const N_807f213f = "Carlos set a NIGHT research/ideation loop (he's asleep; Shorts auto-post 9am). Scope: EXPLORATORY ONLY - no deploy, no publish, no locked decisions, no push. Proposed split - CODEX (your adversarial+grounded strength): (1) stress-test our economy for velocity-collapse + faucet/sink exploit vectors at 10/20/40 active players; (2) enumerate contract-design failure modes; (3) if feasible, a grounded survey of how real small Towny/SMP economies actually fail. CLAUDE (me): generative contract archetypes. Bank findings your side; drop a notice when you have a chunk and I'll fold it. No deliverable lock.";
// real: 2026-09-20 15:47 UTC, two questions + "Confirm you're up" sent as a notice
const N_b93a8ad0 = "Ping from the Minecraft Claude seat — Carlos is awake and has given a DEPLOY GO across anything built. RedwoodBoard 1.3 is the live question. Two questions: (1) is the 1.3 migration a SAFE auto-migrate from live 1.2.0 data, or does it need a manual step? (2) are both lane branches deploy-ready to merge, and where's the union-rep build? If you're live and want the execution, say so — git push + the actual restart stay Carlos-gated. Confirm you're up.";
// real: 2026-09-16 18:56 UTC, "Please lease codex.minecraft" sent as a notice to the bare mailbox (C5)
const N_59162a8a = "Multi-session routing: I've leased claude.minecraft for this Calliope Minecraft session. Please lease codex.minecraft for yours: the-wire lease acquire --root <root> --mailbox codex.minecraft --as codex:<your-uuid>. Then address me as claude.minecraft going forward.";
// real: 2026-09-16 22:20 UTC, a proper assignment (passes with a done-state)
const A_b438bbab = "Review v4 of auto-scoped mailbox addressing your two BLOCK items from v3: (1) exhaustion test now uses empty inbox. (2) FIELD-NOTES note 17 qualified. 62/62 pass. Files changed: test/wire.test.mjs, docs/FIELD-NOTES.md. APPROVE or BLOCK.";

test('assignment without --done-state is refused; with it the envelope carries doneState + expectsResponse', t => {
  const p = root(t);
  const r1 = send(p, 'assignment', 'wire-auto-scoped-mailbox-v4', A_b438bbab);
  assert.equal(r1.status, 1); assert.match(r1.stderr, /--done-state/);
  const r2 = send(p, 'assignment', 'wire-auto-scoped-mailbox-v4', A_b438bbab, ['--done-state', 'APPROVE or BLOCK via the-wire status']);
  assert.equal(r2.status, 0, r2.stderr);
  const id = JSON.parse(r2.stdout).enqueued.envelope.id;
  const e = get(p, id).envelope;
  assert.equal(e.doneState, 'APPROVE or BLOCK via the-wire status');
  assert.equal(e.expectsResponse, true);
});

test('real notices that were work are refused as notices (807f213f, b93a8ad0, 59162a8a)', t => {
  const p = root(t);
  for (const [task, text] of [['mc-night-research-2026-09-20', N_807f213f], ['redwood-board-next-evolution', N_b93a8ad0], ['calliope-minecraft-wire', N_59162a8a]]) {
    const r = send(p, 'notice', task, text);
    assert.equal(r.status, 1, `${task} should be refused as a notice`);
    assert.match(r.stderr, /reads like an ask/);
  }
});

test('--notice-reason overrides and is stored on the envelope; expectsResponse is false', t => {
  const p = root(t);
  const r = send(p, 'notice', 'redwood-board-next-evolution', N_b93a8ad0, ['--notice-reason', 'FYI only; Carlos answers in-world']);
  assert.equal(r.status, 0, r.stderr);
  const e = get(p, JSON.parse(r.stdout).enqueued.envelope.id).envelope;
  assert.equal(e.noticeReason, 'FYI only; Carlos answers in-world');
  assert.equal(e.expectsResponse, false);
});

test('near misses pass as notices: quoted question, "no review needed", a plain completion', t => {
  const p = root(t);
  for (const text of [
    'Carlos said "can you review this?" about the loot doc; noting it here, nothing asked of you.',
    'Completed: loot-stack-tuning second read landed at 5b8c8f5. No review needed; the desk merges.',
    'FYI: RedwoodLens 0.7.0 is live since 09:11 UTC per the deploy receipt. Nothing to do.',
  ]) {
    const r = send(p, 'notice', 'fyi-' + Math.random().toString(36).slice(2, 8), text);
    assert.equal(r.status, 0, `${text}\n${r.stderr}`);
  }
});

test('a recipient with a blocked assignment gets resubmit, not a fresh assignment', t => {
  const p = root(t);
  const r1 = send(p, 'assignment', 'task-v1', 'Do the thing', ['--done-state', 'thing done']);
  assert.equal(r1.status, 0, r1.stderr);
  const { envelope: { id }, hash } = JSON.parse(r1.stdout).enqueued;
  const rc = run(p, ['receive', '--id', id, '--as', codexA, '--hash', hash]);
  assert.equal(rc.status, 0, rc.stderr);
  const st = run(p, ['status', '--id', id, '--as', codexA, '--state', 'blocked', '--revision', 'abc1234'], JSON.stringify({ summary: 'blocked: missing input', references: [] }));
  assert.equal(st.status, 0, st.stderr);
  const r2 = send(p, 'assignment', 'task-v1-b', 'Do the thing again', ['--done-state', 'thing done']);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /resubmit --id/);
});

test('bare --to codex is refused when two codex sessions are live; the exact endpoint still works', t => {
  const p = root(t);
  leaseAcquire(p, 'codex', codexA, ['pull'], 60000);
  leaseAcquire(p, 'codex.minecraft', codexB, ['pull'], 60000);
  const r = run(p, ['send', '--from', claude, '--to', 'codex', '--kind', 'notice', '--task', 'routing', '--revision', 'abc1234', '--summary', 'FYI: nothing to do.']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ambiguous: 2 live codex sessions/);
  const ok = run(p, ['send', '--from', claude, '--to', 'codex.minecraft', '--kind', 'notice', '--task', 'routing', '--revision', 'abc1234', '--summary', 'FYI: nothing to do.']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /--to "codex.minecraft" → codex:cccccccc/);
});

test('lease --task-domain stores a domain capability; --domain rides on the assignment envelope', t => {
  const p = root(t);
  const l = run(p, ['lease', 'acquire', '--mailbox', 'codex.minecraft', '--as', codexB, '--task-domain', 'minecraft']);
  assert.equal(l.status, 0, l.stderr);
  assert.ok(JSON.parse(l.stdout).capabilities.includes('domain:minecraft'));
  const r = run(p, ['send', '--from', claude, '--to', codexB, '--kind', 'assignment', '--task', 'athena-resweep', '--revision', 'abc1234', '--summary', 'Resweep the life domains.', '--done-state', 'report in state/', '--domain', 'athena']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(get(p, JSON.parse(r.stdout).enqueued.envelope.id).envelope.domain, 'athena');
  // receive side: the prompt hook prints endpoint · task · kind first and flags the domain mismatch
  const hook = spawnSync(process.execPath, [path.join(REPO, 'lib', 'hook.mjs'), '--root', p, '--provider', 'codex'], { encoding: 'utf8', windowsHide: true, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: codexB.split(':')[1], cwd: p, prompt: 'hello' }) });
  assert.equal(hook.status, 0, hook.stderr);
  const ctx = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^ACTION PENDING: 1 assignment/);
  assert.match(ctx, /WIRE codex:cccccccc[^\n]*domain minecraft\n→ assignment · task athena-resweep \(domain athena\) · from claude:aaaaaaaa[^\n]*done-state: report in state\/ · WRONG-CHAIR/);
});
