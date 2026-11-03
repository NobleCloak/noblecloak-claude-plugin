/**
 * Per-resource tokens: the gateway token stays at auth.json's top level, other
 * resources (govern) live under `tokens[<origin>]`. Covers the resource
 * resolution, storage, single-flight refresh, and refresh.mjs refreshing both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_ISSUER,
  getTokenFor,
  governResourceIndicator,
  refreshTokenFor,
  saveTokenFor,
} from '../scripts/lib/governance.mjs';
import { makeStateDir, runScript, startStub, REFRESH_PATH, REPO_ROOT } from './helpers.mjs';

const GATEWAY = 'https://mcp.noblecloak.com';
const GOVERN = 'https://govern.noblecloak.com';

function mcpFile(dir, url = `${GATEWAY}/v1/mcp`) {
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { noblecloak: { type: 'http', url } } }));
  return file;
}

function seed(dir, auth) {
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({ accessToken: 'gw-token', refreshToken: 'gw-refresh', expiresAt: Date.now() + 3_600_000, ...auth })
  );
}

test('governResourceIndicator: mcp.<host> → govern.<host>', () => {
  const dir = makeStateDir();
  assert.equal(governResourceIndicator({ NOBLECLOAK_MCP_FILE: mcpFile(dir) }), GOVERN);
});

test('governResourceIndicator: NOBLECLOAK_GOVERN_URL wins and is reduced to its origin', () => {
  const dir = makeStateDir();
  assert.equal(
    governResourceIndicator({ NOBLECLOAK_MCP_FILE: mcpFile(dir), NOBLECLOAK_GOVERN_URL: 'https://g.example.test/v1/' }),
    'https://g.example.test'
  );
});

test('governResourceIndicator: null when the gateway host is not mcp.* (no guessing) or nothing resolves', () => {
  const dir = makeStateDir();
  assert.equal(governResourceIndicator({ NOBLECLOAK_MCP_FILE: mcpFile(dir, 'https://gateway.example.test/v1/mcp') }), null);
  assert.equal(governResourceIndicator({ NOBLECLOAK_MCP_FILE: join(dir, 'absent.json') }), null);
  assert.equal(governResourceIndicator({ NOBLECLOAK_GOVERN_URL: 'not a url' }), null);
});

test('getTokenFor: a legacy single-token auth.json is the gateway entry; govern is absent until stored', () => {
  const dir = makeStateDir();
  seed(dir, { issuer: DEFAULT_ISSUER });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_MCP_FILE: mcpFile(dir) };
  assert.equal(getTokenFor(GATEWAY, env).accessToken, 'gw-token');
  assert.equal(getTokenFor(GOVERN, env), null);
});

test('saveTokenFor stores beside the gateway token without touching it; getTokenFor reads it back', async () => {
  const dir = makeStateDir();
  seed(dir, { issuer: DEFAULT_ISSUER });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_MCP_FILE: mcpFile(dir) };
  await saveTokenFor(GOVERN, { accessToken: 'gv-token', refreshToken: 'gv-refresh', expiresAt: 1 }, env);
  assert.equal(getTokenFor(GOVERN, env).accessToken, 'gv-token');
  assert.equal(getTokenFor(GATEWAY, env).accessToken, 'gw-token');
  const onDisk = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8'));
  assert.equal(onDisk.accessToken, 'gw-token', 'top level stays the gateway token');
  assert.equal(onDisk.refreshToken, 'gw-refresh');
});

test('saveTokenFor with no session throws (a govern token never creates a session)', async () => {
  const dir = makeStateDir();
  await assert.rejects(saveTokenFor(GOVERN, { accessToken: 'x' }, { NOBLECLOAK_STATE_DIR: dir }), /noblecloak-login/);
});

test('refreshTokenFor re-sends the resource, rotates the refresh token, leaves the gateway token alone', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seed(dir, { issuer: stub.url, tokens: { [GOVERN]: { accessToken: 'gv-old', refreshToken: 'gv-r1', expiresAt: 1 } } });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_MCP_FILE: mcpFile(dir) };
  try {
    const updated = await refreshTokenFor(GOVERN, env);
    assert.equal(updated.accessToken, 'refreshed-token');
    const grants = stub.requests.filter((r) => r.path === '/auth/oauth/token');
    assert.equal(grants.length, 1);
    const form = new URLSearchParams(grants[0].rawBody);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'gv-r1');
    assert.equal(form.get('resource'), GOVERN);
    const onDisk = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8'));
    assert.equal(onDisk.accessToken, 'gw-token');
    assert.equal(onDisk.tokens[GOVERN].refreshToken, 'refreshed-refresh');
  } finally {
    await stub.close();
  }
});

test('refresh.mjs: gateway valid + govern expired → only the govern grant fires (with resource)', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seed(dir, { issuer: stub.url, tokens: { [GOVERN]: { accessToken: 'gv-old', refreshToken: 'gv-r1', expiresAt: Date.now() - 1000 } } });
  try {
    const result = await runScript(REFRESH_PATH, {
      NOBLECLOAK_ISSUER: stub.url,
      NOBLECLOAK_STATE_DIR: dir,
      NOBLECLOAK_MCP_FILE: mcpFile(dir),
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp(`Token refreshed \\(${GOVERN.replace(/\./g, '\\.')}\\)`));
    const grants = stub.requests.filter((r) => r.path === '/auth/oauth/token');
    assert.equal(grants.length, 1);
    assert.equal(new URLSearchParams(grants[0].rawBody).get('resource'), GOVERN);
    const onDisk = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8'));
    assert.equal(onDisk.accessToken, 'gw-token');
  } finally {
    await stub.close();
  }
});

test('refresh.mjs: both expired → both refreshed; gateway grant carries no resource', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seed(dir, { issuer: stub.url,
    expiresAt: Date.now() - 1000,
    tokens: { [GOVERN]: { accessToken: 'gv-old', refreshToken: 'gv-r1', expiresAt: Date.now() - 1000 } },
  });
  try {
    const result = await runScript(REFRESH_PATH, {
      NOBLECLOAK_ISSUER: stub.url,
      NOBLECLOAK_STATE_DIR: dir,
      NOBLECLOAK_MCP_FILE: mcpFile(dir),
    });
    assert.equal(result.code, 0);
    const grants = stub.requests.filter((r) => r.path === '/auth/oauth/token');
    assert.equal(grants.length, 2);
    const forms = grants.map((g) => new URLSearchParams(g.rawBody));
    assert.equal(forms.filter((f) => f.get('resource') === null).length, 1, 'gateway grant has no resource');
    assert.equal(forms.filter((f) => f.get('resource') === GOVERN).length, 1);
  } finally {
    await stub.close();
  }
});

test('refresh.mjs: govern grant rejected → advice names /noblecloak-propose-tool, not /noblecloak-login', async () => {
  const stub = await startStub();
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const dir = makeStateDir();
  seed(dir, { issuer: stub.url, tokens: { [GOVERN]: { accessToken: 'gv-old', refreshToken: 'gv-r1', expiresAt: Date.now() - 1000 } } });
  try {
    const result = await runScript(REFRESH_PATH, {
      NOBLECLOAK_ISSUER: stub.url,
      NOBLECLOAK_STATE_DIR: dir,
      NOBLECLOAK_MCP_FILE: mcpFile(dir),
    });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /noblecloak-propose-tool/);
    assert.doesNotMatch(result.stderr, /noblecloak-login/);
  } finally {
    await stub.close();
  }
});

test('login replaces auth.json wholesale: its saved state carries no per-resource tokens (a re-login drops the govern token on purpose)', () => {
  // login.mjs is an interactive browser flow, so this pins the source: the object
  // it saves is built from the fresh token response only, never spread from the old state.
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'login.mjs'), 'utf-8');
  const literal = src.match(/const authState = \{[\s\S]*?\n {8}\};/)?.[0];
  assert.ok(literal, 'authState literal found in login.mjs');
  assert.doesNotMatch(literal, /\.\.\.(auth|existing|previous|old)\b|tokens\s*:/);
  assert.match(src, /saveAuthState\(authState\)/);
});

test('auth.json is written owner-only (0600) by saveTokenFor and again by a refresh rewrite', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seed(dir, { issuer: stub.url, tokens: { [GOVERN]: { accessToken: 'gv-old', refreshToken: 'gv-r1', expiresAt: 1 } } });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_MCP_FILE: mcpFile(dir) };
  try {
    await saveTokenFor(GOVERN, { accessToken: 'x', refreshToken: 'y', expiresAt: 1 }, env);
    assert.equal(statSync(join(dir, 'auth.json')).mode & 0o777, 0o600);
    await refreshTokenFor(GOVERN, env);
    assert.equal(statSync(join(dir, 'auth.json')).mode & 0o777, 0o600);
  } finally {
    await stub.close();
  }
});

test('refreshTokenFor single-flight: two overlapping refreshes send ONE grant and both return the winner\'s tokens', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seed(dir, { issuer: stub.url, tokens: { [GOVERN]: { accessToken: 'gv-old', refreshToken: 'gv-r1', expiresAt: 1 } } });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_MCP_FILE: mcpFile(dir) };
  try {
    const [a, b] = await Promise.all([refreshTokenFor(GOVERN, env), refreshTokenFor(GOVERN, env)]);
    // Refresh-token reuse revokes the whole family in core, so a second grant would kill the govern grant.
    assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/token').length, 1);
    assert.equal(a.accessToken, 'refreshed-token');
    assert.equal(b.accessToken, 'refreshed-token');
    assert.equal(b.refreshToken, 'refreshed-refresh');
  } finally {
    await stub.close();
  }
});
