/**
 * scripts/setup.mjs: project detection, the package source (the registry by default, or a directory of tarballs),
 * and the token hand-off to the langgraph skill's propose.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectProject, runDetect, runPropose } from '../scripts/setup.mjs';
import { makeStateDir, REPO_ROOT, startStub } from './helpers.mjs';

const SETUP_PATH = join(REPO_ROOT, 'scripts', 'setup.mjs');
const mkTmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** A project directory with the given package.json deps and directories. */
function makeProject({ deps = {}, dirs = [] } = {}) {
  const dir = mkTmp('setup-project-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: deps }));
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

const NEXT_APP = { deps: { next: '16.0.0', react: '19.0.0' }, dirs: ['app'] };
const LANGGRAPH = { deps: { '@langchain/langgraph': '1.0.0' } };

// ── detection ────────────────────────────────────────────────────────────────

test('detection: next plus app/ or src/app/ is a module project', () => {
  for (const dirs of [['app'], [join('src', 'app')]]) {
    const dir = makeProject({ deps: NEXT_APP.deps, dirs });
    assert.deepEqual([detectProject(dir).module, detectProject(dir).langgraph], [true, false], dirs.join());
  }
});

test('detection: next without an App Router directory is not a module project', () => {
  const dir = makeProject({ deps: NEXT_APP.deps, dirs: ['pages'] });
  assert.equal(detectProject(dir).module, false);
  // app/ without next is not one either.
  assert.equal(detectProject(makeProject({ deps: {}, dirs: ['app'] })).module, false);
});

test('detection: @langchain/langgraph or langchain is a langgraph project', () => {
  assert.equal(detectProject(makeProject(LANGGRAPH)).langgraph, true);
  assert.equal(detectProject(makeProject({ deps: { langchain: '1.0.0' } })).langgraph, true);
  assert.equal(detectProject(makeProject({ deps: { '@langchain/core': '1.0.0' } })).langgraph, false);
});

test('detection: a dependency in devDependencies counts; no package.json is neither', () => {
  const dir = mkTmp('setup-project-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { langchain: '1' } }));
  assert.equal(detectProject(dir).langgraph, true);
  const empty = mkTmp('setup-project-');
  const d = detectProject(empty);
  assert.deepEqual([d.module, d.langgraph], [false, false]);
});

test('detection: neither prints no candidates and exits 2 without resolving a source', () => {
  const out = runDetect({ project: makeProject({ deps: { express: '5' } }) });
  assert.equal(out.exit, 2);
  assert.deepEqual(out.found, []);
  assert.match(out.lines.join('\n'), /No setup skill applies/);
});

// ── package source ───────────────────────────────────────────────────────────

test('runDetect: --source <dir> skips the download and is checked for the tarballs', () => {
  const dir = mkTmp('own-source-');
  writeFileSync(join(dir, 'noblecloak-langgraph-1.0.0.tgz'), 'x');
  writeFileSync(join(dir, 'noblecloak-client-1.0.0.tgz'), 'x');
  const out = runDetect({ project: makeProject(LANGGRAPH), source: dir, acceptVersionDrift: true });
  assert.equal(out.exit, 0);
  assert.equal(out.source, dir);
  const module = runDetect({ project: makeProject(NEXT_APP), source: dir, acceptVersionDrift: true });
  assert.equal(module.exit, 4, 'module skills need react and theme tarballs, which the directory lacks');
});

test('runDetect: a package version that differs from the one the skills were written against prints a WARNING', () => {
  const dir = mkTmp('own-source-');
  // A langgraph version the skills were not written against (the lock pins a real release, never 0.0.1).
  writeFileSync(join(dir, 'noblecloak-langgraph-0.0.1.tgz'), 'x');
  const locked = JSON.parse(readFileSync(join(REPO_ROOT, 'setup-skills', 'SKILLS.lock'), 'utf-8')).packages;
  writeFileSync(join(dir, `noblecloak-client-${locked.client}.tgz`), 'x');
  writeFileSync(join(dir, 'noblecloak-react-9.9.9.tgz'), 'x');
  const out = runDetect({ project: makeProject(LANGGRAPH), source: dir, env: {} });
  const text = out.lines.join('\n');
  assert.equal(out.exit, 5, 'a mismatch stops the run until the builder accepts it');
  assert.match(text, /--accept-version-drift/);
  const accepted = runDetect({ project: makeProject(LANGGRAPH), source: dir, env: {}, acceptVersionDrift: true });
  assert.equal(accepted.exit, 0, 'accepted drift runs, and still warns');
  assert.match(accepted.lines.join('\n'), /WARNING/);
  assert.doesNotMatch(accepted.lines.join('\n'), /Exit 5/);
  assert.ok(text.includes(`WARNING: the bundled skills were written against @noblecloak/langgraph ${locked.langgraph}, but the package source has 0.0.1.`), text);
  assert.equal(text.match(/WARNING/g).length, 1, 'client matches, and react is not a package this project needs');
});

test('runDetect: matching versions, and the registry source, print no WARNING and exit 0', () => {
  const locked = JSON.parse(readFileSync(join(REPO_ROOT, 'setup-skills', 'SKILLS.lock'), 'utf-8')).packages;
  const dir = mkTmp('own-source-');
  writeFileSync(join(dir, `noblecloak-langgraph-${locked.langgraph}.tgz`), 'x');
  writeFileSync(join(dir, `noblecloak-client-${locked.client}.tgz`), 'x');
  const same = runDetect({ project: makeProject(LANGGRAPH), source: dir, env: {} });
  assert.doesNotMatch(same.lines.join('\n'), /WARNING/);
  assert.equal(same.exit, 0);
  assert.doesNotMatch(runDetect({ project: makeProject(LANGGRAPH), source: 'registry', env: {} }).lines.join('\n'), /WARNING/);
});

test('runDetect: the registry is the default source, and --source registry says the same', () => {
  const byDefault = runDetect({ project: makeProject(NEXT_APP) });
  assert.equal(byDefault.exit, 0);
  assert.equal(byDefault.source, 'registry');
  assert.match(byDefault.lines.join('\n'), /Source: --source registry \(the public npm registry\)\./);
  assert.ok(byDefault.found.every((c) => c.runnable), 'every candidate runs from the registry');
  const explicit = runDetect({ project: makeProject(NEXT_APP), source: 'registry' });
  assert.equal(explicit.source, 'registry');
  assert.deepEqual(explicit.lines.slice(1), byDefault.lines.slice(1), 'the same output after the project line');
});

// ── token hand-off ───────────────────────────────────────────────────────────

const FAKE_PROPOSE = `const seen = { token: process.env.NC_PROPOSER_TOKEN ?? null, base: process.env.NC_BASE_URL ?? null, approvals: process.env.NOBLECLOAK_APPROVALS_URL ?? null, argv: process.argv.slice(2) };
console.log('SEEN ' + JSON.stringify(seen));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

function fakeSkillsDir() {
  const dir = mkTmp('fake-skills-');
  mkdirSync(join(dir, 'noblecloak-setup-langgraph', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'noblecloak-setup-langgraph', 'scripts', 'propose.mjs'), FAKE_PROPOSE);
  return dir;
}

async function runSetup(args, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SETUP_PATH, ...args], { env: { PATH: process.env.PATH, ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function proposeEnv(stub, { session = true } = {}) {
  const state = makeStateDir();
  if (session) {
    writeFileSync(
      join(state, 'auth.json'),
      JSON.stringify({
        accessToken: 'gw-token',
        refreshToken: 'gw-refresh',
        expiresAt: Date.now() + 3_600_000,
        tokens: { [stub.url]: { accessToken: 'gv-token', refreshToken: 'gv-refresh', expiresAt: Date.now() + 3_600_000 } },
      })
    );
  }
  return {
    state,
    env: {
      NOBLECLOAK_STATE_DIR: state,
      NOBLECLOAK_ISSUER: stub.url,
      NOBLECLOAK_GOVERN_URL: stub.url,
      NOBLECLOAK_MCP_FILE: join(state, 'absent-mcp.json'),
      NOBLECLOAK_CLIENT_ID: 'test-client',
      NOBLECLOAK_NO_BROWSER: '1',
      NOBLECLOAK_SETUP_SKILLS_DIR: fakeSkillsDir(),
    },
  };
}

const seenBy = (stdout) => JSON.parse(/^SEEN (.*)$/m.exec(stdout)[1]);

test('propose: the plugin govern token reaches the child by environment only, never argv, a file or stdout', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  const project = mkTmp('setup-cwd-');
  try {
    const r = await runSetup(['propose', '--plan', 'plan.json'], { env: { ...env, NC_BASE_URL: stub.url }, cwd: project });
    assert.equal(r.code, 0, r.stderr);
    const seen = seenBy(r.stdout);
    assert.equal(seen.token, 'gv-token');
    assert.equal(seen.base, stub.url);
    assert.deepEqual(seen.argv, ['--plan', 'plan.json']);
    assert.ok(!r.stdout.replace(/^SEEN .*$/m, '').includes('gv-token'));
    assert.ok(!r.stderr.includes('gv-token'));
    assert.deepEqual(readdirSync(project), [], 'nothing is written into the project');
  } finally {
    await stub.close();
  }
});

test('propose: an NC_PROPOSER_TOKEN in the caller environment is replaced by the plugin token', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  try {
    const r = await runSetup(['propose', '--plan', 'p.json'], { env: { ...env, NC_PROPOSER_TOKEN: 'stale', NC_BASE_URL: `${stub.url}/` }, cwd: mkTmp('setup-cwd-') });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seenBy(r.stdout).token, 'gv-token');
  } finally {
    await stub.close();
  }
});

test('propose: a destination other than the govern origin is refused before any token is minted (NC_BASE_URL, --base-url, --base-url=)', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  try {
    const cases = [
      [['--plan', 'p.json'], { NC_BASE_URL: 'https://api.example.test' }],
      [['--plan', 'p.json', '--base-url', 'https://evil.example.test'], { NC_BASE_URL: stub.url }],
      [['--plan', 'p.json', `--base-url=https://evil.example.test`], {}],
      [['--plan', 'p.json', '--base-url'], { NC_BASE_URL: stub.url }],
      [['--plan', 'p.json', '--base-url', 'not a url'], {}],
    ];
    for (const [args, extra] of cases) {
      const r = await runSetup(['propose', ...args], { env: { ...env, ...extra }, cwd: mkTmp('setup-cwd-') });
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /Refused|Set NC_BASE_URL/);
      assert.doesNotMatch(r.stdout, /SEEN/);
      assert.ok(!r.stderr.includes('gv-token'));
    }
    assert.deepEqual(stub.requests, [], 'no token was requested for a refused destination');
  } finally {
    await stub.close();
  }
});

