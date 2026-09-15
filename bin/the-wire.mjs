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
import { PROVIDERS, endpoint, enqueue, get, list, receive, status, leaseAcquire, leaseRenew, leaseRelease, leaseResolve, leaseList, wireHealth, archive, pull } from '../lib/wire-store.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { discover as discoverClaude } from '../lib/drivers/claude-pipe.mjs';
import { probeCodex } from '../lib/drivers/codex-queue.mjs';
import { sweep, acquireLock, releaseLock } from '../lib/steward.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEASE_MS = 30 * 60 * 1000;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAGS = /^--(root|id|as|hash|state|revision|from|to|kind|task|summary|summary-stdin|supersedes|mailbox|ttl|fence|provider|references|json)$/;
const USAGE = `the-wire <verb> --root <shared-root> [flags]

  doctor    [--provider claude|codex]       check provider capabilities and the state dir
  discover                                 list live Claude sessions and this Codex session id when exposed
  install   --provider claude|codex        copy the skill into your provider's skill dir; print the hook snippet
  lease     acquire|renew|release|list     --mailbox <name> --as <provider:uuid> [--ttl ms] [--fence n]
  send      --from <mailbox|endpoint> --to <mailbox|endpoint> --kind assignment|notice --task <id>
            --summary "<text>" | --summary-stdin  [--revision <rev>] [--supersedes <id>] [--references a,b]
  enqueue   (JSON envelope on stdin)       lower-level: store without dispatching
  dispatch  --id <uuid> --as <endpoint>    one durable transport attempt
  inbox     --as <endpoint>                pull new messages for this exact session (marks them received)
  list      [--as <endpoint>]              every message (or just this endpoint's)
  read      --id <uuid>
  receive   --id <uuid> --as <endpoint> --hash <sha256>
  status    --id <uuid> --as <endpoint> --state working|blocked|completed|cancelled --revision <rev>
            ({"summary":"...","references":[...]} on stdin)
  health
  archive
  steward                                  one background sweep (dispatch pending, re-wake unconfirmed)

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
    if (value.includes(':')) return endpoint(value);
    const resolved = leaseResolve(root, value);
    if (!resolved) throw Error(`No live lease for mailbox "${value}". The ${value} session must run: the-wire lease acquire --mailbox ${value} --as ${value}:<its session uuid>`);
    return resolved;
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
      fs.copyFileSync(path.join(REPO, 'skills', 'the-wire', 'SKILL.md'), path.join(skillDir, 'SKILL.md'));
      const hookCmd = `node "${path.join(REPO, 'lib', 'hook.mjs').split(path.sep).join('/')}" --root "${root.split(path.sep).join('/')}" --provider ${provider}`;
      const snippet = provider === 'claude'
        ? { file: path.join(home, '.claude', 'settings.json'), merge: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd }] }] } } }
        : { file: path.join(home, '.codex', 'hooks.json'), merge: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd }] }] } } };
      result = { installedSkill: skillDir, hook: snippet, next: 'the-wire does NOT edit your settings. Show the hook snippet to your user and ask them to merge it (or to approve you doing so), then restart the session so the hook loads. Verify with a canary (BOOTSTRAP.md step 5).' };
      break;
    }
    case 'lease': {
      const [op] = positional;
      const box = flags['--mailbox'], as = flags['--as'], ttl = flags['--ttl'] ? Number(flags['--ttl']) : LEASE_MS, fence = flags['--fence'] ? Number(flags['--fence']) : undefined;
      if (op === 'list') { result = leaseList(root); break; }
      if (!box) throw Error('--mailbox required');
      if (op === 'acquire') result = leaseAcquire(root, box, endpoint(as), ['pull', 'context'], ttl);
      else if (op === 'renew') { if (!fence) throw Error('--fence required'); result = leaseRenew(root, box, fence, ttl); }
      else if (op === 'release') { if (!fence) throw Error('--fence required'); result = leaseRelease(root, box, fence); }
      else throw Error('lease acquire|renew|release|list');
      break;
    }
    case 'send': {
      const from = resolveAddress(flags['--from'], '--from'), to = resolveAddress(flags['--to'], '--to');
      if (!['assignment', 'notice'].includes(flags['--kind'])) throw Error('--kind assignment|notice required');
      if (!flags['--task']) throw Error('--task <id> required');
      if (flags['--summary'] && flags['--summary-stdin']) throw Error('--summary and --summary-stdin are mutually exclusive');
      let summary = flags['--summary'] || '';
      if (flags['--summary-stdin']) summary = fs.readFileSync(0, 'utf8').replace(/^﻿/, '').trim();
      if (!summary) throw Error('--summary "<text>" or --summary-stdin required');
      const id = randomUUID();
      const env = { id, from, to, kind: flags['--kind'], task: flags['--task'], revision: flags['--revision'] || gitRevision(), summary: `WIRE-ID: ${id}. ${summary}`, references: flags['--references'] ? flags['--references'].split(',') : [] };
      if (flags['--supersedes']) env.supersedes = flags['--supersedes'];
      const enqueued = enqueue(root, env);
      let dispatched = null; try { dispatched = dispatch(root, id, from); } catch {}
      result = { enqueued, dispatched, meaning: dispatched?.delivery === 'accepted' ? 'Transport accepted the message. That is not receipt; check `read --id` for delivery=received.' : 'Transport did not confirm. The message is stored; the recipient pulls it on its next prompt (if its hook is installed) or a steward sweep re-wakes it.' };
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
    case 'health': result = wireHealth(root); break;
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
