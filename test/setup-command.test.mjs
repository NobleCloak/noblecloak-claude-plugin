/** commands/noblecloak-setup.md: front-matter, and its executable steps are only scripts/setup.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers.mjs';

const body = readFileSync(join(REPO_ROOT, 'commands', 'noblecloak-setup.md'), 'utf-8');
const lines = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n').map((l) => l.trim()).filter(Boolean));

test('front-matter names the command', () => {
  assert.match(body, /^---\nname: noblecloak-setup\ndescription: .+\n---\n/);
});

test('every bash line runs scripts/setup.mjs, and the token never appears on a command line', () => {
  assert.ok(lines.length >= 3);
  for (const line of lines) {
    assert.match(line, /^node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/setup\.mjs( propose --plan <plan\.json>( --dry-run)?| service-principal)?$/);
    assert.doesNotMatch(line, /NC_TOKEN|NC_PROPOSER_TOKEN|Bearer/);
  }
});

test('the body forbids writing NC_TOKEN and keeps the token off disk and argv', () => {
  assert.match(body, /Never write `NC_TOKEN`/);
  assert.match(body, /environment only/);
});