test('propose: --base-url at the govern origin is accepted and no default NC_BASE_URL is supplied', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  try {
    const ok = await runSetup(['propose', '--plan', 'p.json', '--base-url', `${stub.url}/x`], { env, cwd: mkTmp('setup-cwd-') });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(seenBy(ok.stdout).base, null, 'the plugin does not set NC_BASE_URL');
    const none = await runSetup(['propose', '--plan', 'p.json'], { env, cwd: mkTmp('setup-cwd-') });
    assert.equal(none.code, 1);
    assert.match(none.stderr, /Set NC_BASE_URL/);
  } finally {
    await stub.close();
  }
});

test('propose --dry-run fetches no token and passes none on', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub, { session: false });
  try {
    const r = await runSetup(['propose', '--plan', 'p.json', '--dry-run'], { env: { ...env, NC_PROPOSER_TOKEN: 'stale' }, cwd: mkTmp('setup-cwd-') });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seenBy(r.stdout).token, null);
    assert.deepEqual(stub.requests, []);
  } finally {
    await stub.close();
  }
});

test('propose: not signed in exits 3 and never starts propose.mjs', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub, { session: false });
  try {
    const r = await runSetup(['propose', '--plan', 'p.json'], { env, cwd: mkTmp('setup-cwd-') });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /run \/noblecloak-login first/);
    assert.doesNotMatch(r.stdout, /SEEN/);
  } finally {
    await stub.close();
  }
});

