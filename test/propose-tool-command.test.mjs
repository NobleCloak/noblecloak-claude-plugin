/** commands/noblecloak-propose-tool.md: front-matter, and its only executable step is the propose-tool script. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers.mjs';

const body = readFileSync(join(REPO_ROOT, 'commands', 'noblecloak-propose-tool.md'), 'utf-8');

test('front-matter names the command', () => {
  assert.match(body, /^---\nname: noblecloak-propose-tool\ndescription: .+\n---\n/);
});

test('exactly one bash block, and it runs only scripts/propose-tool.mjs', () => {
  const blocks = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /^node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/propose-tool\.mjs /);
  assert.equal(blocks[0].split('\n').length, 1, 'a single command line');
  // placeholders (<a|b>, [--opt <x>]) legitimately contain | and quotes; strip them first
  const bare = blocks[0].replace(/<[^>]*>/g, 'X').replace(/\"[^\"]*\"/g, 'X');
  assert.doesNotMatch(bare, /[;&|`]|\$\(/, 'no chaining or substitution');
});

test('the body names no catalog/tools write route or tool', () => {
  assert.doesNotMatch(body, /\/v1\/tools|\/catalog|curl |fetch\(/);
});

test('the bash block passes the proposal by --file only: no free-text flag a shell could expand', () => {
  const block = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1].trim())[0];
  assert.match(block, /--file <proposal\.json>$/);
  assert.doesNotMatch(block, /--description|--schema|--tool-ref/);
  assert.doesNotMatch(block, /"/, 'no double-quoted argument');
});

test('policy scope: proposer only, and says --owner does not widen it', () => {
  assert.match(body, /proposing user only[^.]*whichever `owner_kind`/);
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
  assert.match(readme, /proposing user only, even with `--owner org`/);
});

test('the proposal file goes in the OS temp dir under the scratch name, not the working directory', () => {
  assert.match(body, /noblecloak-proposal-<random>\.json/);
  assert.match(body, /temp directory/);
  assert.doesNotMatch(body, /\.local\/proposal\.json/);
});

test('README states the residual same-user token read risk instead of implying 0600 closes it', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
  assert.match(readme, /Residual risk[\s\S]*same user[\s\S]*cannot approve, deny or batch-resolve/);
  const bullet = readme.match(/- \*\*Residual risk[\s\S]*?(?=\n- \*\*|\n\n|$)/)?.[0] ?? '';
  assert.ok(bullet.length > 0, 'the Residual risk bullet exists');
  assert.doesNotMatch(bullet, /self-approve|can approve/, 'D-A84: the superseded self-approve wording is gone');
});
