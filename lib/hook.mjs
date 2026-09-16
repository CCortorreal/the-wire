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
import { endpoint, observePrompt, pull, list, context, wireHealth, leaseAcquire, leaseResolve, leaseRenewEndpoint } from './wire-store.mjs';

const LEASE_MS = 30 * 60 * 1000;
const args = process.argv.slice(2);
const flag = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
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
  const extraMailbox = flag('mailbox');
  if (extraMailbox) {
    try { leaseAcquire(root, extraMailbox, actor, ['pull', 'context'], LEASE_MS); } catch {}
  }
  let ownsBare = false;
  try { leaseAcquire(root, provider, actor, ['pull', 'context'], LEASE_MS); ownsBare = true; } catch {}
  let renewed = [];
  try { renewed = leaseRenewEndpoint(root, actor, LEASE_MS) || []; } catch {}
  // If bare mailbox is taken and this session holds no mailbox at all, auto-acquire a scoped name
  if (!ownsBare && !renewed.length) {
    for (const len of [4, 8, 12, 36]) {
      const slug = input.session_id.slice(0, len);
      const name = `${provider}.${slug}`;
      try { leaseAcquire(root, name, actor, ['pull', 'context'], LEASE_MS); renewed.push(name); break; } catch {}
    }
  }
  const noMailbox = !ownsBare && !renewed.length;
  observePrompt(root, actor, input.prompt);
  const delta = pull(root, actor);
  const actionable = list(root, actor).filter(m => m.envelope.to === actor && m.work === 'received' && m.envelope.kind === 'assignment');
  // Quiet when nothing changed: no new envelope this pull and no assignment still awaiting action.
  // Re-injecting the same completed notices on every prompt spends the host's context for nothing;
  // a message is surfaced on the pull that first sees it, and `the-wire list` has the full state.
  const noMailboxWarning = noMailbox ? `\n⚠ This session holds no mailbox — bare "${provider}" is taken and all scoped names are occupied. Peers cannot address this session by name; use the full endpoint ${actor}. Run \`the-wire lease list\` to see who holds what.` : '';
  if (!delta.length && !actionable.length && !noMailbox) { console.log('{}'); process.exit(0); }
  let text = context(root, actor, delta);
  if (actionable.length) text = `ACTION PENDING: ${actionable.length} assignment(s) awaiting action — ${actionable.map(m => `${m.envelope.id} (${m.envelope.task})`).join('; ')}\n${text}`;
  if (delta.length) text += `\n[NEW this pull: ${delta.map(m => m.envelope.id).join(', ')}]`;
  if (!noMailbox && leaseResolve(root, provider) !== actor) text += `\n(note: mailbox "${provider}" is leased to another session; peers addressing "${provider}" reach that session, not this one)`;
  text += noMailboxWarning;
  try { const h = wireHealth(root); if (h.remaining <= 20) text += `\n⚠ Wire capacity: ${h.used}/${h.capacity} (${h.remaining} remaining). Run \`the-wire archive\` when all assignments are complete.`; } catch {}
  console.log(JSON.stringify(text ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } : {}));
} catch {
  console.log(JSON.stringify({ systemMessage: 'the-wire inbox unavailable; use `the-wire list` before claiming delivery.' }));
  process.exitCode = 1;
}
