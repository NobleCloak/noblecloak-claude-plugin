/**
 * The default approvals URL: the beta govern origin maps to the shell's /approvals
 * module; any other origin has no default. Precedence (env override over the
 * default) is tested on the pure approvalsUrl(); the env override and the
 * generic sentence are also covered end to end in propose-tool.test.mjs. A
 * spawned run cannot reach the real beta origin, so the source check pins only
 * that the script prints via approvalsUrl().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { approvalsUrl, defaultApprovalsUrl } from '../scripts/lib/governance.mjs';
import { PROPOSE_TOOL_PATH } from './helpers.mjs';

test('beta govern origin → the shell /approvals module', () => {
  assert.equal(
    defaultApprovalsUrl('https://govern.beta.shared.bianoble.com'),
    'https://shell.beta.shared.bianoble.com/approvals'
  );
});

test('any other origin, or none → no default', () => {
  for (const origin of [
    'https://govern.shared.bianoble.com',
    'https://govern.beta.shared.bianoble.com.evil.test',
    'http://localhost:3000',
    '',
    null,
    undefined,
  ]) {
    assert.equal(defaultApprovalsUrl(origin), null, String(origin));
  }
});

test('approvalsUrl: the env override wins over the beta default', () => {
  const beta = 'https://govern.beta.shared.bianoble.com';
  const env = { NOBLECLOAK_APPROVALS_URL: '  https://override.test/x  ' };
  assert.equal(approvalsUrl(env, beta), 'https://override.test/x');
  assert.equal(approvalsUrl({}, beta), 'https://shell.beta.shared.bianoble.com/approvals');
  assert.equal(approvalsUrl({ NOBLECLOAK_APPROVALS_URL: '   ' }, beta), 'https://shell.beta.shared.bianoble.com/approvals');
  assert.equal(approvalsUrl({}, 'http://localhost:3000'), null);
  assert.equal(approvalsUrl(env, 'http://localhost:3000'), 'https://override.test/x');
});

test('propose-tool prints the URL through approvalsUrl', () => {
  const src = readFileSync(PROPOSE_TOOL_PATH, 'utf8');
  assert.match(src, /approvalsUrl\(process\.env, resource\)/);
});