test("propose: the child's exit code is the command's exit code", async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  try {
    const r = await runSetup(['propose', '--plan', 'p.json'], { env: { ...env, FAKE_EXIT: '2', NC_BASE_URL: stub.url }, cwd: mkTmp('setup-cwd-') });
    assert.equal(r.code, 2);
  } finally {
    await stub.close();
  }
});

const PROD_GOVERN = 'https://govern.noblecloak.com';

test('propose: the approvals address is filled for a known govern origin, and a caller-set one is kept', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  const seen = [];
  const run = (_cmd, _argv, options) => {
    seen.push(options.env.NOBLECLOAK_APPROVALS_URL);
    return { status: 0 };
  };
  try {
    const base = { ...env, NOBLECLOAK_GOVERN_URL: PROD_GOVERN, NC_BASE_URL: PROD_GOVERN };
    assert.equal(await runPropose({ args: ['--plan', 'p.json'], env: base, getToken: async () => 't', run }), 0);
    assert.equal(await runPropose({ args: ['--plan', 'p.json'], env: { ...base, NOBLECLOAK_APPROVALS_URL: 'https://mine.example.test/a' }, getToken: async () => 't', run }), 0);
    assert.deepEqual(seen, ['https://app.noblecloak.com/approvals', 'https://mine.example.test/a']);
  } finally {
    await stub.close();
  }
});

test('propose: the approvals address reaches the real child process', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  try {
    const r = await runSetup(['propose', '--plan', 'p.json'], { env: { ...env, NC_BASE_URL: stub.url, NOBLECLOAK_APPROVALS_URL: 'https://approvals.example.test' }, cwd: mkTmp('setup-cwd-') });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seenBy(r.stdout).approvals, 'https://approvals.example.test');
  } finally {
    await stub.close();
  }
});

