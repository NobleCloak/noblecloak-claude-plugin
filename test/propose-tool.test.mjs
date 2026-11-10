/**
 * scripts/propose-tool.mjs against a local fake façade (the stub's
 * POST /v1/approvals). @noblecloak/spec's nc-mock is not a dependency of this
 * plugin, so the façade is the shared stub in helpers.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeStateDir, runScript, startStub, PROPOSE_TOOL_PATH, REPO_ROOT } from './helpers.mjs';

const GOVERN_TOKEN = {
  accessToken: 'gv-token',
  refreshToken: 'gv-refresh',
  expiresAt: Date.now() + 3_600_000,
};
const GOOD_ARGS = ['--tool-ref', 'mcp__acme__send', '--level', 'external', '--policy', 'ask'];

/** An unsigned JWT with the given claims (the plugin only decodes, never verifies). */
const jwt = (claims) =>
  ['none', claims].map((x) => Buffer.from(JSON.stringify(x === 'none' ? { alg: 'none' } : x)).toString('base64url')).join('.') + '.sig';

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A signed-in state dir; `govern` seeds tokens[stub.url]. */
function setup(stub, { govern = GOVERN_TOKEN, session = true, extraEnv = {} } = {}) {
  const dir = makeStateDir();
  if (session) {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        issuer: stub.url,
        accessToken: 'gw-token',
        refreshToken: 'gw-refresh',
        expiresAt: Date.now() + 3_600_000,
        ...(govern ? { tokens: { [stub.url]: govern } } : {}),
      })
    );
  }
  const env = {
    NOBLECLOAK_STATE_DIR: dir,
    NOBLECLOAK_ISSUER: stub.url,
    NOBLECLOAK_GOVERN_URL: stub.url,
    NOBLECLOAK_MCP_FILE: join(dir, 'absent-mcp.json'),
    NOBLECLOAK_CLIENT_ID: 'test-client',
    NOBLECLOAK_NO_BROWSER: '1',
    ...extraEnv,
  };
  return { dir, env };
}

const run = (env, args = GOOD_ARGS) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROPOSE_TOOL_PATH, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

const approvals = (stub) => stub.requests.filter((r) => r.path === '/v1/approvals');

