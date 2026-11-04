/** scripts/lib/service-principal.mjs and `setup.mjs service-principal`: inputs, guards, the exact CLI invocation, failure mapping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adminAudience,
  buildCliArgs,
  CLI_VERSION,
  insideGitWorkTree,
  mapCliFailure,
  parseCliJson,
  resolveServicePrincipalInputs,
  runServicePrincipal,
  slugify,
} from '../scripts/lib/service-principal.mjs';
import { makeStateDir, REPO_ROOT } from './helpers.mjs';

const ORG = '11111111-2222-3333-4444-555555555555';
const AUTH = 'https://auth.noblecloak.com';
const PRIVATE_D = 'SECRET-PRIVATE-KEY-D-VALUE';
const mkTmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function jwt(claims) {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

/** An env with a signed-in session for ORG on the production issuer. */
function session({ claims = { sub: 'u1', org_id: ORG }, extra = {}, issuer = 'https://api.noblecloak.com' } = {}) {
  const state = makeStateDir();
  writeFileSync(join(state, 'auth.json'), JSON.stringify({ issuer, accessToken: jwt(claims), refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
  return {
    NOBLECLOAK_STATE_DIR: state,
    NOBLECLOAK_ISSUER: issuer,
    NOBLECLOAK_MCP_FILE: join(state, 'absent.json'),
    NOBLECLOAK_GOVERN_URL: 'https://govern.noblecloak.com',
    ...extra,
  };
}

const discover = async () => ({ issuer: `${AUTH}/` });
const inputsOf = (over = {}) => ({ env: session(), cwd: mkTmp('sp-proj-'), home: mkTmp('sp-home-'), discover, ...over });

test('defaults: name is the project directory + " agent", out is ~/.noblecloak/<org>/<slug>.json, values come from the session and deployment', async () => {
  const base = mkTmp('sp-base-');
  const cwd = join(base, 'My Cool App');
  mkdirSync(cwd);
  const home = mkTmp('sp-home-');
  const got = await resolveServicePrincipalInputs(inputsOf({ cwd, home }));
  assert.equal(got.name, 'My Cool App agent');
  assert.equal(got.out, join(home, '.noblecloak', ORG, 'my-cool-app-agent.json'));
  assert.deepEqual(
    [got.orgId, got.authUrl, got.governAudience, got.adminAudience, got.expiresInDays],
    [ORG, AUTH, 'https://govern.noblecloak.com', 'https://admin-api.noblecloak.com', undefined]
  );
  assert.equal(slugify('!!!'), 'agent');
});

test('flags: --name, --out and --expires-in-days are honoured; bad days refused', async () => {
  const home = mkTmp('sp-home-');
  const out = join(mkTmp('sp-out-'), 'cred.json');
  const got = await resolveServicePrincipalInputs(inputsOf({ home, flags: { name: 'ci', out, 'expires-in-days': '30' } }));
  assert.deepEqual([got.name, got.out, got.expiresInDays], ['ci', out, 30]);
  for (const bad of ['0', '366', '1.5', 'x']) {
    await assert.rejects(resolveServicePrincipalInputs(inputsOf({ flags: { 'expires-in-days': bad } })), /1 to 365/, bad);
  }
});

test('refuses when not signed in (exit 3) or the session has no org id', async () => {
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ env: { NOBLECLOAK_STATE_DIR: makeStateDir(), NOBLECLOAK_ISSUER: 'https://api.noblecloak.com' } })), (e) => e.exit === 3);
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ env: session({ claims: { sub: 'u1' } }) })), /no organization id/);
});

test('session claims: an organizations entry with a non-admin role refuses (exit 4); admin or absent proceeds', async () => {
  const orgs = (role) => ({ sub: 'u', org_id: ORG, organizations: [{ id: ORG, role }] });
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ env: session({ claims: orgs('member') }) })), (e) => e.exit === 4 && /not an administrator/.test(e.message));
  assert.equal((await resolveServicePrincipalInputs(inputsOf({ env: session({ claims: orgs('admin') }) }))).orgId, ORG);
  assert.equal((await resolveServicePrincipalInputs(inputsOf())).orgId, ORG); // no claim: the deployment decides
});

test('refuses an --out inside a git work tree, including a not-yet-created subdirectory, but not one outside', async () => {
  const repo = mkTmp('sp-repo-');
  mkdirSync(join(repo, '.git'));
  for (const out of [join(repo, 'cred.json'), join(repo, 'a', 'b', 'cred.json')]) {
    await assert.rejects(resolveServicePrincipalInputs(inputsOf({ flags: { out } })), /inside a git work tree/, out);
  }
  assert.equal(insideGitWorkTree(join(mkTmp('sp-clean-'), 'x.json')), false);
  // the default path is guarded too (a home directory that is a repository)
  const home = mkTmp('sp-home-');
  mkdirSync(join(home, '.git'));
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ home })), /inside a git work tree/);
});

