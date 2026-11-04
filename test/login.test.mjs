/**
 * scripts/login.mjs end to end, headless: NOBLECLOAK_NO_BROWSER=1 prints the
 * authorize URL instead of opening a browser, the test plays the browser by
 * calling the callback, and a local stub is the authorization server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIRST_SIGN_IN_NOTE } from '../scripts/lib/governance.mjs';
import { makeStateDir, startStub, REPO_ROOT } from './helpers.mjs';

const LOGIN_PATH = join(REPO_ROOT, 'scripts', 'login.mjs');

const jwt = (claims) =>
  [{ alg: 'none' }, claims].map((x) => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.') + '.sig';

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A stub AS that advertises DCR and issues an org-bound token. */
async function asStub() {
  const stub = await startStub();
  stub.discoveryDoc = {
    issuer: stub.url,
    authorization_endpoint: `${stub.url}/auth/oauth/authorize`,
    token_endpoint: `${stub.url}/auth/oauth/token`,
    registration_endpoint: `${stub.url}/auth/oauth/register`,
  };
  stub.tokenResponse = { access_token: jwt({ sub: 'user-1', org_id: 'org-1' }), refresh_token: 'r-1', expires_in: 3600 };
  return stub;
}

async function loginEnv(stub, extra = {}) {
  const dir = makeStateDir();
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    NOBLECLOAK_STATE_DIR: dir,
    NOBLECLOAK_ISSUER: stub.url,
    NOBLECLOAK_COO_URL: stub.url,
    NOBLECLOAK_MCP_FILE: join(dir, 'absent-mcp.json'),
    NOBLECLOAK_REDIRECT_PORT: String(port),
    NOBLECLOAK_NO_BROWSER: '1',
    ...extra,
  };
  return { dir, env, port };
}

/** Run login.mjs, answer the callback with a code and the state it sent, and wait for it to exit. */
async function runLogin(env, args = []) {
  const child = spawn(process.execPath, [LOGIN_PATH, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  child.stderr.on('data', (d) => (stderr += d));
  const authUrl = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      stdout += d;
      const m = stdout.match(/visit: (\S+)/);
      if (m) resolve(new URL(m[1]));
    });
    child.on('close', () => reject(new Error(`exited before printing the URL: ${stdout}${stderr}`)));
  });
  await fetch(`http://127.0.0.1:${env.NOBLECLOAK_REDIRECT_PORT}/callback?code=abc&state=${authUrl.searchParams.get('state')}`);
  return { authUrl, result: await done };
}

test('login prints the first-sign-in note before it opens the browser', async () => {
  const stub = await asStub();
  const { env } = await loginEnv(stub);
  try {
    const { result } = await runLogin(env);
    assert.equal(result.code, 0, result.stderr);
    const note = result.stdout.indexOf(FIRST_SIGN_IN_NOTE);
    assert.ok(note >= 0, `the note is printed: ${result.stdout}`);
    assert.ok(note < result.stdout.indexOf('Opening browser'), 'before the browser is opened');
  } finally {
    await stub.close();
  }
});

