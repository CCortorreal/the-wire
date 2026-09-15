// The docs are the product: an agent reads BOOTSTRAP.md and runs what it says. So every verb the
// docs mention must exist in the CLI, and the CLI's usage must not advertise a verb the docs
// never explain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = f => fs.readFileSync(path.join(REPO, f), 'utf8');
const cliSource = readText('bin/the-wire.mjs');
const CLI = path.join(REPO, 'bin', 'the-wire.mjs');
const implemented = new Set([...cliSource.matchAll(/case '([a-z-]+)':/g)].map(m => m[1]));
const usageVerbs = [...cliSource.matchAll(/^\s{2}([a-z-]+)\s{2,}/gm)].map(m => m[1]);
const tempRoot = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'the-wire-docs-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const cli = (root, args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('every verb in the usage text is implemented', () => {
  for (const v of usageVerbs) assert.ok(implemented.has(v), `usage advertises "${v}" but no case implements it`);
});
test('every `the-wire <verb>` the docs mention is implemented', () => {
  for (const f of ['README.md', 'BOOTSTRAP.md', 'docs/PROTOCOL.md', 'skills/the-wire/SKILL.md']) {
    // Only code spans and fenced blocks count — prose like "the-wire protocol" is not a command.
    const code = [...readText(f).matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map(m => m[0]).join('\n');
    // Command position only: line start, backtick, or after `node `/`bin/` — not a URL segment.
    const verbs = new Set([...code.matchAll(/(?:^|`|\s)(?:node )?(?:bin\/)?the-wire(?:\.mjs)? ([a-z-]+)/gm)].map(m => m[1]));
    for (const v of verbs) assert.ok(implemented.has(v), `${f} mentions "the-wire ${v}" in code which is not a verb`);
  }
});
test('entry files point the agent at BOOTSTRAP.md and carry no private paths', () => {
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    assert.match(readText(f), /BOOTSTRAP\.md/);
    assert.ok(readText(f).split(/\r?\n/).filter(Boolean).length <= 3, `${f} should only route to BOOTSTRAP.md`);
  }
  const all = ['README.md', 'BOOTSTRAP.md', 'CLAUDE.md', 'AGENTS.md', 'docs/PROTOCOL.md', 'docs/FIELD-NOTES.md', 'skills/the-wire/SKILL.md', 'bin/the-wire.mjs', ...fs.readdirSync(path.join(REPO, 'lib')).filter(f => f.endsWith('.mjs')).map(f => 'lib/' + f), ...fs.readdirSync(path.join(REPO, 'lib', 'drivers')).map(f => 'lib/drivers/' + f)];
  for (const f of all) assert.doesNotMatch(readText(f), /Users\/[A-Z][a-z]+\/|[A-Z]:[\\/]Users[\\/]|Desktop[\\/]projects|100\.64\.|CarlosPC|parthenogenesis|continuity\//, `${f} leaks a private path`);
});
test('local broker state is ignored when the repository is the shared root', () => {
  assert.match(readText('.gitignore'), /(?:^|\n)\.wire\/(?:\n|$)/);
});
test('the skill has valid frontmatter with a trigger description', () => {
  const skill = readText('skills/the-wire/SKILL.md');
  const fm = /^---\nname: the-wire\ndescription: (.+)\n---/.exec(skill);
  assert.ok(fm, 'frontmatter must be name + single-line description');
  assert.ok(fm[1].length >= 80 && fm[1].length <= 1024, 'description should carry real triggers and stay under the listing cap');
});
test('install prints provider-native hook merge shapes without editing settings', t => {
  const p = tempRoot(t), home = path.join(p, 'home');
  fs.mkdirSync(home);
  const env = { USERPROFILE: home, HOME: home };
  for (const provider of ['claude', 'codex']) {
    const result = cli(p, ['install', '--provider', provider], env);
    assert.ok(result.hook.merge.hooks.UserPromptSubmit, `${provider} hook needs the top-level hooks object`);
    assert.equal(result.hook.merge.UserPromptSubmit, undefined, `${provider} event must not be emitted at file root`);
    assert.equal(fs.existsSync(result.hook.file), false, 'install prints the merge plan; it does not create settings');
    assert.ok(fs.existsSync(path.join(home, `.${provider}`, 'skills', 'the-wire', 'SKILL.md')));
  }
});
test('discover prefers a validated Codex thread environment variable', t => {
  const p = tempRoot(t), sessionId = '22222222-2222-4222-8222-222222222222';
  const result = cli(p, ['discover'], { USERPROFILE: p, HOME: p, CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: '33333333-3333-4333-8333-333333333333' });
  assert.deepEqual(result.codex, { sessionId, source: 'CODEX_THREAD_ID' });
});
test('doctor validates the requested Codex queue capability, not merely another installed CLI', t => {
  const p = tempRoot(t), stub = path.join(p, 'codex-stub.mjs'), noQueue = path.join(p, 'codex-no-queue.mjs');
  fs.writeFileSync(stub, `const a=process.argv.slice(2); if(a.includes('--version')) console.log('codex-cli test'); else if(a[0]==='queue'&&a[1]==='--help') console.log('Usage: codex queue --thread <THREAD> --message <TEXT>'); else process.exitCode=1;`);
  const result = cli(p, ['doctor', '--provider', 'codex'], { USERPROFILE: p, HOME: p, THE_WIRE_CODEX_BIN: stub });
  assert.equal(result.ok, true);
  assert.equal(result.codex.ready, true);
  assert.equal(result.codex.queueSupported, true);
  fs.writeFileSync(noQueue, `if(process.argv.includes('--version')) console.log('codex-cli test'); else console.log('Usage: codex queue');`);
  const broken = cli(p, ['doctor', '--provider', 'codex'], { USERPROFILE: p, HOME: p, THE_WIRE_CODEX_BIN: noQueue });
  assert.equal(broken.ok, false, 'another installed provider must not mask a broken Codex half');
  assert.equal(broken.codex.queueSupported, false);
});
