// dispatch.mjs — one durable delivery attempt per message, routed by the recipient's provider.
import { beginAttempt, finishAttempt, notification } from './wire-store.mjs';
import { wake as claudeWake } from './drivers/claude-pipe.mjs';
import { wake as codexWake } from './drivers/codex-queue.mjs';

export function dispatch(root, messageId, actor, run) {
  const m = beginAttempt(root, messageId, actor);
  let outcome = { state: 'unconfirmed' };
  try {
    const [provider, session] = m.envelope.to.split(':');
    const body = notification(m);
    const driverOpts = run ? { run } : {};
    if (provider === 'codex') {
      const result = codexWake(session, body, driverOpts);
      if (result.delivered) outcome = { state: 'accepted', transportId: result.transportId };
    } else {
      const result = claudeWake(session, actor, body, messageId, driverOpts);
      // The Claude pipe closing proves transport completion only, never acceptance.
      if (result.delivered) outcome.transportId = result.transportId;
    }
  } catch {
    // Exception text can carry auth material or the full message; never persist it.
  }
  return finishAttempt(root, messageId, m.attempt.id, outcome);
}
