// The docs are the product: an agent reads BOOTSTRAP.md and runs what it says. So every verb the
// docs mention must exist in the CLI, and the CLI's usage must not advertise a verb the docs
// never explain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = f => fs.readFileSync(path.join(REPO, f), 'utf8');
const cliSource = readText('bin/the-wire.mjs');
const implemented = new Set([...cliSource.matchAll(/case '([a-z-]+)':/g)].map(m => m[1]));
const usageVerbs = [...cliSource.matchAll(/^\s{2}([a-z-]+)\s{2,}/gm)].map(m => m[1]);

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
  for (const f of ['CLAUDE.md', 'AGENTS.md']) assert.match(readText(f), /BOOTSTRAP\.md/);
  const all = ['README.md', 'BOOTSTRAP.md', 'CLAUDE.md', 'AGENTS.md', 'docs/PROTOCOL.md', 'docs/FIELD-NOTES.md', 'skills/the-wire/SKILL.md', 'bin/the-wire.mjs', ...fs.readdirSync(path.join(REPO, 'lib')).filter(f => f.endsWith('.mjs')).map(f => 'lib/' + f), ...fs.readdirSync(path.join(REPO, 'lib', 'drivers')).map(f => 'lib/drivers/' + f)];
  for (const f of all) assert.doesNotMatch(readText(f), /Users\/[A-Z][a-z]+\/|Desktop\/projects|100\.64\.|parthenogenesis|continuity\//, `${f} leaks a private path`);
});
test('the skill has valid frontmatter with a trigger description', () => {
  const skill = readText('skills/the-wire/SKILL.md');
  const fm = /^---\nname: the-wire\ndescription: (.+)\n---/.exec(skill);
  assert.ok(fm, 'frontmatter must be name + single-line description');
  assert.ok(fm[1].length >= 80 && fm[1].length <= 1024, 'description should carry real triggers and stay under the listing cap');
});
