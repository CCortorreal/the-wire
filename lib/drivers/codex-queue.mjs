// codex-queue.mjs — wake a Codex thread with `codex queue --thread <uuid> --message <text>`.
//
// Exit 0 plus a queued-message id for the exact target proves ACCEPTANCE by the Codex CLI, not
// that the thread has read it. Prefer a native executable on PATH. If Windows exposes only an npm
// .cmd shim, run the package's codex.js under the current node. Override either route with
// THE_WIRE_CODEX_BIN=<absolute path to a codex executable or codex.js>.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidCapture = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const acceptedLine = new RegExp(`^Queued message ${uuidCapture} for thread ${uuidCapture}\\.?$`, 'i');

function realFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export function codexBin(env = process.env, opts = {}) {
  const platform = opts.platform || process.platform;
  const isFile = opts.isFile || realFile;
  const override = env.THE_WIRE_CODEX_BIN;
  if (override) return override.endsWith('.js') || override.endsWith('.mjs') ? { cmd: process.execPath, args: [override] } : { cmd: override, args: [] };

  if (platform === 'win32') {
    // Modern Codex Desktop publishes a native codex.exe. Prefer it over an older npm shim.
    const dirs = (env.Path || env.PATH || '').split(';').filter(Boolean);
    for (const dir of dirs) {
      for (const name of ['codex.exe', 'codex.com']) {
        const executable = path.win32.join(dir.replace(/^"|"$/g, ''), name);
        if (isFile(executable)) return { cmd: executable, args: [] };
      }
    }

    // npm's .cmd shim cannot be spawned with shell:false. Use its JS entrypoint when it is a
    // real readable file. accessSync is insufficient in sandboxes: it can succeed for a path
    // whose stat/execute is denied.
    const roots = [env.APPDATA && path.join(env.APPDATA, 'npm'), env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs')].filter(Boolean);
    for (const npmDir of roots) {
      const js = path.join(npmDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (isFile(js)) return { cmd: process.execPath, args: [js] };
    }
  }
  return { cmd: 'codex', args: [] };
}

const runOptions = { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true, shell: false };

export function probeCodex(opts = {}) {
  const run = opts.run || spawnSync;
  const bin = codexBin(opts.env || process.env, opts);
  const call = args => {
    try { return run(bin.cmd, [...bin.args, ...args], runOptions); }
    catch { return { status: null, stdout: '', stderr: '' }; }
  };
  const versionResult = call(['--version']);
  const helpResult = call(['queue', '--help']);
  const version = versionResult.status === 0 ? (versionResult.stdout || versionResult.stderr || '').trim().split(/\r?\n/)[0] || null : null;
  const help = helpResult.status === 0 ? `${helpResult.stdout || ''}\n${helpResult.stderr || ''}` : '';
  return {
    resolved: `${bin.cmd} ${bin.args.join(' ')}`.trim(),
    version,
    queueSupported: helpResult.status === 0 && /(?:^|\s)--thread(?:\s|$)/.test(help) && /(?:^|\s)--message(?:\s|$)/.test(help),
  };
}

export function parseQueueAcceptance(stdout, taskId) {
  if (!uuid.test(taskId) || typeof stdout !== 'string') return null;
  for (const line of stdout.trim().split(/\r?\n/)) {
    const match = acceptedLine.exec(line.trim());
    if (match && match[2].toLowerCase() === taskId.toLowerCase()) return match[1].toLowerCase();
  }
  return null;
}

export function wake(taskId, body, opts = {}) {
  const run = opts.run || spawnSync;
  if (!uuid.test(taskId)) return { delivered: false, transportId: null };
  try {
    const bin = codexBin(opts.env || process.env, opts);
    const result = run(bin.cmd, [...bin.args, 'queue', '--thread', taskId, '--message', body], {
      ...runOptions,
    });
    const transportId = parseQueueAcceptance(result.stdout || '', taskId);
    if (!result.error && result.status === 0 && transportId)
      return { delivered: true, transportId };
    return { delivered: false, transportId: null };
  } catch {
    return { delivered: false, transportId: null };
  }
}