test('happy path: id and the no-link approval line, one POST /v1/approvals with the proposal and an mcp_held continuation', async () => {
  const stub = await startStub();
  const { env } = setup(stub);
  try {
    const r = await run(env, [...GOOD_ARGS, '--description', 'send mail', '--owner', 'principal', '--show-arguments']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Approval opened: apr_test_1\nApprove it in the NobleCloak approvals module.\n');
    assert.deepEqual(stub.requests.map((q) => `${q.method} ${q.path}`), ['GET /v1/capabilities', 'POST /v1/approvals']);
    const [req] = approvals(stub);
    assert.equal(req.headers.authorization, 'Bearer gv-token');
    assert.equal(req.headers['idempotency-key'], undefined, 'replay safety is the server-side equal-proposal 200, not a random key');
    assert.deepEqual(req.body, {
      action: {
        tool_ref: 'tool:noblecloak:set-tool-policy',
        arguments: {
          tool_ref: 'mcp__acme__send',
          side_effect_level: 'external',
          policy: 'ask',
          description: 'send mail',
          owner_kind: 'principal',
          show_arguments_to_approvers: true,
        },
      },
      continuation: {
        kind: 'mcp_held',
        delivery: 'held',
        correlation: { surface: 'noblecloak-claude-plugin', tool_ref: 'mcp__acme__send' },
      },
    });
  } finally {
    await stub.close();
  }
});

test('NOBLECLOAK_APPROVALS_URL set → one "Approve it at <url>" line', async () => {
  const stub = await startStub();
  const { env } = setup(stub, { extraEnv: { NOBLECLOAK_APPROVALS_URL: 'https://approvals.example.test' } });
  try {
    const r = await run(env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Approval opened: apr_test_1\nApprove it at https://approvals.example.test\n');
  } finally {
    await stub.close();
  }
});

test('200 (an equal proposal is already open) → "already open", exit 0', async () => {
  const stub = await startStub();
  stub.approvalsResponse = { status: 200, body: { data: { id: 'apr_existing', created: false }, meta: {} } };
  const { env } = setup(stub);
  try {
    const r = await run(env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Approval already open: apr_existing\n/);
  } finally {
    await stub.close();
  }
});

test('--file supplies the proposal, flags override it, --schema loads input_schema', async () => {
  const stub = await startStub();
  const { dir, env } = setup(stub);
  writeFileSync(join(dir, 'p.json'), JSON.stringify({ tool_ref: 'from-file', side_effect_level: 'read', policy: 'deny' }));
  writeFileSync(join(dir, 's.json'), JSON.stringify({ type: 'object', required: ['x'] }));
  try {
    const r = await run(env, ['--file', join(dir, 'p.json'), '--policy', 'always_allow', '--schema', join(dir, 's.json')]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(approvals(stub)[0].body.action.arguments, {
      tool_ref: 'from-file',
      side_effect_level: 'read',
      policy: 'always_allow',
      input_schema: { type: 'object', required: ['x'] },
    });
  } finally {
    await stub.close();
  }
});

test('a noblecloak-proposal-*.json scratch file is deleted after reading; other --file paths are kept', async () => {
  const stub = await startStub();
  const { dir, env } = setup(stub);
  const body = JSON.stringify({ tool_ref: 'scratch', side_effect_level: 'read', policy: 'ask' });
  // The command writes scratch files into the OS temp directory; only there is the name single-use.
  const scratchDir = mkdtempSync(join(tmpdir(), 'p2-scratch-'));
  const scratch = join(scratchDir, 'noblecloak-proposal-abc123.json');
  const kept = join(dir, 'p.json');
  writeFileSync(scratch, body);
  writeFileSync(kept, body);
  try {
    // The child sees the OS temp directory through TMPDIR (the test env is built from scratch).
    const tmpEnv = { ...env, TMPDIR: tmpdir() };
    assert.equal((await run(tmpEnv, ['--file', scratch])).code, 0);
    assert.equal(existsSync(scratch), false, 'scratch file removed');
    // A scratch-like NAME outside the OS temp directory is the caller's file: never deleted.
    const outside = mkdtempSync(join(process.cwd(), '.p2-outside-'));
    const lookalike = join(outside, 'noblecloak-proposal-zzz.json');
    writeFileSync(lookalike, body);
    try {
      assert.equal((await run(tmpEnv, ['--file', lookalike])).code, 0);
      assert.equal(existsSync(lookalike), true, 'a look-alike outside tmpdir is kept');
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(scratchDir, { recursive: true, force: true });
    }
    assert.equal((await run(env, ['--file', kept])).code, 0);
    assert.equal(existsSync(kept), true, 'caller-owned file kept');
  } finally {
    await stub.close();
  }
});

for (const [name, args, code] of [
  ['reserved namespace', ['--tool-ref', 'tool:noblecloak:x', '--level', 'read', '--policy', 'ask'], 'reserved_tool_ref'],
  ['bad level', ['--tool-ref', 'a', '--level', 'nuke', '--policy', 'ask'], 'invalid_request'],
  ['missing policy', ['--tool-ref', 'a', '--level', 'read'], 'invalid_request'],
  ['bad owner', [...GOOD_ARGS, '--owner', 'everyone'], 'invalid_request'],
]) {
  test(`local validation refuses (${name}) → exit 2 with the code, no network`, async () => {
    const stub = await startStub();
    const { env } = setup(stub);
    try {
      const r = await run(env, args);
      assert.equal(r.code, 2);
      assert.match(r.stderr, new RegExp(`Refused: ${code}`));
      assert.equal(stub.requests.length, 0);
    } finally {
      await stub.close();
    }
  });
}

test('unknown flag → exit 2 with usage', async () => {
  const stub = await startStub();
  const { env } = setup(stub);
  try {
    const r = await run(env, [...GOOD_ARGS, '--bogus']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Usage:/);
  } finally {
    await stub.close();
  }
});

for (const [status, type] of [
  [422, 'reserved_tool_ref'],
  [400, 'invalid_request'],
  [409, 'continuation_conflict'],
  [413, 'payload_too_large'],
  [422, 'side_effect_level_downgrade'],
]) {
  test(`deployment refusal ${status} ${type} → exit 2, problem code printed`, async () => {
    const stub = await startStub();
    stub.approvalsResponse = {
      status,
      contentType: 'application/problem+json',
      body: { type: `https://docs.noblecloak.com/problems/${type}`, title: 't', status, detail: 'because' },
    };
    const { env } = setup(stub);
    try {
      const r = await run(env);
      assert.equal(r.code, 2);
      assert.match(r.stderr, new RegExp(`Refused: ${type} — because`));
      assert.equal(r.stdout, '');
    } finally {
      await stub.close();
    }
  });
}

for (const type of ['approval_unroutable', 'continuation_unsupported', 'invalid_continuation']) {
  test(`422 ${type} describes the deployment → exit 1, not a refusal`, async () => {
    const stub = await startStub();
    stub.approvalsResponse = {
      status: 422,
      contentType: 'application/problem+json',
      body: { type: `https://docs.noblecloak.com/problems/${type}`, title: 't', status: 422, detail: 'because' },
    };
    const { env } = setup(stub);
    try {
      const r = await run(env);
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`cannot route this proposal \\(${type}\\)`));
      assert.doesNotMatch(r.stderr, /Refused/);
    } finally {
      await stub.close();
    }
  });
}

test('401 from the API → exit 3', async () => {
  const stub = await startStub();
  stub.approvalsResponse = {
    status: 401,
    contentType: 'application/problem+json',
    body: { type: 'https://docs.noblecloak.com/problems/wrong_audience', status: 401 },
  };
  const { env } = setup(stub);
  try {
    const r = await run(env);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /wrong_audience/);
  } finally {
    await stub.close();
  }
});

