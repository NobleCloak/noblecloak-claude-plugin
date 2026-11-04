/**
 * Script-level tests for scripts/refresh.mjs (the SessionStart hook) — the
 * control-flow contracts the lib tests can't see: the not-logged-in CTA, the
 * needsRefresh short-circuit, and which refresh failures may/may not tell the
 * user to re-login. refresh.mjs never writes .mcp.json (the committed tokenless
 * file is owned by Claude Code's native OAuth).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_ISSUER } from '../scripts/lib/governance.mjs';
import { makeStateDir, runScript, startStub, REFRESH_PATH, REPO_ROOT } from './helpers.mjs';

function refreshEnv(stub, dir, extra = {}) {
  return {
    NOBLECLOAK_ISSUER: stub.url,
    NOBLECLOAK_STATE_DIR: dir,
    NOBLECLOAK_MCP_FILE: join(dir, 'mcp.json'),
    ...extra,
  };
}

function seedAuth(dir, overrides = {}) {
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      accessToken: 'valid-token',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 60 * 60 * 1000, // valid for an hour
      tokenType: 'Bearer',
      authenticatedAt: new Date().toISOString(),
      ...overrides,
    })
  );
}

test('valid (non-expiring) token → no-op: no token grant, no config fetch, .mcp.json untouched', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url });
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(result.code, 0);
    assert.equal(stub.requests.length, 0, 'no network calls expected');
    assert.equal(existsSync(join(dir, 'mcp.json')), false, 'refresh never writes .mcp.json');
  } finally {
    await stub.close();
  }
});

test('expired token → grant fired, Token refreshed log, auth.json updated, .mcp.json NOT written', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000 });
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Token refreshed/);
    assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/token').length, 1);
    const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8'));
    assert.equal(auth.accessToken, 'refreshed-token');
    assert.equal(existsSync(join(dir, 'mcp.json')), false, 'refresh must not write .mcp.json');
    assert.equal(existsSync(join(dir, 'auth.json.lock')), false, 'no orphaned lockfile');
  } finally {
    await stub.close();
  }
});

test('grant rejected (invalid_grant) → exit 0, re-login advice, .mcp.json untouched', async () => {
  const stub = await startStub();
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000 });
  const mcpFile = join(dir, 'mcp.json');
  const preexisting = JSON.stringify({ mcpServers: { noblecloak: { url: 'x', headers: { Authorization: 'Bearer old' } } } });
  writeFileSync(mcpFile, preexisting);
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(result.code, 0);
    assert.match(result.stderr, /noblecloak-login/);
    assert.doesNotMatch(result.stdout, /Token refreshed/);
    assert.equal(readFileSync(mcpFile, 'utf-8'), preexisting, '.mcp.json must be untouched on refresh failure');
    assert.equal(existsSync(join(dir, 'auth.json.lock')), false, 'no orphaned lockfile');
  } finally {
    await stub.close();
  }
});

test('transient token-endpoint failure (503) → exit 0, NO re-login advice', async () => {
  const stub = await startStub();
  stub.tokenStatus = 503;
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000 });
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(result.code, 0);
    assert.match(result.stderr, /Token refresh failed/);
    assert.doesNotMatch(result.stderr, /noblecloak-login/);
  } finally {
    await stub.close();
  }
});

test('discovery doc without token_endpoint → exit 0, stderr does NOT suggest re-login', async () => {
  const stub = await startStub();
  stub.discoveryDoc = { issuer: 'x', authorization_endpoint: 'y' }; // Stage 4 pending
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000 });
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(result.code, 0);
    assert.match(result.stderr, /Token refresh unavailable/);
    assert.doesNotMatch(result.stderr, /noblecloak-login/);
  } finally {
    await stub.close();
  }
});

test('not logged in → governance CTA, no network calls', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /governance not active[\s\S]*noblecloak-login/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test('not logged in + NOBLECLOAK_AUTO_LOGIN=1 → CTA on stdout plus stderr escalation, no network', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir, { NOBLECLOAK_AUTO_LOGIN: '1' }));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /governance not active/);
    assert.match(result.stderr, /NOBLECLOAK_AUTO_LOGIN=1 set/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test('expired token + no refresh token → re-login advice, no token grant', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000, refreshToken: null });
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(result.code, 0);
    assert.match(result.stderr, /noblecloak-login/);
    assert.doesNotMatch(result.stdout, /Token refreshed/);
    assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/token').length, 0);
  } finally {
    await stub.close();
  }
});

// ── user-visible SessionStart output + signed-out marker (2026-10-20) ─────
//
// Claude Code shows a SessionStart hook's JSON `systemMessage` to the user;
// plain stdout only reaches Claude's context and stderr from an exit-0 hook is
// never shown (code.claude.com/docs/en/hooks). The incident: a rejected grant
// was reported on stderr only, and the plugin stayed silently signed out for
// two months.

function hookJson(result) {
  return result.stdout ? JSON.parse(result.stdout) : null;
}
const marker = (dir) => join(dir, 'signed-out.json');

test('SessionStart: rejected grant → user-visible systemMessage naming /noblecloak-login + signed-out marker', async () => {
  const stub = await startStub();
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000 });
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(result.code, 0);
    const out = hookJson(result);
    assert.match(out.systemMessage, /signed out of governance/);
    assert.match(out.systemMessage, /\/noblecloak-login/);
    const m = JSON.parse(readFileSync(marker(dir), 'utf-8'));
    assert.match(m.reason, /invalid_grant/);
  } finally {
    await stub.close();
  }
});

test('SessionStart: expired + no refresh token → visible message + marker', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000, refreshToken: null });
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.match(hookJson(result).systemMessage, /noblecloak-login/);
    assert.ok(existsSync(marker(dir)));
  } finally {
    await stub.close();
  }
});

test('SessionStart: still-valid token inside the refresh buffer + no refresh token → NOT signed out; soft visible heads-up', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() + 2 * 60 * 1000, refreshToken: null }); // 2 min left (< 5 min buffer, > 30s skew)
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(result.code, 0);
    assert.ok(!existsSync(marker(dir)), 'a token that still works is never marked signed out');
    const out = hookJson(result);
    assert.match(out.systemMessage, /expires at .* can't be renewed automatically/);
    assert.match(out.systemMessage, /\/noblecloak-login/);
    assert.doesNotMatch(out.systemMessage, /signed out/);
    assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/token').length, 0);
  } finally {
    await stub.close();
  }
});

test('SessionStart: transient failure → softer visible line, no re-login advice, no marker', async () => {
  const stub = await startStub();
  stub.tokenStatus = 503;
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000 });
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    const out = hookJson(result);
    assert.match(out.systemMessage, /couldn't refresh/);
    assert.doesNotMatch(out.systemMessage, /noblecloak-login/);
    assert.ok(!existsSync(marker(dir)));
  } finally {
    await stub.close();
  }
});

test('SessionStart: discovery failure → softer visible line, no marker', async () => {
  const stub = await startStub();
  stub.discoveryDoc = { issuer: 'x', authorization_endpoint: 'y' };
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000 });
  try {
    const out = hookJson(await runScript(REFRESH_PATH, refreshEnv(stub, dir)));
    assert.match(out.systemMessage, /couldn't refresh/);
    assert.ok(!existsSync(marker(dir)));
  } finally {
    await stub.close();
  }
});

test('SessionStart: a marker always re-tries (even with a still-valid token); success clears it, "refreshed" goes to context only', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url }); // token valid for an hour
  writeFileSync(marker(dir), JSON.stringify({ since: 'x', reason: 'invalid_grant', checkedAt: Date.now() }));
  try {
    const result = await runScript(REFRESH_PATH, refreshEnv(stub, dir));
    assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/token').length, 1);
    assert.ok(!existsSync(marker(dir)), 'a successful refresh clears the marker');
    const out = hookJson(result);
    assert.equal(out.systemMessage, undefined, 'nothing for the user to act on');
    assert.match(out.hookSpecificOutput.additionalContext, /Token refreshed/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  } finally {
    await stub.close();
  }
});

test('SessionStart: a signed-out message shown here is not repeated by the PreToolUse hook in the same session', async () => {
  const stub = await startStub();
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 1000 });
  try {
    await runScript(REFRESH_PATH, refreshEnv(stub, dir, { CLAUDE_CODE_SESSION_ID: 'sess-1' }));
    const { takeNotices } = await import('../scripts/lib/governance.mjs');
    const env = { NOBLECLOAK_STATE_DIR: dir };
    assert.deepEqual(takeNotices('sess-1', env), [], 'already shown at SessionStart');
    assert.equal(takeNotices('sess-2', env).length, 1, 'another session still gets it once');
  } finally {
    await stub.close();
  }
});

// ── marker lifecycle: login and logout clear it ───────────────────────────

test('logout clears the signed-out marker', async () => {
  const dir = makeStateDir();
  seedAuth(dir, { issuer: DEFAULT_ISSUER });
  writeFileSync(marker(dir), JSON.stringify({ since: 'x', reason: 'y', checkedAt: Date.now() }));
  const result = await runScript(join(REPO_ROOT, 'scripts', 'logout.mjs'), { NOBLECLOAK_STATE_DIR: dir });
  assert.equal(result.code, 0);
  assert.ok(!existsSync(marker(dir)));
});

test('login clears the signed-out marker right after saving the new auth state (wiring)', () => {
  // login.mjs needs a browser round-trip, so this asserts the wiring at the
  // source: clearSignedOut() is called immediately after saveAuthState(authState).
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'login.mjs'), 'utf-8');
  assert.match(src, /saveAuthState\(authState\);\s*(\/\/[^\n]*\n\s*)*clearSignedOut\(\);/);
});

test('clearSignedOut removes the marker and its pending notice', async () => {
  const { writeSignedOut, clearSignedOut, readSignedOut, takeNotices } = await import('../scripts/lib/governance.mjs');
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  writeSignedOut('invalid_grant', env);
  assert.ok(readSignedOut(env));
  clearSignedOut(env);
  assert.equal(readSignedOut(env), null);
  assert.deepEqual(takeNotices('any-session', env), []);
});
