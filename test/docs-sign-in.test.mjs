/**
 * The README and the governance-hook doc describe the sign-in organization
 * choice (made on the consent page) and no longer mention connection registration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './helpers.mjs';

const DOCS = ['README.md', 'docs/governance-hook.md'];

for (const file of DOCS) {
  const text = readFileSync(join(REPO_ROOT, file), 'utf-8');

  test(`${file}: no connection-registration text and no "no org picker"`, () => {
    assert.doesNotMatch(text, /connection registration/i);
    assert.doesNotMatch(text, /\/mcp\/connections/);
    assert.doesNotMatch(text, /NOBLECLOAK_API_URL/);
    assert.doesNotMatch(text, /no org picker/i);
    assert.doesNotMatch(text, /default-org (selection|path)|whichever organization was default|(current|changed) default org|default org changed/i);
  });

  test(`${file}: says the org was chosen on the consent page and the MCP connection needs a reconnect`, () => {
    assert.match(text, /chosen on the consent page/);
    assert.match(text, /Make this my default organization/);
    assert.match(text, /holds its own token, so reconnect it from `\/mcp`/);
    assert.match(text, /pick the same organization on its consent page/);
  });
}

const SHIPPED_TEXT = [
  'skills/noblecloak-help/SKILL.md',
  'commands/noblecloak-status.md',
  'agents/noblecloak-assistant.md',
];

for (const file of SHIPPED_TEXT) {
  test(`${file}: does not claim the org is picked invisibly or that there is no org picker`, () => {
    const text = readFileSync(join(REPO_ROOT, file), 'utf-8');
    assert.doesNotMatch(text, /invisibly/i);
    assert.doesNotMatch(text, /no org picker/i);
    assert.doesNotMatch(text, /switch (your |the )?default org/i);
    assert.doesNotMatch(text, /change (your |the )?default org/i);
    assert.doesNotMatch(text, /default-org (selection|path)|whichever organization was default|(current|changed) default org|default org changed/i);
    assert.match(text, /consent page/);
  });
}