test('5xx → exit 1 (not a refusal, not a sign-in problem)', async () => {
  const stub = await startStub();
  stub.approvalsResponse = { status: 503, body: { type: 'https://docs.noblecloak.com/problems/service_unavailable' } };
  const { env } = setup(stub);
  try {
    const r = await run(env);
    assert.equal(r.code, 1);
  } finally {
    await stub.close();
  }
});

test('no session at all → exit 3 pointing at /noblecloak-login, no network', async () => {
  const stub = await startStub();
  const { env } = setup(stub, { session: false });
  try {
    const r = await run(env);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /noblecloak-login/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test('expired govern token → refresh grant (with resource) first, the POST carries the refreshed token', async () => {
  const stub = await startStub();
  const { env } = setup(stub, { govern: { ...GOVERN_TOKEN, expiresAt: Date.now() - 1000 } });
  try {
    const r = await run(env);
    assert.equal(r.code, 0, r.stderr);
    const grants = stub.requests.filter((q) => q.path === '/auth/oauth/token');
    assert.equal(grants.length, 1);
    assert.equal(new URLSearchParams(grants[0].rawBody).get('resource'), stub.url);
    // D-A84: the refresh grant carries no scope, so it cannot widen the token.
    assert.equal(new URLSearchParams(grants[0].rawBody).has('scope'), false);
    assert.doesNotMatch(grants[0].rawBody, /approvals/i);
    assert.equal(approvals(stub)[0].headers.authorization, 'Bearer refreshed-token');
  } finally {
    await stub.close();
  }
});

/** Drive the sign-in: read the printed authorize URL, hit the loopback callback. */
async function signIn(env, callbackQuery) {
  const child = spawn(process.execPath, [PROPOSE_TOOL_PATH, ...GOOD_ARGS], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  const authUrl = await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => {
      stdout += d;
      const m = stdout.match(/visit: (\S+)/);
      if (m) resolve(new URL(m[1]));
    });
    child.on('close', () => reject(new Error(`exited before printing the URL: ${stdout}${stderr}`)));
  });
  const q = typeof callbackQuery === 'function' ? await callbackQuery(authUrl) : callbackQuery;
  await fetch(`http://127.0.0.1:${env.NOBLECLOAK_REDIRECT_PORT}/callback?${q}`);
  return { authUrl, result: await done };
}

test('no govern token → PKCE sign-in with resource=govern; token stored beside the gateway token; then the POST', async () => {
  const stub = await startStub();
  stub.tokenResponse = { access_token: jwt({ aud: stub.url, org_id: 'org-1' }), refresh_token: 'gv-new-r', expires_in: 3600 };
  const port = await freePort();
  const { dir, env } = setup(stub, { govern: null, extraEnv: { NOBLECLOAK_REDIRECT_PORT: String(port) } });
  try {
    const { authUrl, result } = await signIn(env, (u) => `code=abc&state=${u.searchParams.get('state')}`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(authUrl.searchParams.get('resource'), stub.url);
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authUrl.searchParams.get('client_id'), 'test-client');
    const grants = stub.requests.filter((q) => q.path === '/auth/oauth/token');
    assert.equal(grants.length, 1);
    const form = new URLSearchParams(grants[0].rawBody);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('resource'), stub.url);
    assert.ok(form.get('code_verifier'));
    assert.equal(approvals(stub)[0].headers.authorization, `Bearer ${stub.tokenResponse.access_token}`);
    const onDisk = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8'));
    assert.equal(onDisk.accessToken, 'gw-token', 'gateway token untouched');
    assert.equal(onDisk.tokens[stub.url].accessToken, stub.tokenResponse.access_token);
    assert.equal(onDisk.tokens[stub.url].orgId, 'org-1');
    assert.match(result.stdout, /Approval opened: apr_test_1/);
  } finally {
    await stub.close();
  }
});

