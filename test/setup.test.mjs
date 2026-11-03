/**
 * scripts/setup.mjs: project detection, package-source resolution against a stubbed gh, and the token hand-off to
 * the langgraph skill's propose.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectProject, parseSums, releaseGroups, resolveReleaseSource as resolveFrom, runDetect, runPropose } from '../scripts/setup.mjs';
import { SOURCES } from '../scripts/sync-skills.mjs';
import { makeStateDir, REPO_ROOT, startStub } from './helpers.mjs';

/** Every package from one release repository: the shape these tests' single fake gh answers, whatever SOURCES says. */
const ONE_REPO = 'example/one-repo';
const ONE = { ...SOURCES, packages: Object.fromEntries(Object.entries(SOURCES.packages).map(([name, e]) => [name, { ...e, repo: ONE_REPO }])) };
const resolveReleaseSource = ({ env, sources = ONE }) => resolveFrom({ env, sources });

const SETUP_PATH = join(REPO_ROOT, 'scripts', 'setup.mjs');
const mkTmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const sha = (text) => createHash('sha256').update(text).digest('hex');

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
  const out = runDetect({
    project: makeProject({ deps: { express: '5' } }),
    resolveRelease: () => assert.fail('must not download for a project no skill applies to'),
  });
  assert.equal(out.exit, 2);
  assert.deepEqual(out.found, []);
  assert.match(out.lines.join('\n'), /No setup skill applies/);
});

// ── source resolution against a stubbed gh ───────────────────────────────────

/**
 * A fake gh. `releases` is [{tag, assets: {file: content}, sums?: string|null}], or { '<owner/name>': [...] } to
 * answer per `--repo`; `gh release list` prints the tags, `gh release download <tag> --dir D --pattern P...` copies the matching assets and the SUMS text.
 */
function makeFakeGh({ releases, fail = false }) {
  const root = mkTmp('fake-gh-');
  const shape = (list) =>
    list.map(({ tag, assets, sums }) => ({
      tag,
      assets: { ...assets, ...(sums === null ? {} : { SHA256SUMS: sums ?? Object.entries(assets).map(([f, c]) => `${sha(c)}  ${f}`).join('\n') + '\n' }) },
    }));
  const data = Array.isArray(releases) ? shape(releases) : Object.fromEntries(Object.entries(releases).map(([repo, list]) => [repo, shape(list)]));
  writeFileSync(join(root, 'data.json'), JSON.stringify(data));
  const bin = join(root, 'gh');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, 'calls.log'))}, JSON.stringify(args) + '\\n');