test('refuses an existing --out path (file or dangling symlink)', async () => {
  const dir = mkTmp('sp-out-');
  const file = join(dir, 'exists.json');
  writeFileSync(file, '{}');
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ flags: { out: file } })), /already exists/);
  const { symlinkSync } = await import('node:fs');
  const link = join(dir, 'dangling.json');
  symlinkSync(join(dir, 'nowhere'), link);
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ flags: { out: link } })), /already exists/);
});

test('admin audience: production table, env override wins, unknown deployment refuses naming the variable', async () => {
  assert.equal(adminAudience(AUTH, {}), 'https://admin-api.noblecloak.com');
  assert.equal(adminAudience(`${AUTH}/`, {}), 'https://admin-api.noblecloak.com');
  assert.equal(adminAudience(AUTH, { NOBLECLOAK_ADMIN_AUDIENCE: ' https://admin.example.test ' }), 'https://admin.example.test');
  assert.equal(adminAudience('https://auth.other.test', { NOBLECLOAK_ADMIN_AUDIENCE: 'https://x.test' }), 'https://x.test');
  assert.throws(() => adminAudience('https://auth.other.test', {}), /NOBLECLOAK_ADMIN_AUDIENCE/);
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ discover: async () => ({ issuer: 'https://auth.other.test' }) })), /NOBLECLOAK_ADMIN_AUDIENCE/);
});

test('discovery failure and a missing govern origin refuse clearly', async () => {
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ discover: async () => { throw new Error('boom'); } })), /metadata: boom/);
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ discover: async () => ({}) })), /no issuer/);
  const env = session({ extra: { NOBLECLOAK_GOVERN_URL: '' } });
  await assert.rejects(resolveServicePrincipalInputs(inputsOf({ env })), /NOBLECLOAK_GOVERN_URL/);
});

test('the CLI invocation is built exactly, with the pinned version', () => {
  const inputs = { orgId: ORG, name: 'my agent', governAudience: 'https://govern.noblecloak.com', out: '/o/c.json', authUrl: AUTH, adminAudience: 'https://admin-api.noblecloak.com' };
  assert.equal(CLI_VERSION, '0.1.2');
  assert.deepEqual(buildCliArgs(inputs), [
    '-y', '@noblecloak/cli@0.1.2', 'sp', 'create', '--org', ORG, '--name', 'my agent', '--audience', 'https://govern.noblecloak.com',
    '--out', '/o/c.json', '--auth-url', AUTH, '--admin-audience', 'https://admin-api.noblecloak.com', '--json',
  ]);
  assert.deepEqual(buildCliArgs({ ...inputs, expiresInDays: 7 }).slice(-3), ['--expires-in-days', '7', '--json']);
});

test('parseCliJson takes the last JSON object and ignores noise', () => {
  assert.deepEqual(parseCliJson('noise\n{"sp_id":"a"}\n'), { sp_id: 'a' });
  assert.deepEqual(parseCliJson('{\n  "sp_id": "b"\n}\n'), { sp_id: 'b' });
  assert.equal(parseCliJson('not json'), null);
  assert.equal(parseCliJson('[1]'), null);
});

function cliJson(over = {}) {
  return JSON.stringify({ client_id: 'sp_x', sp_id: 'sp-uuid-1', org_id: ORG, name: 'n', audiences: [], scopes: [], expires_at: 'z', path: '/cred/path.json', private_jwk: { d: PRIVATE_D }, ...over });
}

async function runWith(result, flags = {}) {
  const calls = [];
  const logs = [];
  const printed = [];
  const code = await runServicePrincipal({
    flags,
    env: session(),
    cwd: mkTmp('sp-proj-'),
    home: mkTmp('sp-home-'),
    discover,
    run: async (args, opts) => (calls.push({ args, opts }), result),
    log: (m) => logs.push(m),
    print: (m) => printed.push(m),
  });
  return { code, calls, logs, printed };
}