// D-A84: the plugin's govern token must never be able to resolve
// approvals. Core issues `approvals:resolve` only when requested, so the
// guarantee is that no request this plugin builds ever names it.
test('D-A84: the govern sign-in asks for "mcp offline_access" only; no request carries an approvals: scope', async () => {
  const stub = await startStub();
  stub.tokenResponse = { access_token: jwt({ aud: stub.url, org_id: 'org-1' }), refresh_token: 'gv-new-r', expires_in: 3600 };
  const port = await freePort();
  const { env } = setup(stub, { govern: null, extraEnv: { NOBLECLOAK_REDIRECT_PORT: String(port) } });
  try {
    const { authUrl, result } = await signIn(env, (u) => `code=abc&state=${u.searchParams.get('state')}`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(authUrl.searchParams.get('scope'), 'mcp offline_access');
    assert.doesNotMatch(authUrl.toString(), /approvals/);
    assert.ok(stub.requests.some((q) => q.path === '/auth/oauth/token'), 'a token request was made');
    for (const q of stub.requests) {
      assert.doesNotMatch(q.rawBody ?? '', /approvals(:|%3A)/i, `${q.path} request body must not name an approvals: scope`);
    }
  } finally {
    await stub.close();
  }
});

test('D-A84: no plugin script or command names an approvals: scope', () => {
  for (const dir of ['scripts', 'commands']) {
    const walk = (d) =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]
      );
    for (const f of walk(join(REPO_ROOT, dir))) {
      assert.doesNotMatch(readFileSync(f, 'utf-8'), /approvals:/, `${f} must not request an approvals: scope`);
    }
  }
});

test('sign-in denied at the consent screen → exit 3, no proposal sent', async () => {
  const stub = await startStub();
  const port = await freePort();
  const { env } = setup(stub, { govern: null, extraEnv: { NOBLECLOAK_REDIRECT_PORT: String(port) } });
  try {
    const { result } = await signIn(env, (u) => `error=access_denied&error_description=denied&state=${u.searchParams.get('state')}`);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /denied/);
    assert.equal(approvals(stub).length, 0);
  } finally {
    await stub.close();
  }
});