test('propose: a govern origin equal to the MCP gateway origin is refused before any token is minted', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  try {
    const r = await runSetup(['propose', '--plan', 'p.json'], { env: { ...env, NOBLECLOAK_MCP_RESOURCE: stub.url, NC_BASE_URL: stub.url }, cwd: mkTmp('setup-cwd-') });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /equals the MCP gateway origin/);
    assert.doesNotMatch(r.stdout, /SEEN/);
    assert.deepEqual(stub.requests, []);
  } finally {
    await stub.close();
  }
});

const storedAuth = (state) => JSON.parse(readFileSync(join(state, 'auth.json'), 'utf-8'));

test('propose: a child exit 3 (token not accepted) drops the stored govern token; other exits keep it', async () => {
  const stub = await startStub();
  const { env, state } = proposeEnv(stub);
  try {
    const kept = await runSetup(['propose', '--plan', 'p.json'], { env: { ...env, FAKE_EXIT: '2', NC_BASE_URL: stub.url }, cwd: mkTmp('setup-cwd-') });
    assert.equal(kept.code, 2);
    assert.equal(storedAuth(state).tokens?.[stub.url]?.accessToken, 'gv-token', 'a refused plan is not a rejected token');

    const r = await runSetup(['propose', '--plan', 'p.json'], { env: { ...env, FAKE_EXIT: '3', NC_BASE_URL: stub.url }, cwd: mkTmp('setup-cwd-') });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /stored approvals token was cleared; re-run to sign in again/);
    const auth = storedAuth(state);
    assert.equal(auth.tokens?.[stub.url], undefined, 'the rejected govern token is gone');
    assert.equal(auth.accessToken, 'gw-token', 'the gateway session is kept');
  } finally {
    await stub.close();
  }
});

test('propose --dry-run exiting 3 drops nothing (no token was given)', async () => {
  const stub = await startStub();
  const { env, state } = proposeEnv(stub);
  try {
    const r = await runSetup(['propose', '--plan', 'p.json', '--dry-run'], { env: { ...env, FAKE_EXIT: '3' }, cwd: mkTmp('setup-cwd-') });
    assert.equal(r.code, 3);
    assert.equal(storedAuth(state).tokens?.[stub.url]?.accessToken, 'gv-token');
  } finally {
    await stub.close();
  }
});

test('runPropose does not put the token in this process environment', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  const parentEnv = { ...env };
  let childEnv;
  const code = await runPropose({
    args: ['--plan', 'p.json'],
    env: { ...parentEnv, NC_BASE_URL: stub.url },
    getToken: async () => 'minted-token',
    run: (_cmd, _argv, options) => {
      childEnv = options.env;
      return { status: 0 };
    },
  });
  try {
    assert.equal(code, 0);
    assert.equal(childEnv.NC_PROPOSER_TOKEN, 'minted-token');
    assert.equal(parentEnv.NC_PROPOSER_TOKEN, undefined);
    assert.equal(process.env.NC_PROPOSER_TOKEN, undefined);
    assert.equal(childEnv.NC_TOKEN, undefined, 'the command never writes NC_TOKEN');
  } finally {
    await stub.close();
  }
});

test('the bundled skills dir has the langgraph propose.mjs setup.mjs runs', () => {
  assert.ok(existsSync(join(REPO_ROOT, 'setup-skills', 'noblecloak-setup-langgraph', 'scripts', 'propose.mjs')));
});

test('the setup skills are outside the auto-discovered skills/ directory, so only /noblecloak-setup runs them', () => {
  const discovered = readdirSync(join(REPO_ROOT, 'skills'));
  assert.deepEqual(discovered.filter((name) => name.startsWith('noblecloak-setup-') || name === 'SKILLS.lock'), []);
  const out = runDetect({ project: makeProject(LANGGRAPH), source: 'registry', env: {} });
  const printed = join(REPO_ROOT, 'setup-skills', 'noblecloak-setup-langgraph', 'SKILL.md');
  assert.ok(out.lines.join('\n').includes(`langgraph (${printed})`), out.lines.join('\n'));
  assert.ok(existsSync(printed));
});

test('setup.mjs CLI: a version mismatch exits 5, --accept-version-drift exits 0', async () => {
  const dir = mkTmp('own-source-');
  writeFileSync(join(dir, 'noblecloak-langgraph-0.0.1.tgz'), 'x');
  writeFileSync(join(dir, 'noblecloak-client-0.0.1.tgz'), 'x');
  const project = makeProject(LANGGRAPH);
  const env = { NOBLECLOAK_STATE_DIR: makeStateDir() };
  const refused = await runSetup(['--project', project, '--source', dir], { env, cwd: project });
  assert.equal(refused.code, 5, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /WARNING/);
  const accepted = await runSetup(['--project', project, '--source', dir, '--accept-version-drift'], { env, cwd: project });
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
});
