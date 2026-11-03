/**
 * The shipped defaults select the production deployment: the issuer and COO
 * base are the production API host, the committed .mcp.json names the
 * production gateway, and that gateway derives the production govern origin,
 * which has a default approvals link. The NOBLECLOAK_* overrides still win.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  DEFAULT_COO_URL,
  DEFAULT_ISSUER,
  approvalsUrl,
  cooBaseUrl,
  gatewayUrl,
  governResourceIndicator,
  issuerBaseUrl,
  resolveResourceIndicator,
} from '../scripts/lib/governance.mjs';
import { REPO_ROOT } from './helpers.mjs';

const SHIPPED = { NOBLECLOAK_MCP_FILE: join(REPO_ROOT, '.mcp.json') };

test('issuer and COO base default to the production API host', () => {
  assert.equal(DEFAULT_ISSUER, 'https://api.noblecloak.com');
  assert.equal(DEFAULT_COO_URL, 'https://api.noblecloak.com');
  assert.equal(issuerBaseUrl({}), 'https://api.noblecloak.com');
  assert.equal(cooBaseUrl({}), 'https://api.noblecloak.com');
});

test('the committed .mcp.json names the production gateway, and its govern origin has the production approvals link', () => {
  assert.equal(gatewayUrl(SHIPPED), 'https://mcp.noblecloak.com/v1/mcp');
  assert.equal(resolveResourceIndicator(SHIPPED), 'https://mcp.noblecloak.com');
  const govern = governResourceIndicator(SHIPPED);
  assert.equal(govern, 'https://govern.noblecloak.com');
  assert.equal(approvalsUrl({}, govern), 'https://app.noblecloak.com/approvals');
});

test('the NOBLECLOAK_* overrides select another deployment', () => {
  assert.equal(issuerBaseUrl({ NOBLECLOAK_ISSUER: 'https://api.example.test/' }), 'https://api.example.test');
  assert.equal(cooBaseUrl({ NOBLECLOAK_COO_URL: 'https://coo.example.test' }), 'https://coo.example.test');
  assert.equal(
    governResourceIndicator({ ...SHIPPED, NOBLECLOAK_GOVERN_URL: 'https://govern.example.test/v1' }),
    'https://govern.example.test'
  );
});