test('the script reaches no catalog/tools route (only the approvals open and the capabilities read, plus auth)', () => {
  for (const f of ['scripts/propose-tool.mjs', 'scripts/lib/proposal.mjs', 'scripts/lib/pkce-flow.mjs']) {
    const src = readFileSync(join(REPO_ROOT, f), 'utf-8');
    assert.doesNotMatch(src, /\/v1\/tools|\/catalog|tools\/list|\/v1\/coo\//, `${f} must not call a catalog/tools route`);
  }
  const src = readFileSync(join(REPO_ROOT, 'scripts/propose-tool.mjs'), 'utf-8');
  const routes = [...src.matchAll(/\/v1\/[a-z/]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(routes)], ['/v1/approvals', '/v1/capabilities']);
});

test('401 drops the stored govern token (the gateway token stays), so a re-run signs in afresh', async () => {
  const stub = await startStub();
  stub.approvalsResponse = {
    status: 401,
    contentType: 'application/problem+json',
    body: { type: 'https://docs.noblecloak.com/problems/wrong_audience', status: 401 },
  };
  const { dir, env } = setup(stub);
  try {
    const r = await run(env);
    assert.equal(r.code, 3);
    const onDisk = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8'));
    assert.equal(onDisk.accessToken, 'gw-token');
    assert.equal(onDisk.tokens?.[stub.url], undefined, 'govern token must be gone');
  } finally {
    await stub.close();
  }
});

for (const [name, claims] of [
  ['a gateway-audience token (AS ignored resource)', { aud: 'https://mcp.example.test' }],
  ['no aud claim', { org_id: 'o' }],
  ['an opaque token', null],
]) {
  test(`sign-in rejects ${name}: exit 1, nothing stored, no proposal sent`, async () => {
    const stub = await startStub();
    stub.tokenResponse = { access_token: claims ? jwt(claims) : 'opaque', refresh_token: 'r', expires_in: 3600 };
    const port = await freePort();
    const { dir, env } = setup(stub, { govern: null, extraEnv: { NOBLECLOAK_REDIRECT_PORT: String(port) } });
    try {
      const { result } = await signIn(env, (u) => `code=abc&state=${u.searchParams.get('state')}`);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /audience/);
      assert.equal(approvals(stub).length, 0);
      assert.equal(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8')).tokens, undefined);
    } finally {
      await stub.close();
    }
  });
}

const EXPIRED = { ...GOVERN_TOKEN, expiresAt: Date.now() - 1000 };

test('expired govern token + transient refresh failure (5xx) → exit 1, no sign-in, token kept', async () => {
  const stub = await startStub();
  stub.tokenStatus = 503;
  const { dir, env } = setup(stub, { govern: EXPIRED });
  try {
    const r = await run(env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Token refresh failed \(503/);
    assert.doesNotMatch(r.stdout, /visit:/, 'no consent flow started');
    assert.equal(approvals(stub).length, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8')).tokens[stub.url].refreshToken, 'gv-refresh');
  } finally {
    await stub.close();
  }
});

test('expired govern token + rejected grant (invalid_grant) → falls through to a fresh sign-in', async () => {
  const stub = await startStub();
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const port = await freePort();
  const { env } = setup(stub, { govern: EXPIRED, extraEnv: { NOBLECLOAK_REDIRECT_PORT: String(port) } });
  try {
    const { authUrl, result } = await signIn(env, (u) => `error=access_denied&state=${u.searchParams.get('state')}`);
    assert.equal(authUrl.searchParams.get('resource'), stub.url);
    assert.equal(result.code, 3);
  } finally {
    await stub.close();
  }
});

test('callback port already in use → exit 1 (an infrastructure failure, not "not signed in")', async () => {
  const stub = await startStub();
  const blocker = createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { env } = setup(stub, { govern: null, extraEnv: { NOBLECLOAK_REDIRECT_PORT: String(blocker.address().port) } });
  try {
    const r = await run(env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /callback port/);
    assert.doesNotMatch(r.stderr, /Not signed in/);
  } finally {
    blocker.close();
    await stub.close();
  }
});

for (const [status, type, re] of [
  [403, 'forbidden', /Access denied \(forbidden\)/],
  [429, 'rate_limited', /retry later \(429\)/],
  [408, 'timeout', /retry later \(408\)/],
  [404, 'not_found', /Unexpected response.*404/],
]) {
  test(`${status} ${type} is not a proposal refusal → exit 1`, async () => {
    const stub = await startStub();
    stub.approvalsResponse = {
      status,
      contentType: 'application/problem+json',
      body: { type: `https://docs.noblecloak.com/problems/${type}`, status },
    };
    const { dir, env } = setup(stub);
    try {
      const r = await run(env);
      assert.equal(r.code, 1);
      assert.match(r.stderr, re);
      assert.doesNotMatch(r.stderr, /Refused/);
      assert.ok(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8')).tokens[stub.url], 'token kept');
    } finally {
      await stub.close();
    }
  });
}

test('a stray /callback request (wrong state) is ignored with 400; the real callback still completes the sign-in', async () => {
  const stub = await startStub();
  stub.tokenResponse = { access_token: jwt({ aud: stub.url }), refresh_token: 'r', expires_in: 3600 };
  const port = await freePort();
  const { env } = setup(stub, { govern: null, extraEnv: { NOBLECLOAK_REDIRECT_PORT: String(port) } });
  try {
    const { result } = await signIn(env, async (u) => {
      const stray = await fetch(`http://127.0.0.1:${port}/callback?state=bogus&code=x`);
      assert.equal(stray.status, 400);
      return `code=abc&state=${u.searchParams.get('state')}`;
    });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await stub.close();
  }
});

test('govern origin equal to the gateway origin → exit 1 config error, no network', async () => {
  const stub = await startStub();
  const { env } = setup(stub, { extraEnv: { NOBLECLOAK_MCP_RESOURCE: stub.url } });
  try {
    const r = await run(env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /equals the MCP gateway origin/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test('a persisted client from another authorization server is never replaced here (only /noblecloak-login does) → exit 1, client.json untouched', async () => {
  const stub = await startStub();
  stub.discoveryDoc = {
    issuer: stub.url,
    authorization_endpoint: `${stub.url}/auth/oauth/authorize`,
    token_endpoint: `${stub.url}/auth/oauth/token`,
    registration_endpoint: `${stub.url}/auth/oauth/register`,
  };
  const port = await freePort();
  const { dir, env } = setup(stub, { govern: null, extraEnv: { NOBLECLOAK_REDIRECT_PORT: String(port) } });
  delete env.NOBLECLOAK_CLIENT_ID;
  const persisted = JSON.stringify({
    clientId: 'beta-client',
    redirectUri: `http://localhost:${port}/callback`,
    registrationEndpoint: 'https://auth.beta.example/auth/oauth/register',
  });
  writeFileSync(join(dir, 'client.json'), persisted);
  try {
    const r = await run(env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /belongs to another authorization server/);
    assert.equal(stub.requests.filter((q) => q.path === '/auth/oauth/register').length, 0);
    assert.equal(readFileSync(join(dir, 'client.json'), 'utf-8'), persisted);
  } finally {
    await stub.close();
  }
});

test('a redirect port that differs from the persisted client never re-registers (it would orphan the gateway refresh) → exit 1, client.json untouched', async () => {
  const stub = await startStub();
  const port = await freePort();
  const { dir, env } = setup(stub, { govern: null, extraEnv: { NOBLECLOAK_REDIRECT_PORT: String(port) } });
  delete env.NOBLECLOAK_CLIENT_ID;
  const persisted = JSON.stringify({ clientId: 'login-client', redirectUri: 'http://localhost:19284/callback' });
  writeFileSync(join(dir, 'client.json'), persisted);
  try {
    const r = await run(env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /registered OAuth client/);
    assert.equal(stub.requests.filter((q) => q.path === '/auth/oauth/register').length, 0);
    assert.equal(readFileSync(join(dir, 'client.json'), 'utf-8'), persisted);
  } finally {
    await stub.close();
  }
});

// Contract rev 17: Capabilities.continuation_kinds (absent = the seven rev-16 kinds, mcp_held among them).
const withCaps = async (capabilitiesResponse) => {
  const stub = await startStub();
  stub.capabilitiesResponse = capabilitiesResponse;
  return { stub, ...setup(stub) };
};
const callsOf = (stub) => stub.requests.filter((q) => q.path === '/v1/capabilities' || q.path === '/v1/approvals').map((q) => `${q.method} ${q.path}`);

test('continuation_kinds absent → proceeds and POSTs', async () => {
  const { stub, env } = await withCaps({ status: 200, body: { data: { deployment: 'hosted' }, meta: {} } });
  try {
    const r = await run(env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(callsOf(stub), ['GET /v1/capabilities', 'POST /v1/approvals']);
    assert.equal(stub.requests.find((q) => q.path === '/v1/capabilities').headers.authorization, 'Bearer gv-token');
  } finally {
    await stub.close();
  }
});

test('continuation_kinds lists mcp_held → proceeds and POSTs', async () => {
  const { stub, env } = await withCaps({ status: 200, body: { data: { continuation_kinds: ['adk', 'mcp_held', 'claude_agent_sdk'] }, meta: {} } });
  try {
    const r = await run(env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(callsOf(stub), ['GET /v1/capabilities', 'POST /v1/approvals']);
  } finally {
    await stub.close();
  }
});

test('continuation_kinds lists kinds without mcp_held → exit 1, deployment-blaming message, no POST', async () => {
  const { stub, env } = await withCaps({ status: 200, body: { data: { continuation_kinds: ['adk', 'webhook'] }, meta: {} } });
  try {
    const r = await run(env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Refused before sending:.*\(adk, webhook\) without mcp_held.*400 invalid_request/);
    assert.deepEqual(callsOf(stub), ['GET /v1/capabilities']);
  } finally {
    await stub.close();
  }
});

for (const [name, resp] of [
  ['404', { status: 404, body: { type: 'https://docs.noblecloak.com/problems/not_found' } }],
  ['500', { status: 500, body: {} }],
  ['non-2xx that still carries a list without mcp_held', { status: 503, body: { data: { continuation_kinds: ['adk'] } } }],
  ['non-JSON 200', { status: 200, rawBody: 'not json' }],
]) {
  test(`capabilities ${name} → fails open, POST proceeds`, async () => {
    const { stub, env } = await withCaps(resp);
    try {
      const r = await run(env);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(callsOf(stub), ['GET /v1/capabilities', 'POST /v1/approvals']);
    } finally {
      await stub.close();
    }
  });
}

test('capabilities unreachable path (hangs past the timeout) → fails open', async () => {
  const stub = await startStub();
  stub.hangPaths = ['/v1/capabilities'];
  const { env } = setup(stub);
  try {
    const r = await run(env);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await stub.close();
  }
});

test('a redirect on the capabilities GET is not followed: fails open, the other host is never asked', async () => {
  const other = await startStub();
  other.capabilitiesResponse = { status: 200, body: { data: { continuation_kinds: ['adk'] } } };
  const stub = await startStub();
  stub.capabilitiesResponse = { redirectTo: `${other.url}/v1/capabilities` };
  const { env } = setup(stub);
  try {
    const r = await run(env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(callsOf(stub), ['GET /v1/capabilities', 'POST /v1/approvals']);
    assert.deepEqual(other.requests, []);
  } finally {
    await stub.close();
    await other.close();
  }
});
