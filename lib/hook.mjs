#!/usr/bin/env node
// hook.mjs — the host-side pull. Wire it to a prompt-submit lifecycle event:
//   Claude Code (settings.json → hooks.UserPromptSubmit):
//     node <repo>/lib/hook.mjs --root <shared-root> --provider claude
//   Codex (hooks.json → UserPromptSubmit):
//     node <repo>/lib/hook.mjs --root <shared-root> --provider codex
// On every prompt it: acquires/renews this session's mailbox lease (named after the provider),
// records receipt of a WIRE-V1 envelope on the prompt's first line, pulls new inbox messages, and
// returns a curated inbox summary as additional context. It never sends anything.
import fs from 'node:fs';
import path from 'node:path';
import { endpoint, observePrompt, pull, list, context, leaseAcquire, leaseResolve } from './wire-store.mjs';

const LEASE_MS = 30 * 60 * 1000;
const args = process.argv.slice(2);
const flag = k => args[args.indexOf('--' + k) + 1];
try {
  if (!args.includes('--root') || !args.includes('--provider')) throw Error('Usage: hook.mjs --root <path> --provider claude|codex');
  const root = fs.realpathSync(flag('root'));
  const raw = fs.readFileSync(0); if (raw.length > 1024 * 1024) throw Error('Oversized event');
  const input = JSON.parse(raw.toString('utf8'));
  // Only sessions working inside the shared root participate.
  if (input.cwd) {
    const relative = path.relative(root, fs.realpathSync(input.cwd));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) process.exit(0);
  }
  const event = input.hook_event_name || input.event || 'UserPromptSubmit';
  if (event !== 'UserPromptSubmit') process.exit(0);
  const provider = flag('provider');
  const actor = endpoint(`${provider}:${input.session_id}`);
  try { leaseAcquire(root, provider, actor, ['pull', 'context'], LEASE_MS); } catch { /* held by another live session of this provider; still pull our own inbox */ }
  observePrompt(root, actor, input.prompt);
  const delta = pull(root, actor);
  let text = context(root, actor, delta);
  const actionable = list(root, actor).filter(m => m.envelope.to === actor && m.work === 'received' && m.envelope.kind === 'assignment');
  if (actionable.length) text = `ACTION PENDING: ${actionable.length} assignment(s) awaiting action — ${actionable.map(m => `${m.envelope.id} (${m.envelope.task})`).join('; ')}\n${text}`;
  if (delta.length) text += `\n[NEW this pull: ${delta.map(m => m.envelope.id).join(', ')}]`;
  if (leaseResolve(root, provider) !== actor) text += `\n(note: mailbox "${provider}" is leased to another session; peers addressing "${provider}" reach that session, not this one)`;
  console.log(JSON.stringify(text ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } : {}));
} catch {
  console.log(JSON.stringify({ systemMessage: 'the-wire inbox unavailable; use `the-wire list` before claiming delivery.' }));
  process.exitCode = 1;
}