const all = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'data.json'))}, 'utf8'));
const data = Array.isArray(all) ? all : all[args[args.indexOf('--repo') + 1]] || [];
if (${JSON.stringify(fail)}) { console.error('HTTP 401: bad credentials'); process.exit(1); }
const flag = (n) => args[args.indexOf(n) + 1];
if (args[1] === 'list') { console.log(JSON.stringify(data.map((r) => ({ tagName: r.tag })))); process.exit(0); }
if (args[1] === 'download') {
  const release = data.find((r) => r.tag === args[2]);
  const patterns = args.flatMap((a, i) => (a === '--pattern' ? [args[i + 1]] : []));
  for (const [file, content] of Object.entries(release.assets)) {
    if (patterns.some((p) => new RegExp('^' + p.replace(/\\*/g, '.*') + '$').test(file))) fs.writeFileSync(path.join(flag('--dir'), file), content);
  }
  process.exit(0);
}
process.exit(9);
`
  );
  chmodSync(bin, 0o755);
  return { bin, root, calls: () => readFileSync(join(root, 'calls.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) };
}

const ASSETS = {
  'noblecloak-react-0.8.2.tgz': 'react',
  'noblecloak-client-0.10.0.tgz': 'client',
  'noblecloak-theme-0.1.1.tgz': 'theme',
  'noblecloak-langgraph-0.3.8.tgz': 'langgraph',
  'noblecloak-spec-0.9.0.tgz': 'spec',
};
/** gh is the fake; the package cache goes under a throwaway state dir, never the real ~/.noblecloak. */
const envFor = (gh, state = makeStateDir()) => ({ ...process.env, NOBLECLOAK_GH: gh.bin, NOBLECLOAK_STATE_DIR: state });
const cacheOf = (env) => join(env.NOBLECLOAK_STATE_DIR, 'packages');
const cacheEntries = (env) => (existsSync(cacheOf(env)) ? readdirSync(cacheOf(env)).sort() : []);

test('source: downloads every skill package of the latest spec-v* release into the per-tag cache, not a temp dir', () => {
  const gh = makeFakeGh({ releases: [{ tag: 'tools-v1', assets: {} }, { tag: 'spec-v0.9.0', assets: ASSETS }, { tag: 'spec-v0.8.0', assets: {} }] });
  const env = envFor(gh);
  const r = resolveReleaseSource({ env });
  assert.equal(r.tag, 'spec-v0.9.0');
  assert.equal(r.dir, join(cacheOf(env), 'spec-v0.9.0'));
  assert.deepEqual(r.packages.sort(), ['client', 'langgraph', 'react', 'theme']);
  assert.deepEqual(readdirSync(r.dir).sort(), [
    'SHA256SUMS',
    'noblecloak-client-0.10.0.tgz',
    'noblecloak-langgraph-0.3.8.tgz',
    'noblecloak-react-0.8.2.tgz',
    'noblecloak-theme-0.1.1.tgz',
  ]);
  assert.deepEqual(cacheEntries(env), ['spec-v0.9.0'], 'no staging directory is left');
  const download = gh.calls().find((c) => c[1] === 'download');
  assert.deepEqual(download.slice(0, 5), ['release', 'download', 'spec-v0.9.0', '--repo', ONE_REPO]);
  assert.deepEqual(download.filter((_, i) => download[i - 1] === '--pattern').sort(), [
    'SHA256SUMS',
    'noblecloak-client-*.tgz',
    'noblecloak-langgraph-*.tgz',
    'noblecloak-react-*.tgz',
    'noblecloak-theme-*.tgz',
  ]);
});

test('source: with no sources argument the download goes to every release repository SOURCES.packages names', () => {
  // The array-shaped fake answers for any --repo, so this holds under the private and the exported SOURCES alike.
  const gh = makeFakeGh({ releases: [{ tag: 'spec-v0.9.0', assets: ASSETS }] });
  const r = resolveFrom({ env: envFor(gh) });
  assert.deepEqual(r.packages.sort(), ['client', 'langgraph', 'react', 'theme']);
  const repos = gh.calls().filter((c) => c[1] === 'download').map((c) => c[c.indexOf('--repo') + 1]);
  assert.deepEqual([...new Set(repos)].sort(), [...new Set(Object.values(SOURCES.packages).map((e) => e.repo))].sort());
});

test('source: a re-run replaces the tag directory in place, at the same path', () => {
  const gh = makeFakeGh({ releases: [{ tag: 'spec-v0.9.0', assets: ASSETS }] });
  const env = envFor(gh);
  const first = resolveReleaseSource({ env });
  writeFileSync(join(first.dir, 'stale.tgz'), 'left from an earlier download');
  const second = resolveReleaseSource({ env });
  assert.equal(second.dir, first.dir, 'the path apply.mjs recorded stays valid');
  assert.ok(!existsSync(join(second.dir, 'stale.tgz')));
  assert.ok(existsSync(join(second.dir, 'noblecloak-client-0.10.0.tgz')));
});

test('source: a tarball that differs from SHA256SUMS fails, leaves no staging copy and keeps the earlier verified copy', () => {
  const env = envFor(makeFakeGh({ releases: [{ tag: 'spec-v0.9.0', assets: ASSETS }] }));
  const good = resolveReleaseSource({ env });
  const sums = `${sha('something else')}  noblecloak-client-0.10.0.tgz\n`;
  const bad = { ...env, NOBLECLOAK_GH: makeFakeGh({ releases: [{ tag: 'spec-v0.9.0', assets: ASSETS, sums }] }).bin };
  assert.throws(() => resolveReleaseSource({ env: bad }), /noblecloak-client-0\.10\.0\.tgz does not match release spec-v0\.9\.0's SHA256SUMS/);
  assert.deepEqual(cacheEntries(env), ['spec-v0.9.0']);
  assert.ok(existsSync(join(good.dir, 'noblecloak-client-0.10.0.tgz')), 'a failed download does not break projects using the earlier copy');
});

test('source: a tarball missing from SHA256SUMS, and a release without SHA256SUMS, both fail', () => {
  const unlisted = envFor(makeFakeGh({ releases: [{ tag: 'spec-v0.9.0', assets: ASSETS, sums: `${sha('react')}  noblecloak-react-0.8.2.tgz\n` }] }));
  assert.throws(() => resolveReleaseSource({ env: unlisted }), /not listed in release spec-v0\.9\.0's SHA256SUMS/);
  assert.deepEqual(cacheEntries(unlisted), []);
  const none = envFor(makeFakeGh({ releases: [{ tag: 'spec-v0.9.0', assets: ASSETS, sums: null }] }));
  assert.throws(() => resolveReleaseSource({ env: none }), /has no SHA256SUMS/);
  assert.deepEqual(cacheEntries(none), []);
});

test('source: gh failing, no spec-v* release, and a tag that is not a plain name, are errors', () => {
  assert.throws(() => resolveReleaseSource({ env: envFor(makeFakeGh({ releases: [], fail: true })) }), /bad credentials/);
  assert.throws(() => resolveReleaseSource({ env: envFor(makeFakeGh({ releases: [{ tag: 'tools-v1', assets: {} }] })) }), /no published spec-v\* release/);
  const odd = envFor(makeFakeGh({ releases: [{ tag: 'spec-v1/../../escape', assets: ASSETS }] }));
  assert.throws(() => resolveReleaseSource({ env: odd }), /no published spec-v\* release/);
  assert.deepEqual(cacheEntries(odd), []);
});

test('parseSums reads sha256sum text, text and binary markers', () => {
  const h = 'a'.repeat(64);
  assert.deepEqual(parseSums(`${h}  one.tgz\n${h} *two.tgz\nnot a line\n`), { 'one.tgz': h, 'two.tgz': h });
});

test('runDetect: a langgraph project whose release has no langgraph tarball is blocked with a clear message (exit 4)', () => {
  const gh = makeFakeGh({ releases: [{ tag: 'spec-v0.8.0', assets: { 'noblecloak-client-0.9.0.tgz': 'c', 'noblecloak-react-0.8.1.tgz': 'r' } }] });
  const env = envFor(gh);
  const out = runDetect({ project: makeProject(LANGGRAPH), env, resolveRelease: resolveReleaseSource });
  assert.equal(out.exit, 4);
  assert.match(out.lines.join('\n'), /BLOCKED langgraph: the package source has no noblecloak-langgraph-<version>\.tgz\. Stop and tell the builder/);
  // The cache is shared by projects: a module project may already point at this tag's react/client tarballs.
  assert.ok(existsSync(join(cacheOf(env), 'spec-v0.8.0', 'noblecloak-react-0.8.1.tgz')), 'a blocked run does not remove the cached release');
});

test('runDetect: both kinds, langgraph tarball present, asks the builder; module alone does not ask', () => {
  const gh = makeFakeGh({ releases: [{ tag: 'spec-v0.9.0', assets: ASSETS }] });
  const env = envFor(gh);
  const both = runDetect({ project: makeProject({ deps: { ...NEXT_APP.deps, ...LANGGRAPH.deps }, dirs: NEXT_APP.dirs }), env, acceptVersionDrift: true, resolveRelease: resolveReleaseSource });
  const modOnly = runDetect({ project: makeProject(NEXT_APP), env, acceptVersionDrift: true, resolveRelease: resolveReleaseSource });
  assert.equal(both.exit, 0);
  assert.match(both.lines.join('\n'), /Both kinds match: ask the builder/);
  assert.match(both.lines.join('\n'), /Candidate module: approvals \(.*noblecloak-setup-approvals.SKILL\.md\), permissions .*connections/);
  assert.equal(modOnly.exit, 0);
  assert.doesNotMatch(modOnly.lines.join('\n'), /ask the builder/);
  assert.ok(modOnly.lines.join('\n').includes(`--source ${join(cacheOf(env), 'spec-v0.9.0')} (release spec-v0.9.0, checksums verified`));
  assert.equal(modOnly.source, both.source, 'every project gets the same per-tag directory');
});

test('runDetect: --source <dir> skips the download and is checked for the tarballs', () => {
  const dir = mkTmp('own-source-');
  writeFileSync(join(dir, 'noblecloak-langgraph-1.0.0.tgz'), 'x');
  writeFileSync(join(dir, 'noblecloak-client-1.0.0.tgz'), 'x');
  const out = runDetect({ project: makeProject(LANGGRAPH), source: dir, acceptVersionDrift: true, resolveRelease: () => assert.fail('no download with --source') });
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

test('runDetect: --source registry passes through (the post-release default)', () => {
  const out = runDetect({ project: makeProject(NEXT_APP), source: 'registry', resolveRelease: () => assert.fail('no download') });
  assert.equal(out.exit, 0);
  assert.equal(out.source, 'registry');
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

const BETA_GOVERN = 'https://govern.beta.shared.bianoble.com';

test('propose: the approvals address is filled for a known govern origin, and a caller-set one is kept', async () => {
  const stub = await startStub();
  const { env } = proposeEnv(stub);
  const seen = [];
  const run = (_cmd, _argv, options) => {
    seen.push(options.env.NOBLECLOAK_APPROVALS_URL);
    return { status: 0 };
  };
  try {
    const base = { ...env, NOBLECLOAK_GOVERN_URL: BETA_GOVERN, NC_BASE_URL: BETA_GOVERN };
    assert.equal(await runPropose({ args: ['--plan', 'p.json'], env: base, getToken: async () => 't', run }), 0);
    assert.equal(await runPropose({ args: ['--plan', 'p.json'], env: { ...base, NOBLECLOAK_APPROVALS_URL: 'https://mine.example.test/a' }, getToken: async () => 't', run }), 0);
    assert.deepEqual(seen, ['https://shell.beta.shared.bianoble.com/approvals', 'https://mine.example.test/a']);
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

// ── packages drawn from two release repositories ─────────────────────────────

const SECOND = 'example/second-repo';
/** SOURCES with the langgraph tarball coming from a second repository. */
const SPLIT = { ...ONE, packages: { ...ONE.packages, langgraph: { repo: SECOND, dir: 'x' } } };

test('releaseGroups: one group per release repository, the packages each supplies', () => {
  assert.deepEqual(releaseGroups(['react', 'client', 'theme', 'langgraph'], ONE), [[ONE_REPO, ['react', 'client', 'theme', 'langgraph']]]);
  assert.deepEqual(releaseGroups(['react', 'client', 'theme', 'langgraph'], SPLIT), [
    [ONE_REPO, ['react', 'client', 'theme']],
    [SECOND, ['langgraph']],
  ].sort(([a], [b]) => (a < b ? -1 : 1)));
  // The default is SOURCES itself: every package is placed, in one or more groups.
  assert.deepEqual(releaseGroups().flatMap(([, names]) => names).sort(), ['client', 'langgraph', 'react', 'theme']);
  assert.throws(() => releaseGroups(['nope']), /no entry for nope/);
});

test('source: with packages in two repositories each tarball comes from its own repository\'s release, into one directory', () => {
  const main = ONE_REPO;
  const gh = makeFakeGh({
    releases: {
      [main]: [{ tag: 'spec-v0.9.0', assets: Object.fromEntries(Object.entries(ASSETS).filter(([, v]) => v !== 'langgraph')) }],
      [SECOND]: [{ tag: 'spec-v0.4.0', assets: { 'noblecloak-langgraph-0.3.8.tgz': 'langgraph', 'noblecloak-client-9.9.9.tgz': 'must not be taken' } }],
    },
  });
  const env = envFor(gh);
  const r = resolveReleaseSource({ env, sources: SPLIT });
  assert.deepEqual(r.packages.sort(), ['client', 'langgraph', 'react', 'theme']);
  assert.equal(r.tag, [...new Set([main, SECOND].sort().map((repo) => (repo === main ? 'spec-v0.9.0' : 'spec-v0.4.0')))].join('+'));
  assert.deepEqual(readdirSync(r.dir).sort(), [
    'SHA256SUMS',
    'noblecloak-client-0.10.0.tgz',
    'noblecloak-langgraph-0.3.8.tgz',
    'noblecloak-react-0.8.2.tgz',
    'noblecloak-theme-0.1.1.tgz',
  ], 'the second repository supplies only langgraph');
  const downloads = gh.calls().filter((c) => c[1] === 'download');
  assert.deepEqual(downloads.map((c) => [c[2], c[4]]).sort(), [['spec-v0.4.0', SECOND], ['spec-v0.9.0', main]].sort());
  const second = downloads.find((c) => c[4] === SECOND);
  assert.deepEqual(second.filter((_, i) => second[i - 1] === '--pattern').sort(), ['SHA256SUMS', 'noblecloak-langgraph-*.tgz']);
  assert.deepEqual(cacheEntries(env), [r.tag], 'no staging directory is left');
});

test('source: a tarball that fails its own repository\'s SHA256SUMS in a two-repository download fails the whole download', () => {
  const main = ONE_REPO;
  const gh = makeFakeGh({
    releases: {
      [main]: [{ tag: 'spec-v0.9.0', assets: Object.fromEntries(Object.entries(ASSETS).filter(([, v]) => v !== 'langgraph')) }],
      [SECOND]: [{ tag: 'spec-v0.4.0', assets: { 'noblecloak-langgraph-0.3.8.tgz': 'langgraph' }, sums: `${sha('other')}  noblecloak-langgraph-0.3.8.tgz\n` }],
    },
  });
  const env = envFor(gh);
  assert.throws(() => resolveReleaseSource({ env, sources: SPLIT }), /noblecloak-langgraph-0\.3\.8\.tgz does not match release spec-v0\.4\.0's SHA256SUMS/);
  assert.deepEqual(cacheEntries(env), [], 'nothing is left in the cache');
});

test('source: a repository without a spec-v* release is named in the error', () => {
  const main = ONE_REPO;
  const gh = makeFakeGh({ releases: { [main]: [{ tag: 'spec-v0.9.0', assets: ASSETS }], [SECOND]: [] } });
  assert.throws(() => resolveReleaseSource({ env: envFor(gh), sources: SPLIT }), new RegExp(`${SECOND} has no published spec-v\\* release`));
});
