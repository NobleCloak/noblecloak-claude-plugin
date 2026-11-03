/**
 * First sign-in creates the account: the deployment provisions a user (with a
 * personal workspace) the first time they sign in, so the plugin says so where
 * a new person looks. test/login.test.mjs runs login.mjs and checks that it
 * prints the note before it opens the browser; the command doc and the README
 * Install section carry the same sentence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIRST_SIGN_IN_NOTE } from '../scripts/lib/governance.mjs';
import { REPO_ROOT } from './helpers.mjs';

const read = (...p) => readFileSync(join(REPO_ROOT, ...p), 'utf-8');

test('the note says signing in creates an account with a personal workspace', () => {
  assert.equal(
    FIRST_SIGN_IN_NOTE,
    'If you do not have a NobleCloak account yet, signing in creates one, with a personal workspace.'
  );
});

test('the login command and the README Install section carry the same sentence', () => {
  assert.ok(read('commands', 'noblecloak-login.md').includes(FIRST_SIGN_IN_NOTE));
  const readme = read('README.md');
  const install = readme.slice(readme.indexOf('## Install'), readme.indexOf('\n## ', readme.indexOf('## Install') + 1));
  assert.ok(install.replace(/\s+/g, ' ').includes(FIRST_SIGN_IN_NOTE), 'README Install section');
});
