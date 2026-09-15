// lease-renew.mjs — renew a mailbox lease this endpoint already holds. Never acquires, never
// touches a lease held by someone else. For Stop/PreCompact-style hooks that fire mid-turn so a
// long turn cannot outlive the lease acquired at prompt time.
import fs from 'node:fs';
import path from 'node:path';
import { leaseResolve, leaseRenew } from './wire-store.mjs';
import { stateDir } from './store.mjs';

export function renewIfHeld(root, box, actor, ttlMs) {
  if (leaseResolve(root, box) !== actor) return null;
  const leases = JSON.parse(fs.readFileSync(path.join(stateDir(root), 'leases.json'), 'utf8'));
  const fence = leases.mailboxes?.[box]?.fence;
  if (!fence) return null;
  return leaseRenew(root, box, fence, ttlMs);
}
