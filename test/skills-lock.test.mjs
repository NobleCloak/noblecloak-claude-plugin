/**
 * The bundled setup skills are a pinned copy of the skills SOURCES names. SKILLS.lock holds, per skill, the source
 * repository, sha and path, and a sha256 per file; a hand edit (or a file added or removed without re-running scripts/sync-skills.mjs)
 * fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DIR_PREFIX, hashBundledFiles, LOCK_NAME, SKILL_NAMES, SOURCES } from '../scripts/sync-skills.mjs';
import { REPO_ROOT } from './helpers.mjs';

const readLock = (root) => JSON.parse(readFileSync(join(root, 'setup-skills', LOCK_NAME), 'utf-8'));

/** A throwaway copy of setup-skills/, so a test can edit it. */
function copyOfBundle() {
  const root = mkdtempSync(join(tmpdir(), 'skills-lock-'));
  cpSync(join(REPO_ROOT, 'setup-skills'), join(root, 'setup-skills'), { recursive: true });
  return root;
}

/** The files whose hashes differ from the lock, or are missing from either side. */
function drift(root) {
  const locked = readLock(root).files;
  const actual = hashBundledFiles(root);
  const paths = new Set([...Object.keys(locked), ...Object.keys(actual)]);
  return [...paths].filter((p) => locked[p] !== actual[p]).sort();
}

test('SKILLS.lock has one pinned entry per SOURCES skill, with the map\'s repo and path', () => {
  const lock = readLock(REPO_ROOT);
  assert.deepEqual(Object.keys(lock.skills).sort(), Object.keys(SOURCES.skills).sort());
  assert.deepEqual(SKILL_NAMES, Object.keys(SOURCES.skills));
  for (const [name, entry] of Object.entries(lock.skills)) {
    assert.match(entry.sha, /^[0-9a-f]{40}$/, name);
    assert.equal(entry.repo, SOURCES.skills[name].repo, `${name}: lock repo is the map's repo`);
    assert.equal(entry.path, SOURCES.skills[name].path, `${name}: lock path is the map's path`);
  }
  // The package versions the skills were written against, which setup.mjs compares with the release it downloads.
  assert.deepEqual(Object.keys(lock.packages).sort(), Object.keys(SOURCES.packages).sort());
  for (const version of Object.values(lock.packages)) assert.match(version, /^\d+\.\d+\.\d+/);
  for (const name of SKILL_NAMES) {
    const skill = readFileSync(join(REPO_ROOT, 'setup-skills', `${DIR_PREFIX}${name}`, 'SKILL.md'), 'utf-8');
    // The Agent Skills id is kept; only the directory is prefixed.
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`));
  }
});

test('the bundled files match the lock (no hand edits)', () => {
  assert.deepEqual(drift(REPO_ROOT), []);
});

test('a hand edit to a bundled file fails the integrity check', () => {
  const root = copyOfBundle();
  try {
    const target = join(root, 'setup-skills', `${DIR_PREFIX}langgraph`, 'SKILL.md');
    writeFileSync(target, `${readFileSync(target, 'utf-8')}\nlocal tweak\n`);
    assert.deepEqual(drift(root), [`setup-skills/${DIR_PREFIX}langgraph/SKILL.md`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a deleted and an added file fail the integrity check', () => {
  const root = copyOfBundle();
  try {
    unlinkSync(join(root, 'setup-skills', `${DIR_PREFIX}approvals`, 'SKILL.md'));
    writeFileSync(join(root, 'setup-skills', `${DIR_PREFIX}approvals`, 'extra.txt'), 'x');
    assert.deepEqual(drift(root), [
      `setup-skills/${DIR_PREFIX}approvals/SKILL.md`,
      `setup-skills/${DIR_PREFIX}approvals/extra.txt`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
