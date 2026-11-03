/** scripts/sync-skills.mjs against a throwaway git repository standing in for noblecloak-ui. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DIR_PREFIX, hashBundledFiles, parsePerRepo, SKILL_NAMES, SOURCES, sync as syncWith } from '../scripts/sync-skills.mjs';
import { REPO_ROOT } from './helpers.mjs';

/**
 * SOURCES with every entry in one repository, so the fixtures below (one throwaway git repo) fit whichever
 * paths SOURCES holds: the private map's or the exported one's.
 */
const REPO = 'example/one-repo';
const ONE = {
  skills: Object.fromEntries(Object.entries(SOURCES.skills).map(([name, e]) => [name, { ...e, repo: REPO }])),
  packages: Object.fromEntries(Object.entries(SOURCES.packages).map(([name, e]) => [name, { ...e, repo: REPO }])),
};
const PACKAGE_DIRS = Object.fromEntries(Object.entries(ONE.packages).map(([name, { dir }]) => [name, dir]));
const skillPath = (name) => ONE.skills[name].path;
const sync = (opts) => syncWith({ sources: ONE, ...opts });

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A repo with each skill's {SKILL.md,scripts/apply.mjs} at its ONE path and the package.json files; returns { dir, sha }. */
function makeSourceRepo(tag = 'v1') {
  const dir = mkdtempSync(join(tmpdir(), 'ui-src-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 't');
  for (const name of SKILL_NAMES) {
    const skill = join(dir, skillPath(name));
    mkdirSync(join(skill, 'scripts'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${tag}\n`);
    writeFileSync(join(skill, 'scripts', 'apply.mjs'), `// ${name} ${tag}\n`);
  }
  for (const [name, pkgDir] of Object.entries(PACKAGE_DIRS)) {
    mkdirSync(join(dir, pkgDir), { recursive: true });
    writeFileSync(join(dir, pkgDir, 'package.json'), JSON.stringify({ name: `@noblecloak/${name}`, version: `1.${name.length}.0` }));
  }
  writeFileSync(join(dir, 'README.md'), 'not a skill');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', tag);
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}

const makeRoot = () => mkdtempSync(join(tmpdir(), 'plugin-root-'));

test('copies the four skills under a prefixed directory and writes the lock', () => {
  const src = makeSourceRepo();
  const root = makeRoot();
  try {
    const lock = sync({ sha: src.sha, clone: src.dir, root });
    for (const name of SKILL_NAMES) {
      const skill = readFileSync(join(root, 'setup-skills', `${DIR_PREFIX}${name}`, 'SKILL.md'), 'utf-8');
      assert.match(skill, new RegExp(`name: ${name}\\n`));
      assert.ok(existsSync(join(root, 'setup-skills', `${DIR_PREFIX}${name}`, 'scripts', 'apply.mjs')));
    }
    for (const name of SKILL_NAMES) assert.deepEqual(lock.skills[name], { repo: REPO, sha: src.sha, path: skillPath(name) });
    assert.deepEqual(lock.files, hashBundledFiles(root));
    assert.equal(Object.keys(lock.files).length, SKILL_NAMES.length * 2);
    assert.deepEqual(lock.packages, { react: '1.5.0', client: '1.6.0', theme: '1.5.0', langgraph: '1.9.0' }, 'the package versions at the pin');
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'setup-skills', 'SKILLS.lock'), 'utf-8')), lock);
  } finally {
    rmSync(src.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-syncing at a new pin replaces files and drops ones the source removed', () => {
  const src = makeSourceRepo('v1');
  const root = makeRoot();
  try {
    sync({ sha: src.sha, clone: src.dir, root });
    rmSync(join(src.dir, skillPath('langgraph'), 'scripts', 'apply.mjs'));
    writeFileSync(join(src.dir, skillPath('approvals'), 'SKILL.md'), '---\nname: approvals\n---\nv2\n');
    git(src.dir, 'add', '-A');
    git(src.dir, 'commit', '-q', '-m', 'v2');
    const next = git(src.dir, 'rev-parse', 'HEAD');
    const lock = sync({ sha: next, clone: src.dir, root });
    for (const name of SKILL_NAMES) assert.equal(lock.skills[name].sha, next);
    assert.ok(!existsSync(join(root, 'setup-skills', `${DIR_PREFIX}langgraph`, 'scripts', 'apply.mjs')));
    assert.match(readFileSync(join(root, 'setup-skills', `${DIR_PREFIX}approvals`, 'SKILL.md'), 'utf-8'), /v2/);
    assert.ok(!(`setup-skills/${DIR_PREFIX}langgraph/scripts/apply.mjs` in lock.files));
  } finally {
    rmSync(src.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a short sha, a branch name and a commit without the skills', () => {
  const src = makeSourceRepo();
  const root = makeRoot();
  try {
    assert.throws(() => sync({ sha: src.sha.slice(0, 8), clone: src.dir, root }), /full 40-hex/);
    assert.throws(() => sync({ sha: 'main', clone: src.dir, root }), /full 40-hex/);
    assert.throws(() => sync({ sha: '1'.repeat(40), clone: src.dir, root }), new RegExp(`clone ${src.dir} does not contain ${'1'.repeat(40)} \\(fetch first\\)`));
    rmSync(join(src.dir, skillPath('connections')), { recursive: true });
    git(src.dir, 'add', '-A');
    git(src.dir, 'commit', '-q', '-m', 'drop');
    assert.throws(() => sync({ sha: git(src.dir, 'rev-parse', 'HEAD'), clone: src.dir, root }), new RegExp(`has no ${skillPath('connections')}/SKILL.md`));
    assert.ok(!existsSync(join(root, 'setup-skills', 'SKILLS.lock')), 'a refused sync writes nothing');
  } finally {
    rmSync(src.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('without --clone the commit is read with gh api (GitHub tarball layout)', () => {
  const src = makeSourceRepo();
  const root = makeRoot();
  const bin = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  try {
    // A fake gh: records its args, prints a tarball with GitHub's single top-level directory.
    const fake = join(bin, 'gh');
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" > "${join(bin, 'args')}"\nexec git -C "${src.dir}" archive --format=tar.gz --prefix=example-source-abc123/ ${src.sha}\n`
    );
    chmodSync(fake, 0o755);
    const lock = sync({ sha: src.sha, root, env: { ...process.env, NOBLECLOAK_GH: fake } });
    assert.equal(readFileSync(join(bin, 'args'), 'utf-8').trim(), `api repos/${REPO}/tarball/${src.sha}`);
    assert.equal(Object.keys(lock.files).length, SKILL_NAMES.length * 2);
    assert.ok(existsSync(join(root, 'setup-skills', `${DIR_PREFIX}langgraph`, 'SKILL.md')));
    assert.equal(lock.packages.langgraph, '1.9.0', 'versions are read from the GitHub tarball too');
  } finally {
    for (const d of [src.dir, root, bin]) rmSync(d, { recursive: true, force: true });
  }
});

test('a commit without a package.json version for a skill package is refused and writes nothing', () => {
  const src = makeSourceRepo();
  const root = makeRoot();
  try {
    writeFileSync(join(src.dir, PACKAGE_DIRS.langgraph, 'package.json'), JSON.stringify({ name: '@noblecloak/langgraph' }));
    git(src.dir, 'add', '-A');
    git(src.dir, 'commit', '-q', '-m', 'no version');
    assert.throws(() => sync({ sha: git(src.dir, 'rev-parse', 'HEAD'), clone: src.dir, root }), new RegExp(`${PACKAGE_DIRS.langgraph}/package.json has no version`));
    assert.ok(!existsSync(join(root, 'setup-skills', 'SKILLS.lock')), 'a refused sync writes nothing');
  } finally {
    rmSync(src.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI exits 1 with a message when --sha is missing', () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'sync-skills.mjs')], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--sha must be the full 40-hex/);
});

/** Two repositories: the langgraph skill and package in `second`, everything else in the first. */
const SPLIT = {
  skills: { ...ONE.skills, langgraph: { repo: 'example/second', path: 'skills/langgraph' } },
  packages: { ...ONE.packages, langgraph: { repo: 'example/second', dir: 'pkg/langgraph' } },
};

function makeSplitRepos() {
  const first = makeSourceRepo('first');
  rmSync(join(first.dir, skillPath('langgraph')), { recursive: true });
  rmSync(join(first.dir, PACKAGE_DIRS.langgraph), { recursive: true });
  git(first.dir, 'add', '-A');
  git(first.dir, 'commit', '-q', '-m', 'first without langgraph');
  const dir = mkdtempSync(join(tmpdir(), 'ui-second-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, 'skills', 'langgraph'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'langgraph', 'SKILL.md'), '---\nname: langgraph\n---\nsecond\n');
  mkdirSync(join(dir, 'pkg', 'langgraph'), { recursive: true });
  writeFileSync(join(dir, 'pkg', 'langgraph', 'package.json'), JSON.stringify({ version: '7.7.7' }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'second');
  return { first: { dir: first.dir, sha: git(first.dir, 'rev-parse', 'HEAD') }, second: { dir, sha: git(dir, 'rev-parse', 'HEAD') } };
}

test('with skills in two repositories the lock records each skill\'s own repo, sha and path, and packages come from their repo', () => {
  const { first, second } = makeSplitRepos();
  const root = makeRoot();
  try {
    const lock = sync({
      sha: { [REPO]: first.sha, 'example/second': second.sha },
      clone: { [REPO]: first.dir, 'example/second': second.dir },
      root,
      sources: SPLIT,
    });
    assert.deepEqual(lock.skills.langgraph, { repo: 'example/second', sha: second.sha, path: 'skills/langgraph' });
    assert.deepEqual(lock.skills.approvals, { repo: REPO, sha: first.sha, path: skillPath('approvals') });
    assert.equal(lock.packages.langgraph, '7.7.7', 'the langgraph version is read from the second repository');
    assert.equal(lock.packages.react, '1.5.0');
    assert.match(readFileSync(join(root, 'setup-skills', `${DIR_PREFIX}langgraph`, 'SKILL.md'), 'utf-8'), /second/);
  } finally {
    for (const d of [first.dir, second.dir, root]) rmSync(d, { recursive: true, force: true });
  }
});

test('with several repositories a bare --sha is refused, and so is a missing repository', () => {
  const root = makeRoot();
  try {
    assert.throws(() => sync({ sha: 'a'.repeat(40), root, sources: SPLIT }), /<repo>=<value> for each of .*example\/second/);
    assert.throws(() => sync({ sha: { [REPO]: 'a'.repeat(40) }, root, sources: SPLIT }), /no --sha for example\/second/);
    assert.ok(!existsSync(join(root, 'setup-skills', 'SKILLS.lock')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parsePerRepo: a bare value stays a string, repo=value pairs become an object, a stranger repo is refused', () => {
  assert.equal(parsePerRepo(['abc'], ONE), 'abc');
  assert.equal(parsePerRepo(undefined, ONE), undefined);
  assert.deepEqual(parsePerRepo([`${REPO}=abc`], ONE), { [REPO]: 'abc' });
  assert.throws(() => parsePerRepo(['other/repo=abc'], ONE), /not a repository in SOURCES/);
  assert.throws(() => parsePerRepo(['abc', `${REPO}=def`], ONE), /must be <owner\/name>=<value>/);
});