test('adv-1: a client.json registered at another authorization server is replaced, and auth.json records the issuer', async () => {
  const stub = await asStub();
  const { dir, env, port } = await loginEnv(stub);
  writeFileSync(
    join(dir, 'client.json'),
    JSON.stringify({ clientId: 'client-registered-at-beta-AS', redirectUri: `http://localhost:${port}/callback` })
  );
  try {
    const { authUrl, result } = await runLogin(env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/register').length, 1, 'registered again');
    assert.equal(authUrl.searchParams.get('client_id'), 'dcr-generated-id');
    const client = JSON.parse(readFileSync(join(dir, 'client.json'), 'utf-8'));
    assert.equal(client.registrationEndpoint, `${stub.url}/auth/oauth/register`);
    const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8'));
    assert.equal(auth.issuer, stub.url);
  } finally {
    await stub.close();
  }
});

test('adv-2: with only NOBLECLOAK_ISSUER set, the connection registration goes to that issuer, not the default host', async () => {
  const stub = await asStub();
  const { env } = await loginEnv(stub);
  assert.equal(env.NOBLECLOAK_API_URL, undefined, 'precondition: no API URL override');
  try {
    const { result } = await runLogin(env);
    assert.equal(result.code, 0, result.stderr);
    const regs = stub.requests.filter((r) => r.method === 'POST' && r.path === '/mcp/connections');
    assert.equal(regs.length, 1, `registration reached the configured issuer: ${result.stderr}`);
    assert.equal(regs[0].headers.authorization, `Bearer ${stub.tokenResponse.access_token}`);
    assert.doesNotMatch(result.stderr, /api\.noblecloak\.com/);
  } finally {
    await stub.close();
  }
});

test('login-hint: no argument leaves login_hint off the authorize URL', async () => {
  const stub = await asStub();
  try {
    const { env } = await loginEnv(stub);
    const { authUrl, result } = await runLogin(env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(authUrl.searchParams.has('login_hint'), false);
    assert.equal(authUrl.search.includes('login_hint'), false);
  } finally {
    await stub.close();
  }
});

test('login-hint: a blank argument (the quoted empty $ARGUMENTS) is treated as no argument', async () => {
  const stub = await asStub();
  try {
    const { env } = await loginEnv(stub);
    const { authUrl, result } = await runLogin(env, ['']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(authUrl.searchParams.has('login_hint'), false);
  } finally {
    await stub.close();
  }
});

test('login-hint: the command template single-quotes $ARGUMENTS so the shell cannot interpret it', () => {
  const md = readFileSync(join(REPO_ROOT, 'commands', 'noblecloak-login.md'), 'utf-8');
  assert.ok(md.includes("scripts/login.mjs '$ARGUMENTS'"));
});

test('login-hint: a valid email is sent as login_hint exactly', async () => {
  const stub = await asStub();
  try {
    const { env } = await loginEnv(stub);
    const { authUrl, result } = await runLogin(env, ['Alice@NobleCloak.com']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(authUrl.searchParams.get('login_hint'), 'Alice@NobleCloak.com');
  } finally {
    await stub.close();
  }
});

for (const bad of ['not-an-email', '@x.com', 'a@', 'a b@x.com', 'a@b@c.com', 'a@x']) {
  test(`login-hint: ${JSON.stringify(bad)} exits 2 with a usage line and no browser or network call`, async () => {
    const stub = await asStub();
    try {
      const { env } = await loginEnv(stub);
      const child = spawn(process.execPath, [LOGIN_PATH, bad], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const code = await new Promise((resolve) => child.on('close', resolve));
      assert.equal(code, 2, out);
      assert.match(out, /^Usage: \/noblecloak-login \[you@yourcompany\.com\]\n$/);
      assert.equal(stub.requests?.length ?? 0, 0, 'no request reached the stub');
      assert.equal(out.includes('Opening browser'), false);
    } finally {
      await stub.close();
    }
  });
}

test('login-hint: an invalid argument exits before migrateLegacyState moves any state', async () => {
  const stub = await asStub();
  try {
    const { dir, env } = await loginEnv(stub);
    // No NOBLECLOAK_STATE_DIR, so the migration is live: HOME is a scratch dir and
    // NOBLECLOAK_MIGRATE_FROM holds an auth.json that a run would move into it.
    const legacy = join(dir, 'legacy');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'auth.json'), '{}');
    const home = join(dir, 'home');
    mkdirSync(home);
    const { NOBLECLOAK_STATE_DIR, ...rest } = env;
    const child = spawn(process.execPath, [LOGIN_PATH, 'nope'], {
      env: { ...rest, HOME: home, NOBLECLOAK_MIGRATE_FROM: legacy },
      stdio: 'ignore',
    });
    assert.equal(await new Promise((resolve) => child.on('close', resolve)), 2);
    assert.equal(existsSync(join(home, '.noblecloak')), false, 'nothing was migrated into HOME');
    assert.equal(existsSync(join(legacy, 'auth.json')), true, 'the legacy auth.json is untouched');
  } finally {
    await stub.close();
  }
});

test('login-hint: more than one argument exits 2', async () => {
  const stub = await asStub();
  try {
    const { env } = await loginEnv(stub);
    const child = spawn(process.execPath, [LOGIN_PATH, 'a@x.com', 'b@x.com'], { env, stdio: 'ignore' });
    assert.equal(await new Promise((resolve) => child.on('close', resolve)), 2);
  } finally {
    await stub.close();
  }
});
