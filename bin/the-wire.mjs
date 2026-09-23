#!/usr/bin/env node
// the-wire — let your Claude Code and Codex sessions talk to each other.
// Every verb takes --root <shared-root> (the directory both sessions work in; state lives in
// <root>/.wire/). Output is JSON. Exit code 1 on any error, with the reason on stderr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, who, resolveEndpointPrefix, operatorCancel, endpoint, enqueue, enqueueReplace, get, list, receive, status, resubmit as storeResubmit, leaseAcquire, leaseRenew, leaseRelease, leaseResolve, leaseList, leaseRenewEndpoint, leasesByPrefix, activeAssignment, wireHealth, archive, pull } from '../lib/wire-store.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { discover as discoverClaude } from '../lib/drivers/claude-pipe.mjs';
import { probeCodex } from '../lib/drivers/codex-queue.mjs';
import { sweep, acquireLock, releaseLock } from '../lib/steward.mjs';
import { repair } from '../lib/store.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEASE_MS = 30 * 60 * 1000;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAGS = /^--(root|id|as|hash|state|revision|from|to|reply-to|in-reply-to|kind|task|summary|summary-stdin|supersedes|mailbox|ttl|fence|provider|references|json|new-summary|done-state|notice-reason|domain|task-domain|operator|reason)$/;
const USAGE = `the-wire <verb> --root <shared-root> [flags]

  doctor    [--provider claude|codex]       check provider capabilities and the state dir
  discover                                 list live Claude sessions and this Codex session id when exposed
  install   --provider claude|codex        copy the skill into your provider's skill dir; print the hook snippet
  resubmit  --id <uuid> --as <endpoint>   turn a blocked review into a superseding assignment (bumps task version)
  lease     acquire|renew|release|list     --mailbox <name> --as <provider:uuid> [--ttl ms] [--fence n]
  who                                      endpoint directory: mailboxes, lease age and last seen
  roster    [--provider claude|codex]      all active sessions grouped by provider, with their mailbox names
  send      --from <mailbox|endpoint> --to <mailbox|endpoint> --kind assignment|notice --task <id>
            --summary "<text>" | --summary-stdin  [--revision <rev>] [--supersedes <id>|auto] [--reply-to <mailbox|endpoint>] [--in-reply-to <message-id>] [--references a,b]
            assignment: --done-state "<what the recipient reports when done>" (required) [--domain <task-domain>]
            notice:     warns on success when the summary reads like an ask; optional --notice-reason "<why no reply is needed>"
            a bare --to codex|claude is refused when >1 session of that provider is live; the resolution is printed
  lease acquire … [--task-domain <name>]   bind this session to a task domain (assignments for another domain are flagged WRONG-CHAIR)
  enqueue   (JSON envelope on stdin)       lower-level: store without dispatching
  dispatch  --id <uuid> --as <endpoint>    one durable transport attempt
  inbox     --as <endpoint>                pull new messages for this exact session (marks them received)
  list      [--as <endpoint>]              every message (or just this endpoint's)
  read      --id <uuid>
  receive   --id <uuid> --as <endpoint> --hash <sha256>
  status    --id <uuid> --as <endpoint> --state working|blocked|completed|cancelled --revision <rev>
            ({"summary":"...","references":[...]} on stdin)
  cancel    --id <uuid> --operator carlos --reason "<text>"  recover an assignment without a live sender lease
  health
  repair                                   fix stale locks, orphaned temps, restore corrupt state from backup
  archive
  steward                                  one background sweep (dispatch pending, re-wake unconfirmed)

Multi-session: each session can lease a named mailbox (e.g. codex.inflow) via
  lease acquire --mailbox codex.inflow --as codex:<uuid>
The hook auto-renews all mailboxes held by the session. Address a specific session
with --to codex.inflow; --to codex still resolves the bare provider mailbox.
Protocol: docs/PROTOCOL.md. Agent setup: BOOTSTRAP.md.`;

