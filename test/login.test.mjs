/**
 * scripts/login.mjs end to end, headless: NOBLECLOAK_NO_BROWSER=1 prints the
 * authorize URL instead of opening a browser, the test plays the browser by
 * calling the callback, and a local stub is the authorization server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
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
async function runLogin(env) {
  const child = spawn(process.execPath, [LOGIN_PATH], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
