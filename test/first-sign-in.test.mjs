/**
 * First sign-in creates the account: the deployment provisions a user (with a
 * personal workspace) the first time they sign in, so the plugin says so where
 * a new person looks. login.mjs needs a browser, so its half is a source scan:
 * the note is printed before the browser is opened. The command doc and the
 * README Install section carry the same sentence.
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

test('login.mjs prints the note before it opens the browser', () => {
  const src = read('scripts', 'login.mjs');
  const note = src.indexOf('console.log(FIRST_SIGN_IN_NOTE)');
  const opening = src.indexOf("console.log('Opening browser");
  const open = src.indexOf('open(authUrl.toString())');
  assert.ok(note > 0, 'login.mjs prints FIRST_SIGN_IN_NOTE');
  assert.ok(note < opening && note < open, 'before the browser is opened');
});

test('the login command and the README Install section carry the same sentence', () => {
  assert.ok(read('commands', 'noblecloak-login.md').includes(FIRST_SIGN_IN_NOTE));
  const readme = read('README.md');
  const install = readme.slice(readme.indexOf('## Install'), readme.indexOf('\n## ', readme.indexOf('## Install') + 1));
  assert.ok(install.replace(/\s+/g, ' ').includes(FIRST_SIGN_IN_NOTE), 'README Install section');
});
