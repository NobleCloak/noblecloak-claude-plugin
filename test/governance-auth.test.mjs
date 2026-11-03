/**
 * Tests for the auth/refresh side of scripts/lib/governance.mjs — OAuth
 * discovery error taxonomy, atomic auth.json writes, and the cross-process
 * single-flight refresh lock — against the local stub server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_ISSUER,
  discoverAuthServer,
  getTokenEndpoint,
  refreshAuthState,
  refreshTokens,
  saveAuthState,
  ensureRegisteredClientId,
  getBearerToken,
  loadAuthState,
  loadRegisteredClient,
  readAuthFile,
  saveRegisteredClient,
  AuthDiscoveryError,
  TokenRefreshError,
  emitAuditEvent,
  EMIT_DELIVERED,
  EMIT_SPILLED,
  readBreaker,
  usableBearer,
  isTokenExpired,
  TOKEN_EXPIRY_SKEW_MS,
} from '../scripts/lib/governance.mjs';
import { makeStateDir, startStub } from './helpers.mjs';

function seedAuth(dir, overrides = {}) {
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      accessToken: 'stale-token',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
      authenticatedAt: new Date().toISOString(),
      ...overrides,
    })
  );
}

// ── discovery error taxonomy ────────────────────────────────────────────────

test('discoverAuthServer: non-JSON 200 body → AuthDiscoveryError, not a raw SyntaxError', async () => {
  const stub = await startStub();
  stub.discoveryRawBody = '<html>ALB error page</html>';
  try {
    await assert.rejects(
      discoverAuthServer({ NOBLECLOAK_ISSUER: stub.url }),
      (err) => err instanceof AuthDiscoveryError && /non-JSON/.test(err.message) && /NOBLECLOAK_ISSUER/.test(err.message)
    );
  } finally {
    await stub.close();
  }
});

test('getTokenEndpoint: discovery doc without token_endpoint → AuthDiscoveryError naming Stage 4', async () => {
  const stub = await startStub();
  stub.discoveryDoc = { issuer: 'x', authorization_endpoint: 'y' }; // no token_endpoint
  try {
    await assert.rejects(
      getTokenEndpoint({ NOBLECLOAK_ISSUER: stub.url }),
      (err) => err instanceof AuthDiscoveryError && /Stage 4/.test(err.message) && /token_endpoint/.test(err.message)
    );
  } finally {
    await stub.close();
  }
});

// ── atomic auth.json writes ─────────────────────────────────────────────────

test('saveAuthState writes via rename and leaves no temp files behind', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  saveAuthState({ accessToken: 'a1', refreshToken: 'r1', expiresAt: 1 }, env);
  saveAuthState({ accessToken: 'a2', refreshToken: 'r2', expiresAt: 2 }, env);
  const files = readdirSync(dir);
  assert.deepEqual(files, ['auth.json'], `unexpected files in state dir: ${files.join(', ')}`);
  assert.equal(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8')).accessToken, 'a2');
});

// ── single-flight refresh ───────────────────────────────────────────────────

test('concurrent refreshAuthState calls fire exactly one token grant; losers adopt the winner tokens', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  seedAuth(dir, { issuer: stub.url });
  try {
    const results = await Promise.all([
      refreshAuthState(env),
      refreshAuthState(env),
      refreshAuthState(env),
    ]);
    const tokenGrants = stub.requests.filter((r) => r.path === '/auth/oauth/token');
    assert.equal(tokenGrants.length, 1, 'refresh must be single-flight across concurrent callers');
    for (const result of results) {
      assert.equal(result.accessToken, 'refreshed-token');
      assert.equal(result.refreshToken, 'refreshed-refresh');
    }
    const onDisk = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8'));
    assert.equal(onDisk.accessToken, 'refreshed-token');
    assert.equal(onDisk.refreshToken, 'refreshed-refresh');
  } finally {
    await stub.close();
  }
});

test('refreshAuthState always grants with the CURRENT on-disk refresh token (rotation-safe)', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  seedAuth(dir, { issuer: stub.url });
  try {
    await refreshAuthState(env); // rotates refresh-1 → refreshed-refresh on disk
    await refreshAuthState(env); // must use the rotated token, never refresh-1
    const grants = stub.requests.filter((r) => r.path === '/auth/oauth/token');
    assert.equal(grants.length, 2);
    assert.match(grants[0].rawBody, /refresh_token=refresh-1/);
    assert.match(grants[1].rawBody, /refresh_token=refreshed-refresh/);
  } finally {
    await stub.close();
  }
});

test('refreshAuthState without a refresh token names /noblecloak-login', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  seedAuth(dir, { issuer: DEFAULT_ISSUER, refreshToken: undefined });
  await assert.rejects(refreshAuthState(env), /noblecloak-login/);
});

// ── stale-lock steal + lock deadline (sole recovery from a crashed holder) ──

function backdateLock(lockPath, ageMs) {
  const t = new Date(Date.now() - ageMs);
  utimesSync(lockPath, t, t);
}

test('a stale lock from a crashed holder is stolen: refresh proceeds and the lock is gone', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  seedAuth(dir, { issuer: stub.url });
  const lockPath = join(dir, 'auth.json.lock');
  writeFileSync(lockPath, '99999.deadbeef'); // crashed holder's lock
  backdateLock(lockPath, 20_000); // older than AUTH_LOCK_STALE_MS (15s)
  try {
    const updated = await refreshAuthState(env);
    assert.equal(updated.accessToken, 'refreshed-token');
    const grants = stub.requests.filter((r) => r.path === '/auth/oauth/token');
    assert.equal(grants.length, 1, 'the token grant must fire after stealing the stale lock');
    assert.equal(existsSync(lockPath), false, 'the lock must be released after the refresh');
  } finally {
    await stub.close();
  }
});

test('two waiters racing on the same stale lock produce exactly one token grant', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  seedAuth(dir, { issuer: stub.url });
  const lockPath = join(dir, 'auth.json.lock');
  writeFileSync(lockPath, '99999.deadbeef');
  backdateLock(lockPath, 20_000);
  try {
    const results = await Promise.all([refreshAuthState(env), refreshAuthState(env)]);
    const grants = stub.requests.filter((r) => r.path === '/auth/oauth/token');
    assert.equal(grants.length, 1, 'steal must be atomic — only one stealer may refresh');
    for (const result of results) {
      assert.equal(result.accessToken, 'refreshed-token');
    }
    assert.equal(existsSync(lockPath), false);
  } finally {
    await stub.close();
  }
});

test('a fresh (live) lock is NOT stolen: a deadline-bounded waiter times out instead', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  seedAuth(dir, { issuer: DEFAULT_ISSUER });
  const lockPath = join(dir, 'auth.json.lock');
  writeFileSync(lockPath, '12345.cafebabe'); // fresh — held by a live process
  await assert.rejects(
    refreshAuthState(env, { deadline: Date.now() + 300 }),
    /auth refresh lock/
  );
  assert.equal(readFileSync(lockPath, 'utf-8'), '12345.cafebabe', 'the live holder lock must be untouched');
});

test('a no-deadline waiter proceeds once the holder releases the lock', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  seedAuth(dir, { issuer: stub.url });
  const lockPath = join(dir, 'auth.json.lock');
  writeFileSync(lockPath, '12345.cafebabe');
  setTimeout(() => rmSync(lockPath, { force: true }), 100); // holder finishes
  try {
    const updated = await refreshAuthState(env);
    assert.equal(updated.accessToken, 'refreshed-token');
  } finally {
    await stub.close();
  }
});

// ── token endpoint error taxonomy ───────────────────────────────────────────

test('refreshTokens: 400 invalid_grant → non-transient TokenRefreshError naming the OAuth error', async () => {
  const stub = await startStub();
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant', error_description: 'refresh token revoked' };
  try {
    await assert.rejects(
      refreshTokens('revoked', { NOBLECLOAK_ISSUER: stub.url }),
      (err) =>
        err instanceof TokenRefreshError &&
        err.transient === false &&
        err.oauthError === 'invalid_grant' &&
        /invalid_grant/.test(err.message) &&
        /refresh token revoked/.test(err.message)
    );
  } finally {
    await stub.close();
  }
});

test('refreshTokens: 503 → transient TokenRefreshError (re-login is the wrong advice)', async () => {
  const stub = await startStub();
  stub.tokenStatus = 503;
  try {
    await assert.rejects(
      refreshTokens('r', { NOBLECLOAK_ISSUER: stub.url }),
      (err) => err instanceof TokenRefreshError && err.transient === true && /transient/.test(err.message)
    );
  } finally {
    await stub.close();
  }
});

test('refreshTokens: 200 with non-JSON body → transient TokenRefreshError, not a raw SyntaxError', async () => {
  const stub = await startStub();
  stub.tokenRawBody = '<html>misrouted ALB</html>';
  try {
    await assert.rejects(
      refreshTokens('r', { NOBLECLOAK_ISSUER: stub.url }),
      (err) =>
        err instanceof TokenRefreshError &&
        err.transient === true &&
        /non-JSON/.test(err.message) &&
        /NOBLECLOAK_ISSUER/.test(err.message)
    );
  } finally {
    await stub.close();
  }
});

// ── DCR client registration (RFC 7591) ──────────────────────────────────────
// The plugin authorizes with a DYNAMICALLY-registered public+PKCE client, not a
// hardcoded client_id. ensureRegisteredClientId registers once, persists the
// generated id in .local/client.json (keyed by redirect_uri), and reuses it.

const REDIRECT = 'http://localhost:19284/callback';

test('ensureRegisteredClientId: registers via DCR and persists the generated client_id', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  try {
    const id = await ensureRegisteredClientId({
      registrationEndpoint: `${stub.url}/auth/oauth/register`,
      redirectUri: REDIRECT,
      env,
    });
    assert.equal(id, 'dcr-generated-id');

    // persisted, keyed by redirect_uri
    const persisted = loadRegisteredClient(env);
    assert.equal(persisted.clientId, 'dcr-generated-id');
    assert.equal(persisted.redirectUri, REDIRECT);

    // exactly one DCR POST, with the public-PKCE metadata
    const regs = stub.requests.filter((r) => r.path === '/auth/oauth/register' && r.method === 'POST');
    assert.equal(regs.length, 1);
    assert.deepEqual(regs[0].body.redirect_uris, [REDIRECT]);
    assert.equal(regs[0].body.token_endpoint_auth_method, 'none');
  } finally {
    await stub.close();
  }
});

test('ensureRegisteredClientId: reuses a persisted client without re-registering', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  try {
    // first call registers
    await ensureRegisteredClientId({ registrationEndpoint: `${stub.url}/auth/oauth/register`, redirectUri: REDIRECT, env });
    // second call must reuse, not register again
    const id = await ensureRegisteredClientId({ registrationEndpoint: `${stub.url}/auth/oauth/register`, redirectUri: REDIRECT, env });
    assert.equal(id, 'dcr-generated-id');
    const regs = stub.requests.filter((r) => r.path === '/auth/oauth/register');
    assert.equal(regs.length, 1, 'registered exactly once across two calls');
  } finally {
    await stub.close();
  }
});

test('ensureRegisteredClientId: NOBLECLOAK_CLIENT_ID override wins and never registers', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_CLIENT_ID: 'preset-client' };
  try {
    const id = await ensureRegisteredClientId({ registrationEndpoint: `${stub.url}/auth/oauth/register`, redirectUri: REDIRECT, env });
    assert.equal(id, 'preset-client');
    assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/register').length, 0);
  } finally {
    await stub.close();
  }
});

test('ensureRegisteredClientId: a persisted client for a DIFFERENT redirect_uri triggers re-registration', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  try {
    await ensureRegisteredClientId({ registrationEndpoint: `${stub.url}/auth/oauth/register`, redirectUri: 'http://localhost:9999/callback', env });
    const id = await ensureRegisteredClientId({ registrationEndpoint: `${stub.url}/auth/oauth/register`, redirectUri: REDIRECT, env });
    assert.equal(id, 'dcr-generated-id');
    assert.equal(loadRegisteredClient(env).redirectUri, REDIRECT);
    assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/register').length, 2);
  } finally {
    await stub.close();
  }
});

// adv-1 (2026-11-03): 0.2.0 changed the default deployment. A client_id
// registered at another authorization server is unknown to this one
// ("unknown client_id"), so it is never reused there.
for (const [label, persisted] of [
  ['registered at another authorization server', { registrationEndpoint: 'https://auth.other.example/auth/oauth/register' }],
  ['saved by plugin 0.1.x (no registrationEndpoint)', {}],
]) {
  test(`ensureRegisteredClientId: a persisted client ${label} triggers re-registration`, async () => {
    const stub = await startStub();
    const dir = makeStateDir();
    const env = { NOBLECLOAK_STATE_DIR: dir };
    saveRegisteredClient({ clientId: 'client-from-elsewhere', redirectUri: REDIRECT, ...persisted }, env);
    try {
      const registrationEndpoint = `${stub.url}/auth/oauth/register`;
      const id = await ensureRegisteredClientId({ registrationEndpoint, redirectUri: REDIRECT, env });
      assert.equal(id, 'dcr-generated-id');
      assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/register').length, 1);
      assert.equal(loadRegisteredClient(env).registrationEndpoint, registrationEndpoint, 'records where it registered');
    } finally {
      await stub.close();
    }
  });
}

// ── a sign-in belongs to the deployment it was made against (adv-1) ────────

test('loadAuthState: a sign-in made against another issuer, or saved by 0.1.x with no issuer, reads as signed out', () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: 'https://api.here.example/' };
  seedAuth(dir, { issuer: 'https://api.here.example' });
  assert.equal(loadAuthState(env)?.accessToken, 'stale-token', 'same issuer (trailing slash ignored)');
  seedAuth(dir, { issuer: 'https://api.beta.example' });
  assert.equal(loadAuthState(env), null, 'another issuer');
  assert.equal(getBearerToken(env), null, 'no bearer token from another deployment');
  assert.equal(readAuthFile(env)?.accessToken, 'stale-token', 'the file itself is left alone');
  seedAuth(dir, { issuer: undefined });
  assert.equal(loadAuthState(env), null, 'no issuer recorded (plugin 0.1.x)');
});

test('refreshAuthState never sends a refresh token from another deployment to this one', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  seedAuth(dir, { issuer: 'https://api.beta.example', expiresAt: Date.now() - 60_000 });
  try {
    await assert.rejects(refreshAuthState(env), /noblecloak-login/);
    assert.equal(stub.requests.length, 0, 'no discovery, no token grant');
  } finally {
    await stub.close();
  }
});

test('ensureRegisteredClientId: DCR error response throws a clear, non-discovery error', async () => {
  const stub = await startStub();
  stub.registerStatus = 400;
  stub.registerErrorBody = { error: 'invalid_redirect_uri', error_description: 'bad uri' };
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  try {
    await assert.rejects(
      ensureRegisteredClientId({ registrationEndpoint: `${stub.url}/auth/oauth/register`, redirectUri: REDIRECT, env }),
      (err) => /register/i.test(err.message) && /invalid_redirect_uri|400/.test(err.message)
    );
    assert.equal(loadRegisteredClient(env), null, 'nothing persisted on failure');
  } finally {
    await stub.close();
  }
});

test('ensureRegisteredClientId: no registration endpoint and no override → clear error', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  await assert.rejects(
    ensureRegisteredClientId({ registrationEndpoint: undefined, redirectUri: REDIRECT, env }),
    (err) => /registration/i.test(err.message)
  );
});

// ── refresh uses the DCR-registered client (regression: #3 follow-up) ─────────
// The token was issued to the dynamically-registered client (client.json); the
// refresh_token grant MUST present that same client_id, or the AS rejects it with
// `invalid_grant — refresh token was issued to another client`. clientId() is just
// a governance LABEL, not the OAuth client.

test('refreshAuthState sends the DCR-registered client_id, not the static label', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  seedAuth(dir, { issuer: stub.url });
  saveRegisteredClient({ clientId: 'bnoauth_test123', redirectUri: 'http://localhost:19284/callback' }, env);
  try {
    await refreshAuthState(env);
    const grant = stub.requests.find((r) => r.path === '/auth/oauth/token');
    assert.ok(grant, 'a refresh_token grant was sent');
    assert.match(grant.rawBody, /client_id=bnoauth_test123/);
    assert.doesNotMatch(grant.rawBody, /client_id=claude-code-plugin/);
  } finally {
    await stub.close();
  }
});

test('refresh client_id honors the NOBLECLOAK_CLIENT_ID override over the persisted client', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_CLIENT_ID: 'preset-client' };
  seedAuth(dir, { issuer: stub.url });
  saveRegisteredClient({ clientId: 'bnoauth_ignored', redirectUri: 'http://localhost:19284/callback' }, env);
  try {
    await refreshAuthState(env);
    const grant = stub.requests.find((r) => r.path === '/auth/oauth/token');
    assert.match(grant.rawBody, /client_id=preset-client/);
  } finally {
    await stub.close();
  }
});

test('refresh falls back to the static label when no client is registered and no override is set', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  seedAuth(dir, { issuer: stub.url });
  // No saveRegisteredClient, no NOBLECLOAK_CLIENT_ID: this is the first-run/legacy arm.
  assert.equal(existsSync(join(dir, 'client.json')), false, 'precondition: no client.json on disk');
  try {
    await refreshAuthState(env);
    const grant = stub.requests.find((r) => r.path === '/auth/oauth/token');
    assert.ok(grant, 'a refresh_token grant was sent');
    assert.match(grant.rawBody, /client_id=claude-code-plugin/);
  } finally {
    await stub.close();
  }
});

test('a corrupt client.json is reported on stderr and the refresh falls back to the static label', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  seedAuth(dir, { issuer: stub.url });
  // Simulate a truncated/partial write (e.g. crash mid-write).
  writeFileSync(join(dir, 'client.json'), '{ "clientId": "bnoauth_tru');

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await refreshAuthState(env);
    const grant = stub.requests.find((r) => r.path === '/auth/oauth/token');
    assert.ok(grant, 'a refresh_token grant was sent');
    // Corrupt file must NOT silently present as "no client" with no trace…
    assert.ok(
      errors.some((line) => /client\.json unreadable/.test(line)),
      `expected a corrupt-client.json diagnostic on stderr, got: ${errors.join(' | ')}`
    );
    // …and behavior on the bad-file path matches the no-client fallback.
    assert.match(grant.rawBody, /client_id=claude-code-plugin/);
  } finally {
    console.error = originalError;
    await stub.close();
  }
});

// ── local expiry check + signed-out marker on the EMIT path (2026-10-20) ────

const eventPosts = (stub) => stub.requests.filter((r) => r.path === '/v1/coo/local/events');
const grants = (stub) => stub.requests.filter((r) => r.path === '/auth/oauth/token');

test('isTokenExpired: honors the skew allowance; no expiresAt is not known-expired', () => {
  const now = 1_000_000;
  assert.equal(isTokenExpired({ expiresAt: now + TOKEN_EXPIRY_SKEW_MS + 1 }, now), false);
  assert.equal(isTokenExpired({ expiresAt: now + TOKEN_EXPIRY_SKEW_MS }, now), true);
  assert.equal(isTokenExpired({ expiresAt: now - 1 }, now), true);
  assert.equal(isTokenExpired({}, now), false);
});

test('emit while signed out: spills, ZERO fetches (events or token), breaker untouched', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000 });
  writeFileSync(join(dir, 'signed-out.json'), JSON.stringify({ since: 'x', reason: 'invalid_grant', checkedAt: Date.now() }));
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_COO_URL: stub.url };
  try {
    const status = await emitAuditEvent({ id: 'toolu_x:pre', subject: 's' }, env);
    assert.equal(status, EMIT_SPILLED);
    assert.equal(stub.requests.length, 0);
    assert.equal(existsSync(join(dir, 'audit-breaker.json')), false, 'logged out is not an outage');
    assert.equal(readBreaker(env).phase, 'closed');
  } finally {
    await stub.close();
  }
});

test('emit with an expired token: refreshes once, POSTs only the refreshed token', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000 });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_COO_URL: stub.url };
  try {
    const status = await emitAuditEvent({ id: 'toolu_x:pre', subject: 's' }, env);
    assert.equal(status, EMIT_DELIVERED);
    assert.equal(grants(stub).length, 1);
    assert.equal(eventPosts(stub).length, 1);
    assert.equal(eventPosts(stub)[0].headers.authorization, 'Bearer refreshed-token');
  } finally {
    await stub.close();
  }
});

test('emit with an expired token whose refresh is rejected: marker written, nothing POSTed, breaker untouched', async () => {
  const stub = await startStub();
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000 });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_COO_URL: stub.url };
  try {
    assert.equal(await emitAuditEvent({ id: 'a:pre', subject: 's' }, env), EMIT_SPILLED);
    assert.equal(await emitAuditEvent({ id: 'b:pre', subject: 's' }, env), EMIT_SPILLED);
    assert.equal(eventPosts(stub).length, 0);
    assert.equal(grants(stub).length, 1, 'the second emit sees the marker and does not re-try the dead grant');
    assert.ok(existsSync(join(dir, 'signed-out.json')));
    assert.equal(existsSync(join(dir, 'audit-breaker.json')), false);
  } finally {
    await stub.close();
  }
});

test('concurrent refreshes of a dead grant: waiters that queued on the lock do not re-send it', async () => {
  const stub = await startStub();
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000 });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  try {
    const results = await Promise.all([usableBearer(env), usableBearer(env), usableBearer(env)]);
    assert.ok(results.every((r) => r.token === null && r.reason === 'signed-out'));
    assert.equal(grants(stub).length, 1, 'one rejected grant, not one per caller');
  } finally {
    await stub.close();
  }
});

test('usableBearer allowRefresh:false never touches the network', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000 });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  try {
    const r = await usableBearer(env, { allowRefresh: false });
    assert.deepEqual([r.token, r.reason], [null, 'token-expired']);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

// ── adv-3: only a dead-grant OAuth error signs the plugin out ───────────────

for (const [status, body] of [
  [429, { message: 'Too Many Requests' }],
  [404, { message: 'Not Found' }],
  [403, { message: 'Forbidden by WAF' }],
  [408, { error: 'invalid_grant' }], // a dead-grant code on a non-400/401 status is not trusted
  [400, { error: 'unsupported_grant_type_typo' }],
]) {
  test(`refresh ${status} ${JSON.stringify(body)}: transient — no signed-out marker`, async () => {
    const stub = await startStub();
    stub.tokenStatus = status;
    stub.tokenErrorBody = body;
    const dir = makeStateDir();
    seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000 });
    const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
    try {
      const r = await usableBearer(env);
      assert.deepEqual([r.token, r.reason], [null, 'token-expired']);
      assert.equal(existsSync(join(dir, 'signed-out.json')), false, 'not a dead grant → not signed out');
      assert.equal(r.error instanceof TokenRefreshError && r.error.transient, true);
      assert.equal(r.error.status, status);
    } finally {
      await stub.close();
    }
  });
}

for (const [status, code] of [
  [400, 'invalid_grant'],
  [401, 'invalid_client'],
  [400, 'unauthorized_client'],
  [400, 'invalid_request'],
]) {
  test(`refresh ${status} ${code}: a dead grant — signed-out marker written`, async () => {
    const stub = await startStub();
    stub.tokenStatus = status;
    stub.tokenErrorBody = { error: code };
    const dir = makeStateDir();
    seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000 });
    const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
    try {
      const r = await usableBearer(env);
      assert.deepEqual([r.token, r.reason], [null, 'signed-out']);
      assert.ok(existsSync(join(dir, 'signed-out.json')));
    } finally {
      await stub.close();
    }
  });
}

// ── adv-6: the signed-out marker is bound to the credential it describes ────

test('a rejected refresh error carries the fingerprint of the refresh token it used', async () => {
  const { credentialFingerprint } = await import('../scripts/lib/governance.mjs');
  const stub = await startStub();
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, refreshToken: 'refresh-old' });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  try {
    await assert.rejects(refreshAuthState(env), (err) => {
      assert.equal(err.credentialFp, credentialFingerprint({ refreshToken: 'refresh-old' }));
      return true;
    });
  } finally {
    await stub.close();
  }
});

test('writeSignedOut for a credential that login already replaced writes nothing and posts no notice', async () => {
  const { writeSignedOut, credentialFingerprint, takeNotices } = await import('../scripts/lib/governance.mjs');
  const dir = makeStateDir();
  seedAuth(dir, { issuer: DEFAULT_ISSUER, refreshToken: 'refresh-new' }); // /noblecloak-login just saved this
  const env = { NOBLECLOAK_STATE_DIR: dir };
  writeSignedOut('invalid_grant', env, { credentialFp: credentialFingerprint({ refreshToken: 'refresh-old' }) });
  assert.equal(existsSync(join(dir, 'signed-out.json')), false);
  assert.deepEqual(takeNotices('s', env), []);
});

test('a marker written for a replaced credential is ignored and removed; the new token is used', async () => {
  const { writeSignedOut, readSignedOut } = await import('../scripts/lib/governance.mjs');
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  seedAuth(dir, { issuer: DEFAULT_ISSUER, accessToken: 'old-access', refreshToken: 'refresh-old' });
  writeSignedOut('invalid_grant', env); // bound to the current (old) credential
  assert.ok(readSignedOut(env), 'bound to the credential on disk → honoured');
  // Login completes after the marker was written (its clearSignedOut lost the race).
  seedAuth(dir, { issuer: DEFAULT_ISSUER, accessToken: 'new-access', refreshToken: 'refresh-new' });
  assert.equal(readSignedOut(env), null);
  assert.equal(existsSync(join(dir, 'signed-out.json')), false, 'the stale marker is deleted');
  const r = await usableBearer(env);
  assert.equal(r.token, 'new-access');
});

test('a legacy marker without a fingerprint is still honoured', async () => {
  const { readSignedOut } = await import('../scripts/lib/governance.mjs');
  const dir = makeStateDir();
  seedAuth(dir, { issuer: DEFAULT_ISSUER });
  writeFileSync(join(dir, 'signed-out.json'), JSON.stringify({ since: 'x', reason: 'invalid_grant', checkedAt: Date.now() }));
  assert.ok(readSignedOut({ NOBLECLOAK_STATE_DIR: dir }));
});

// ── adv-2: a transient refresh failure backs off instead of retrying per call ─

test('expired token + transient refresh failure: 20 emits cost one grant, not twenty', async () => {
  const { cooCallsSuspended } = await import('../scripts/lib/governance.mjs');
  const stub = await startStub();
  stub.tokenStatus = 503;
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000 });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_COO_URL: stub.url };
  try {
    for (let i = 0; i < 20; i += 1) assert.equal(await emitAuditEvent({ id: `e${i}:pre`, subject: 's' }, env), EMIT_SPILLED);
    assert.equal(grants(stub).length, 1);
    assert.equal(stub.requests.filter((r) => r.path === '/.well-known/oauth-authorization-server').length <= 1, true);
    assert.equal(eventPosts(stub).length, 0);
    assert.equal(existsSync(join(dir, 'signed-out.json')), false, 'transient is not signed out');
    assert.equal(cooCallsSuspended(env), true, 'the drain skips while the refresh is backing off');
  } finally {
    await stub.close();
  }
});

test('the refresh backoff expires, and a success clears it', async () => {
  const { cooCallsSuspended } = await import('../scripts/lib/governance.mjs');
  const stub = await startStub();
  stub.tokenStatus = 503;
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000 });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_REFRESH_BACKOFF_MS: '1000' };
  try {
    assert.equal((await usableBearer(env)).reason, 'token-expired');
    assert.equal((await usableBearer(env)).reason, 'token-expired');
    assert.equal(grants(stub).length, 1, 'inside the backoff → no grant');
    stub.tokenStatus = 200;
    const later = await usableBearer(env, { now: () => Date.now() + 1_500 });
    assert.equal(later.token, 'refreshed-token', 'backoff elapsed → refreshed');
    assert.equal(grants(stub).length, 2);
    assert.equal(existsSync(join(dir, 'refresh-backoff.json')), false, 'a success clears the backoff');
    assert.equal(cooCallsSuspended(env), false);
  } finally {
    await stub.close();
  }
});

test('a refresh backoff for a replaced credential is ignored', async () => {
  const stub = await startStub();
  stub.tokenStatus = 503;
  const dir = makeStateDir();
  seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000, refreshToken: 'refresh-old' });
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_ISSUER: stub.url };
  try {
    await usableBearer(env);
    assert.equal(grants(stub).length, 1);
    seedAuth(dir, { issuer: stub.url, expiresAt: Date.now() - 60_000, refreshToken: 'refresh-new' });
    stub.tokenStatus = 200;
    assert.equal((await usableBearer(env)).token, 'refreshed-token');
    assert.equal(grants(stub).length, 2);
  } finally {
    await stub.close();
  }
});