test('success: spawns npx once with the built args, prints sp_id, path and the three env lines, never the key', async () => {
  const { code, calls, logs, printed } = await runWith({ status: 0, stdout: `${cliJson()}\n`, stderr: '' });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], '@noblecloak/cli@0.1.2');
  assert.ok(calls[0].args.includes('--json'));
  const text = printed.join('\n');
  assert.match(text, /^Service principal created: sp-uuid-1$/m);
  assert.match(text, /^NOBLECLOAK_SP_CREDENTIALS=\/cred\/path\.json$/m);
  assert.match(text, /^NC_EXPECTED_PRINCIPAL=sp-uuid-1$/m);
  assert.match(text, /^NC_BASE_URL=https:\/\/govern\.noblecloak\.com$/m);
  assert.doesNotMatch(text + logs.join('\n'), new RegExp(PRIVATE_D));
  assert.doesNotMatch(text, /private_jwk/);
});

test('success without a path in the JSON falls back to the --out it asked for', async () => {
  const out = join(mkTmp('sp-out-'), 'c.json');
  const { printed } = await runWith({ status: 0, stdout: cliJson({ path: undefined }) }, { out });
  assert.match(printed.join('\n'), new RegExp(`NOBLECLOAK_SP_CREDENTIALS=${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

const ROUTING_404 = 'error: The server answered 404 UNKNOWN: no message\n';

test('the CLI line for a deployment that does not serve the routes says so, and exits non-zero', async () => {
  const { code, logs, printed } = await runWith({ status: 1, stdout: '', stderr: ROUTING_404 });
  assert.equal(code, 1);
  assert.match(logs.join('\n'), /did not serve the service-principal routes on the authorization server's origin/);
  assert.equal(printed.length, 0);
});

test('other 404s and "not found" text are not reported as a routing problem', () => {
  const routing = /did not serve the service-principal routes/;
  const npm = 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@noblecloak%2fcli\n';
  const json = 'error: The server answered 404 NOT_FOUND: organization not found\n';
  for (const stderr of [npm, json, 'error: the callback path 404 was not found']) {
    assert.doesNotMatch(mapCliFailure({ status: 1, stderr }).message, routing, stderr);
  }
  // the routing line only counts at exit 1
  assert.doesNotMatch(mapCliFailure({ status: 3, stderr: ROUTING_404 }).message, routing);
  // exit 3 / 4 keep their own code and message when stderr says "not found"
  const notFound = 'error: administrator not found\n';
  assert.equal(mapCliFailure({ status: 3, stderr: notFound }).exit, 3);
  assert.equal(mapCliFailure({ status: 4, stderr: notFound }).exit, 4);
  assert.match(mapCliFailure({ status: 4, stderr: notFound }).message, /not an administrator/);
  // a post-create network failure whose hint mentions a 404 in a name or path
  const hint = 'error: could not write /home/u/.noblecloak/404/x.json\n';
  assert.equal(mapCliFailure({ status: 1, stderr: hint }).exit, 1);
  assert.doesNotMatch(mapCliFailure({ status: 1, stderr: hint }).message, routing);
});

test('other CLI failures map by exit code; success with no sp_id is a failure', async () => {
  assert.equal(mapCliFailure({ status: 3, stderr: '' }).exit, 3);
  assert.equal(mapCliFailure({ status: 4, stderr: '' }).exit, 4);
  assert.match(mapCliFailure({ status: 4, stderr: '' }).message, /not an administrator/);
  assert.equal(mapCliFailure({ status: 2, stderr: '' }).exit, 2);
  assert.equal(mapCliFailure({ status: 1, stderr: 'x' }).exit, 1);
  const missing = await runWith({ status: 0, stdout: '{"path":"/p"}' });
  assert.equal(missing.code, 1);
  assert.equal(missing.printed.length, 0);
  const spawnFail = await runWith({ status: null, error: new Error('ENOENT') });
  assert.equal(spawnFail.code, 1);
  assert.match(spawnFail.logs.join('\n'), /Could not run npx: ENOENT/);
});

test('a refused input never spawns the CLI', async () => {
  const repo = mkTmp('sp-repo-');
  mkdirSync(join(repo, '.git'));
  const { code, calls } = await runWith({ status: 0, stdout: cliJson() }, { out: join(repo, 'c.json') });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
});

test('the real entry point: bad flag exits 2, no session exits 3, with no network', async () => {
  const run = (args, env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'setup.mjs'), 'service-principal', ...args], { env: { PATH: process.env.PATH, ...env } });
      let err = '';
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (status) => resolve({ status, err }));
    });
  assert.equal((await run(['--bogus'], {})).status, 2);
  const none = await run([], { NOBLECLOAK_STATE_DIR: makeStateDir(), HOME: mkTmp('sp-h-') });
  assert.equal(none.status, 3);
  assert.match(none.err, /Not signed in/);
});