const [verb, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
try {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      if (!FLAGS.test(rest[i]) || flags[rest[i]]) throw Error(`Invalid or repeated flag: ${rest[i]}`);
      if (rest[i] === '--summary-stdin' || rest[i] === '--json') { flags[rest[i]] = true; continue; }
      if (rest[i + 1] === undefined) throw Error(`Missing value for ${rest[i]}`);
      flags[rest[i]] = rest[++i];
    } else positional.push(rest[i]);
  }
  if (!verb || verb === 'help' || verb === '--help') { console.log(USAGE); process.exit(0); }
  if (!flags['--root']) throw Error('Explicit --root <shared-root> required (the directory both sessions work in)');
  const root = path.resolve(flags['--root']);
  const stdinJson = () => { const b = fs.readFileSync(0); if (b.length > 16384) throw Error('Input too large'); return JSON.parse(b.toString('utf8').replace(/^﻿/, '')); };
  const resolveAddress = (value, label) => {
    if (!value) throw Error(`${label} required`);
    if (value.includes(':')) return resolveEndpointPrefix(root, value);
    const resolved = leaseResolve(root, value);
    if (resolved) {
      // Wire grammar (2026-09-21): a bare provider name is refused when more than one session of that
      // provider is live (the 2026-09-16 wrong-mailbox send, wire 59162a8a); the resolution is printed.
      if (PROVIDERS.includes(value)) {
        const live = leasesByPrefix(root, value);
        const endpoints = [...new Set(live.map(a => a.endpoint))];
        if (endpoints.length > 1) throw Error(`${label} "${value}" is ambiguous: ${endpoints.length} live ${value} sessions — ${live.map(a => `${a.mailbox}=${a.endpoint}`).join(', ')}. Address the exact endpoint or the scoped mailbox.`);
      }
      console.error(`the-wire: ${label} "${value}" → ${resolved}`);
      return resolved;
    }
    const prefix = PROVIDERS.find(p => value === p || value.startsWith(p + '.'));
    if (prefix) {
      const available = leasesByPrefix(root, prefix);
      if (available.length) throw Error(`No live lease for mailbox "${value}". Active ${prefix} mailboxes: ${available.map(a => a.mailbox).join(', ')}. Use --to <mailbox> to address a specific session.`);
    }
    throw Error(`No live lease for mailbox "${value}". The ${value} session must run: the-wire lease acquire --mailbox ${value} --as <provider>:<session uuid>`);
  };
  // Does a notice summary read like an ask? Quoted text is stripped first (a quoted question is not an
  // ask to the peer). Returns the reason string, or null. Regex is the detector; the structured
  // --done-state / --notice-reason fields are the proof (Codex review, proposal-review.md A1).
  const noticeReadsLikeAsk = text => {
    const bare = text.replace(/"[^"]*"|“[^”]*”|`[^`]*`|(?:^|\s)'[^']*'(?=[\s.,;:]|$)/g, ' ');
    const patterns = [
      [/\?/, 'a question mark'],
      [/\b(please|can you|could you|would you|need you to|drop (?:me|us)?\s?a (?:notice|line|note)|send me|report back|get back to me|let me know|your call|when you have|once you have)\b/i, 'an ask addressed to the peer'],
      [/\b(proposed split|your (?:side|slice|half|lane|strength|part)|bank (?:findings|notes|results)|(?:need|needs|want|requesting|request|for) (?:a |your )?(?:second[- ]read|blind[- ]spot pass)|verdict requested|findings requested|return a verdict)\b/i, 'a work split or review request'],
      [/\b(review|check|verify|audit|test|confirm|bank)\s+(this|the|my|it|that|these|those|each|all|both)\b/i, 'an imperative to the peer'],
      [/\bdone[- ]state\b/i, 'a done-state'],
    ];
    for (const [re, why] of patterns) { const m = bare.match(re); if (m) return `${why}: "${m[0]}"`; }
    return null;
  };
  const gitRevision = () => { const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.trim() : 'unversioned'; };
  let result;
  switch (verb) {
    case 'doctor': {
      // Windows needs a shell for the .cmd shims; pass one string there so nothing is re-quoted.
      const probe = (cmd, args) => {
        const r = process.platform === 'win32'
          ? spawnSync([cmd, ...args].map(a => /\s/.test(a) ? `"${a}"` : a).join(' '), { encoding: 'utf8', windowsHide: true, shell: true, timeout: 10000 })
          : spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
      };
      const requested = flags['--provider'];
      if (requested && !PROVIDERS.includes(requested)) throw Error('--provider claude|codex required');
      const codex = probeCodex();
      const stateDir = path.join(root, '.wire');
      result = {
        node: process.version, platform: process.platform, root, stateDir, stateDirExists: fs.existsSync(stateDir),
        requestedProvider: requested || null,
        codex: { ...codex, ready: Boolean(codex.version && codex.queueSupported) },
        claude: { version: probe('claude', ['--version']), sessionRegistry: fs.existsSync(path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'sessions')) },
        leases: fs.existsSync(stateDir) ? leaseList(root) : [],
        health: fs.existsSync(path.join(stateDir, 'wire.json')) ? wireHealth(root) : null,
      };
      result.claude.ready = Boolean(result.claude.version);
      result.ok = requested ? result[requested].ready : Boolean(result.codex.ready || result.claude.ready);
      if (result.ok) result.hint = requested ? `${requested} is ready. Next: BOOTSTRAP.md step 2.` : 'At least one provider is ready. Use --provider claude|codex to validate the half you are installing.';
      else if (requested === 'codex') result.hint = 'Codex must answer `--version` and expose `queue --thread ... --message ...`. Fix PATH or set THE_WIRE_CODEX_BIN, then rerun doctor.';
      else if (requested === 'claude') result.hint = 'Claude Code did not answer `--version`. Fix PATH, then rerun doctor.';
      else result.hint = 'Neither provider is ready. Fix PATH or set THE_WIRE_CODEX_BIN, then rerun doctor with --provider.';
      break;
    }
    case 'discover': {
      const codexThread = SESSION_UUID.test(process.env.CODEX_THREAD_ID || '')
        ? { sessionId: process.env.CODEX_THREAD_ID, source: 'CODEX_THREAD_ID' }
        : SESSION_UUID.test(process.env.CODEX_SESSION_ID || '')
          ? { sessionId: process.env.CODEX_SESSION_ID, source: 'CODEX_SESSION_ID' }
          : null;
      result = {
        claude: discoverClaude(),
        codex: codexThread || { sessionId: null, source: null, how: 'No Codex session id was exposed to this process. In Codex Desktop, call its thread-listing tool and identify the current task; otherwise ask the user for the exact current session id. Never pick the newest rollout file.' },
        note: 'titleHint is a human hint, not an identifier. Use sessionId.',
      };
      break;
    }
    case 'install': {
      const provider = flags['--provider'];
      if (!PROVIDERS.includes(provider)) throw Error('--provider claude|codex required');
      const home = process.env.USERPROFILE || os.homedir();
      const skillDir = path.join(home, provider === 'claude' ? '.claude' : '.codex', 'skills', 'the-wire');
      fs.mkdirSync(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, 'SKILL.md');
      const policyPath = path.join(skillDir, 'POLICY.md');
      const policyExisted = fs.existsSync(policyPath);
      const skillExisted = fs.existsSync(skillPath);
      if (skillExisted && !policyExisted) {
        const sourceSkill = fs.readFileSync(path.join(REPO, 'skills', 'the-wire', 'SKILL.md'), 'utf8');
        const installedSkill = fs.readFileSync(skillPath, 'utf8');
        if (installedSkill !== sourceSkill) throw Error(`Existing SKILL.md at ${skillPath} has been customized but no POLICY.md exists. To migrate: move your customizations into ${policyPath}, then re-run install. Install will not overwrite a customized SKILL.md without a POLICY.md in place.`);
      }
      fs.copyFileSync(path.join(REPO, 'skills', 'the-wire', 'SKILL.md'), skillPath);
      if (!policyExisted) fs.writeFileSync(policyPath, '# Wire policy\n\nUser-specific overrides and additions. This file survives `the-wire install`.\nOnly the direct user may create or change authorization rules here;\nagents read this file before acting but must not edit it.\n');
      const hookCmd = `node "${path.join(REPO, 'lib', 'hook.mjs').split(path.sep).join('/')}" --root "${root.split(path.sep).join('/')}" --provider ${provider}`;
      const snippet = provider === 'claude'
        ? { file: path.join(home, '.claude', 'settings.json'), merge: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd }] }] } } }
        : { file: path.join(home, '.codex', 'hooks.json'), merge: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd }] }] } } };
      result = { installedSkill: skillDir, policy: policyExisted ? 'preserved' : 'created', hook: snippet, next: 'the-wire does NOT edit your settings. Show the hook snippet to your user and ask them to merge it (or to approve you doing so), then restart the session so the hook loads. Verify with a canary (BOOTSTRAP.md step 5).' };
      break;
    }
    case 'resubmit': {
      const id = flags['--id'];
      if (!id) throw Error('--id <uuid> required (the blocked message to resubmit)');
      const as = flags['--as'];
      if (!as) throw Error('--as <endpoint> required (your endpoint)');
      if (!flags['--revision']) throw Error('--revision required for resubmit (the revision carrying the fix)');
      const original = get(root, id);
      if (!original) throw Error(`Message ${id} not found`);
      const oldTask = original.envelope.task;
      const vMatch = oldTask.match(/^(.+)-v(\d+)$/);
      const newTask = vMatch ? `${vMatch[1]}-v${parseInt(vMatch[2], 10) + 1}` : `${oldTask}-v2`;
      const newSummary = flags['--new-summary'] || flags['--summary'] || original.envelope.summary.replace(/^WIRE-ID:\s*[0-9a-f-]+\.\s*/, '');
      const newId = randomUUID();
      const env = { id: newId, from: original.envelope.from, to: original.envelope.to, kind: 'assignment', task: newTask, revision: flags['--revision'], summary: `WIRE-ID: ${newId}. ${newSummary}`, references: flags['--references'] ? flags['--references'].split(',') : original.envelope.references || [], replyTo: original.envelope.replyTo };
      const r = storeResubmit(root, id, endpoint(as), env);
      let dispatched = null; try { dispatched = dispatch(root, newId, original.envelope.from); } catch {}
      result = { resubmitted: { originalId: id, originalTask: oldTask, newId, newTask }, enqueued: r.message, dispatched, meaning: dispatched?.delivery === 'accepted' ? 'Transport accepted the resubmission.' : 'Stored; recipient pulls on next prompt.' };
      break;
    }
    case 'lease': {
      const [op] = positional;
      const box = flags['--mailbox'], as = flags['--as'], ttl = flags['--ttl'] ? Number(flags['--ttl']) : LEASE_MS, fence = flags['--fence'] ? Number(flags['--fence']) : undefined;
      if (op === 'list') { result = leaseList(root); break; }
      if (!box) throw Error('--mailbox required');
      // --task-domain <name> binds this lease to a task domain (capability `domain:<name>`); the receive
      // hook flags an assignment carrying a different --domain as WRONG-CHAIR (2026-09-16 case, Codex #3).
      const caps = ['pull', 'context', ...(flags['--task-domain'] ? ['domain:' + flags['--task-domain']] : [])];
      if (op === 'acquire') result = leaseAcquire(root, box, endpoint(as), caps, ttl);
      else if (op === 'renew') { if (!fence) throw Error('--fence required'); result = leaseRenew(root, box, fence, ttl); }
      else if (op === 'release') { if (!fence) throw Error('--fence required'); result = leaseRelease(root, box, fence); }
      else throw Error('lease acquire|renew|release|list');
      break;
    }
    case 'send': {
      let inReplyEnvelope = null;
      if (flags['--in-reply-to']) {
        if (flags['--to']) throw Error('--to and --in-reply-to are mutually exclusive (--in-reply-to routes to the original sender)');
        const original = get(root, flags['--in-reply-to']);
        inReplyEnvelope = original.envelope;
      }
      const from = resolveAddress(flags['--from'], '--from');
      if (inReplyEnvelope && from !== inReplyEnvelope.to) throw Error(`--in-reply-to: only the original recipient (${inReplyEnvelope.to}) can reply; --from is ${from}`);
      const to = inReplyEnvelope ? inReplyEnvelope.from : resolveAddress(flags['--to'], '--to');
      if (!['assignment', 'notice'].includes(flags['--kind'])) throw Error('--kind assignment|notice required');
      if (!flags['--task']) flags['--task'] = inReplyEnvelope?.task;
      if (!flags['--task']) throw Error('--task <id> required');
      if (flags['--summary'] && flags['--summary-stdin']) throw Error('--summary and --summary-stdin are mutually exclusive');
      let summary = flags['--summary'] || '';
      if (flags['--summary-stdin']) summary = fs.readFileSync(0, 'utf8').replace(/^﻿/, '').trim();
      if (!summary) throw Error('--summary "<text>" or --summary-stdin required');
      const id = randomUUID();
      const replyTo = flags['--reply-to'] ? resolveAddress(flags['--reply-to'], '--reply-to') : undefined;
      const revision = flags['--revision'] || (inReplyEnvelope ? inReplyEnvelope.revision : gitRevision());
      const env = { id, from, to, kind: flags['--kind'], task: flags['--task'], revision, summary: `WIRE-ID: ${id}. ${summary}`, references: flags['--references'] ? flags['--references'].split(',') : [], replyTo };
      // ── Wire grammar (2026-09-21 session review, proposal-v2 item 1) ──
      // assignment = work with a done-state → --done-state is required and stored (expectsResponse: true).
      // notice = information; ask-shaped text is advisory, and --notice-reason can record context.
      // Warnings are emitted only after storage succeeds. A blocked recipient gets
      // `resubmit`, never a fresh assignment. Real cases: 807f213f, b93a8ad0 (work sent as notices).
      const warnings = [];
      if (env.kind === 'assignment') {
        if (!flags['--done-state']) throw Error('assignment requires --done-state "<what the recipient reports when done>" — the structured field is the proof it is work, not information');
        env.doneState = flags['--done-state']; env.expectsResponse = true;
        if (flags['--domain']) env.domain = flags['--domain'];
        const active = activeAssignment(root, to);
        if (active && active.work === 'blocked') throw Error(`Recipient has a blocked assignment ${active.envelope.id} (${active.envelope.task}). Do not send a fresh one — the-wire resubmit --id ${active.envelope.id} --as ${from} --revision <rev> --root <root>`);
      } else {
        const ask = noticeReadsLikeAsk(summary);
        if (ask) warnings.push(`notice reads like an ask (${ask}). Notices need no reply; use an assignment with --done-state when you expect work.`);
        if (flags['--notice-reason']) env.noticeReason = flags['--notice-reason'];
        env.expectsResponse = false;
      }
      // A send is not a status update. Surface an unfinished assignment on the
      // same task so the sender can report its outcome instead of leaving stale
      // work behind. This is advisory; a legitimate task message still sends.
      const openIncoming = list(root, from).filter(m => m.envelope.to === from &&
        m.envelope.kind === 'assignment' && m.envelope.task === env.task &&
        !['completed', 'cancelled'].includes(m.work));
      for (const m of openIncoming)
        console.error(`the-wire: open incoming assignment on task ${env.task}: ${m.envelope.id} (state ${m.work}); send does not close it — report with status`);
      let enqueued, replaced = null;
      if (flags['--supersedes'] === 'auto') {
        const r = enqueueReplace(root, env);
        enqueued = r.message; replaced = r.replaced;
      } else {
        if (flags['--supersedes']) env.supersedes = flags['--supersedes'];
        enqueued = enqueue(root, env);
      }
      let dispatched = null; try { dispatched = dispatch(root, id, from); } catch {}
      result = { enqueued, replaced, dispatched, warnings,
        openIncomingAssignments: openIncoming.map(m => ({ id: m.envelope.id, state: m.work })),
        meaning: dispatched?.delivery === 'accepted' ? 'Transport accepted the message. That is not receipt; check `read --id` for delivery=received.' : 'Transport did not confirm. The message is stored; the recipient pulls it on its next prompt (if its hook is installed) or a steward sweep re-wakes it.' };
      for (const warning of warnings) console.error(`the-wire: warning: ${warning}`);
      break;
    }
    case 'enqueue': result = enqueue(root, stdinJson()); break;
    case 'dispatch': result = dispatch(root, flags['--id'], flags['--as']); break;
    case 'inbox': result = pull(root, endpoint(flags['--as'])); break;
    case 'list': result = { messages: list(root, flags['--as']), health: wireHealth(root) }; break;
    case 'read': result = get(root, flags['--id']); break;
    case 'receive': result = receive(root, flags['--id'], flags['--as'], flags['--hash']); break;
    case 'status': {
      const detail = stdinJson();
      result = status(root, flags['--id'], flags['--as'], flags['--state'], flags['--revision'], detail.summary, detail.references);
      if (result.notice) { const n = get(root, result.notice); result.notification = n.delivery === 'pending' ? dispatch(root, result.notice, flags['--as']) : n; }
      break;
    }
    case 'who': result = { sessions: who(root) }; break;
    case 'roster': {
      const requested = flags['--provider'];
      if (requested && !PROVIDERS.includes(requested)) throw Error('--provider claude|codex required');
      const leases = leaseList(root).filter(l => l.status === 'active');
      const allMessages = list(root);
      const prefixes = requested ? [requested] : PROVIDERS;
      const groups = {};
      for (const p of prefixes) {
        const matches = leases.filter(l => l.mailbox === p || l.mailbox.startsWith(p + '.'));
        if (!matches.length) continue;
        const endpoints = [...new Set(matches.map(l => l.endpoint))];
        const sessions = endpoints.map(ep => {
          const boxes = matches.filter(l => l.endpoint === ep);
          const active = allMessages.find(m => m.envelope.kind === 'assignment' && m.envelope.to === ep && !['completed', 'cancelled', 'superseded'].includes(m.work));
          const pending = allMessages.filter(m => m.envelope.to === ep && m.delivery !== 'received' && !['completed', 'cancelled', 'superseded'].includes(m.work)).length;
          const session = {
            endpoint: ep,
            mailboxes: boxes.map(b => b.mailbox),
            remaining: Math.max(0, Math.round((Date.parse(boxes[0].expiresAt) - Date.now()) / 1000)),
          };
          if (active) session.working = { id: active.envelope.id, task: active.envelope.task, work: active.work, age: Math.round((Date.now() - Date.parse(active.createdAt)) / 1000) + 's' };
          if (pending) session.pendingInbox = pending;
          return session;
        });
        groups[p] = sessions;
      }
      result = { providers: groups, total: leases.length };
      break;
    }
    case 'cancel': result = operatorCancel(root, flags['--id'], flags['--operator'], flags['--reason']); break;
    case 'health': result = wireHealth(root); break;
    case 'repair': result = repair(root); break;
    case 'archive': result = archive(root); break;
    case 'steward': {
      if (!acquireLock(root)) { result = { skipped: 'another sweep holds the lock' }; break; }
      try { result = sweep(root); } finally { releaseLock(root); }
      break;
    }
    default: throw Error(`Unknown verb "${verb}".\n\n${USAGE}`);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e instanceof SyntaxError ? 'Invalid JSON on stdin' : e.message);
  process.exitCode = 1;
}
