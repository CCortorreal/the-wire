// codex-queue.mjs — wake a Codex thread with `codex queue --thread <uuid> --message <text>`.
//
// Exit 0 plus a queued-message id proves ACCEPTANCE by the Codex CLI, not that the thread has
// read it. On Windows the `codex` on PATH is an npm .cmd shim that cannot be spawned without a
// shell, so we prefer running the package's codex.js under the current node. Override with
// THE_WIRE_CODEX_BIN=<absolute path to a codex executable or codex.js>.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function codexBin(env = process.env) {
  const override = env.THE_WIRE_CODEX_BIN;
  if (override) return override.endsWith('.js') || override.endsWith('.mjs') ? { cmd: process.execPath, args: [override] } : { cmd: override, args: [] };
  if (process.platform === 'win32') {
    const roots = [env.APPDATA && path.join(env.APPDATA, 'npm'), env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs')].filter(Boolean);
    for (const npmDir of roots) {
      const js = path.join(npmDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      try { fs.accessSync(js); return { cmd: process.execPath, args: [js] }; } catch {}
    }
  }
  return { cmd: 'codex', args: [] };
}

export function wake(taskId, body, opts = {}) {
  const run = opts.run || spawnSync;
  if (!uuid.test(taskId)) return { delivered: false, transportId: null };
  try {
    const bin = codexBin();
    const result = run(bin.cmd, [...bin.args, 'queue', '--thread', taskId, '--message', body], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true, shell: false,
    });
    const out = (result.stdout || '').trim();
    // Observed format (codex-cli 2026.09): "Queued message <uuid> for thread <uuid>." — matched
    // loosely so a wording change does not silently turn every send into "unconfirmed".
    const match = /Queued message ([0-9a-f-]{36}) for thread ([0-9a-f-]{36})/i.exec(out);
    if (!result.error && result.status === 0 && match && match[2].toLowerCase() === taskId)
      return { delivered: true, transportId: match[1].toLowerCase() };
    return { delivered: false, transportId: null };
  } catch {
    return { delivered: false, transportId: null };
  }
}
