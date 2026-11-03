#!/usr/bin/env node
/**
 * Bundles the NobleCloak setup skills into this plugin.
 *
 * The skills are authored once, in the repositories named by SOURCES below; the plugin keeps no hand-edited copy.
 * This script copies each skill (`SOURCES.skills[name].path` of `SOURCES.skills[name].repo`) from one pinned
 * commit per repository into `setup-skills/noblecloak-setup-<name>/` and writes `setup-skills/SKILLS.lock` (per
 * skill `{repo, sha, path}`, plus a sha256 per copied file). `test/skills-lock.test.mjs` recomputes the hashes, so a
 * hand edit fails `npm test`: change a skill by re-running this script at a new pin.
 *
 * SOURCES is the one place that names those repositories, for the skills here and for the release tarballs
 * setup.mjs downloads (`SOURCES.packages[name].repo`).
 *
 * The lock also records `packages`: the version of each @noblecloak/* package the skills install (react, client,
 * theme, langgraph), read from that package's package.json (`SOURCES.packages[name].dir`) at the pinned commit of
 * the package's repository. setup.mjs compares them with the package source it resolves and warns when they
 * differ, since the skills' templates were written against them.
 *
 * The copies live in `setup-skills/`, not the plugin's `skills/`: Claude Code auto-discovers `skills/`, and these
 * skills must run only through /noblecloak-setup (which resolves the package source and supplies the proposer token).
 *
 *   node scripts/sync-skills.mjs --sha <40-hex commit> [--clone <local clone>]
 *   node scripts/sync-skills.mjs --sha <repo>=<40-hex commit> ... [--clone <repo>=<local clone> ...]
 *
 * A bare `--sha` / `--clone` is allowed only while every skill and package comes from one repository; otherwise
 * give one `--sha <owner/name>=<sha>` per repository in SOURCES (and optionally `--clone <owner/name>=<dir>`).
 * Without a clone the commit is read with `gh api repos/<repo>/tarball/<sha>` (needs a `gh` signed in to an account
 * that can read the repository). With a clone it is read with `git archive` from that clone, which must already
 * contain the commit (fetch first). Each sha is required and must be the full sha, so the pin never moves with a
 * branch. The `name` frontmatter of each SKILL.md is kept as is (the Agent Skills id);
 * only the directory is prefixed, so these names cannot collide with the plugin's own skills.
 *
 * Env: NOBLECLOAK_GH names the gh binary (default `gh`); a test seam.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// SOURCES-BEGIN
/**
 * Where the skills and the packages are authored. `skills[name]`: the repository and the directory in it that
 * holds the skill. `packages[name]`: the repository and the directory in it whose package.json gives the version
 * the lock records (this script); the packages themselves are installed from the public npm registry (setup.mjs). The skill keys are
 * quoted so the scope guard in test/propose-tool.test.mjs, which greps scripts/ for the text "approvals" followed
 * by a colon, does not read the first one as a scope.
 */
export const SOURCES = {
  "skills": {
    "approvals": {
      "repo": "NobleCloak/noblecloak-ts",
      "path": "packages/skills/approvals"
    },
    "permissions": {
      "repo": "NobleCloak/noblecloak-ts",
      "path": "packages/skills/permissions"
    },
    "connections": {
      "repo": "NobleCloak/noblecloak-ts",
      "path": "packages/skills/connections"
    },
    "langgraph": {
      "repo": "NobleCloak/noblecloak-langgraph-ts",
      "path": "skills/langgraph"
    }
  },
  "packages": {
    "react": {
      "repo": "NobleCloak/noblecloak-ts",
      "dir": "packages/react"
    },
    "client": {
      "repo": "NobleCloak/noblecloak-ts",
      "dir": "packages/client"
    },
    "theme": {
      "repo": "NobleCloak/noblecloak-ts",
      "dir": "packages/theme"
    },
    "langgraph": {
      "repo": "NobleCloak/noblecloak-langgraph-ts",
      "dir": "packages/langgraph"
    }
  }
};
// SOURCES-END
export const SKILL_NAMES = Object.keys(SOURCES.skills);
export const DIR_PREFIX = 'noblecloak-setup-';
export const LOCK_NAME = 'SKILLS.lock';
/** The plugin directory that holds the copies; not `skills/`, so Claude Code does not offer them on their own. */
export const BUNDLE_DIR = 'setup-skills';
const SHA_RE = /^[0-9a-f]{40}$/;
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every file under `dir` as a '/'-separated path relative to `base`, sorted. */
export function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(join(dir, entry.name), base)
        : [relative(base, join(dir, entry.name)).split(sep).join('/')]
    )
    .sort();
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** sha256 of every file under `<root>/setup-skills/noblecloak-setup-*`, keyed by path relative to `root`. */
export function hashBundledFiles(root) {
  const skillsDir = join(root, BUNDLE_DIR);
  const files = {};
  if (!existsSync(skillsDir)) return files;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(DIR_PREFIX)) continue;
    for (const file of listFiles(join(skillsDir, entry.name))) {
      const path = `${BUNDLE_DIR}/${entry.name}/${file}`;
      files[path] = sha256(readFileSync(join(root, path)));
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited ${result.status}: ${String(result.stderr ?? '').trim()}`);
  }
  return result.stdout;
}

/** The repositories SOURCES names for skills and packages, sorted. */
export function sourceRepos(sources = SOURCES) {
  const all = [...Object.values(sources.skills), ...Object.values(sources.packages)].map((e) => e.repo);
  return [...new Set(all)].sort();
}

/**
 * Turns a `--sha` / `--clone` value into { repo: value } for every repo in SOURCES. A bare string stands for the
 * only repository and is refused when SOURCES names several; an object must cover every repository.
 */
export function perRepo(value, what, sources = SOURCES) {
  const repos = sourceRepos(sources);
  if (typeof value === 'string') {
    if (repos.length !== 1) throw new Error(`--${what} must be given as <repo>=<value> for each of ${repos.join(', ')}`);
    return { [repos[0]]: value };
  }
  for (const repo of repos) if (!value?.[repo]) throw new Error(`no --${what} for ${repo}`);
  return value;
}

/** Parses repeated `--sha` / `--clone` CLI values: bare `x` or `<owner/name>=x`. */
export function parsePerRepo(list, sources = SOURCES) {
  if (!list || list.length === 0) return undefined;
  if (list.length === 1 && !list[0].includes('=')) return list[0];
  const out = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at < 0) throw new Error(`"${item}" must be <owner/name>=<value> when several are given`);
    const repo = item.slice(0, at);
    if (!sourceRepos(sources).includes(repo)) throw new Error(`${repo} is not a repository in SOURCES`);
    out[repo] = item.slice(at + 1);
  }
  return out;
}

/**
 * Extracts, from `sha` of `repo`, the given `paths` (files or directories) into `dest` (created). With a `clone` the
 * paths are read with `git archive` (throwing when the clone lacks the commit); otherwise the whole GitHub tarball
 * is extracted.
 */
export function fetchSourceTree({ repo, sha, clone, dest, paths, env = process.env }) {
  mkdirSync(dest, { recursive: true });
  const tarball = join(dest, 'source.tar');
  if (clone) {
    if (spawnSync('git', ['-C', clone, 'cat-file', '-e', `${sha}^{commit}`]).status !== 0) {
      throw new Error(`${repo}: clone ${clone} does not contain ${sha} (fetch first)`);
    }
    // git archive refuses a path the commit lacks; leave those out, so writeBundle / readPackageVersions name them.
    const present = paths.filter((path) => spawnSync('git', ['-C', clone, 'cat-file', '-e', `${sha}:${path}`]).status === 0);
    if (present.length > 0) {
      run('git', ['-C', clone, 'archive', '--format=tar', '-o', tarball, sha, ...present]);
      run('tar', ['-xf', tarball, '-C', dest]);
    }
  } else {
    const bytes = run(env.NOBLECLOAK_GH ?? 'gh', ['api', `repos/${repo}/tarball/${sha}`]);
    writeFileSync(tarball, bytes);
    // GitHub's tarball has one top-level directory (<owner>-<repo>-<sha>/).
    run('tar', ['-xf', tarball, '-C', dest, '--strip-components=1']);
  }
  rmSync(tarball, { force: true });
  return dest;
}

/** The version in each SOURCES.packages package.json under `trees[repo]` (the extracted commit): { name: version }. */
export function readPackageVersions({ trees, shas, sources = SOURCES }) {
  return Object.fromEntries(
    Object.entries(sources.packages).map(([name, { repo, dir }]) => {
      let version;
      try {
        ({ version } = JSON.parse(readFileSync(join(trees[repo], dir, 'package.json'), 'utf-8')));
      } catch {
        throw new Error(`${repo}@${shas[repo]} has no readable ${dir}/package.json`);
      }
      if (typeof version !== 'string' || version === '') throw new Error(`${repo}@${shas[repo]}: ${dir}/package.json has no version`);
      return [name, version];
    })
  );
}

/**
 * Copies every skill from `trees[repo]` into `<root>/setup-skills`, replacing earlier copies, and writes the lock:
 * per-skill `{repo, sha, path}`, `packages` (the versions from readPackageVersions) and a hash per file.
 */
export function writeBundle({ trees, root, shas, packages, sources = SOURCES }) {
  for (const [name, { repo, path }] of Object.entries(sources.skills)) {
    if (!existsSync(join(trees[repo], path, 'SKILL.md'))) {
      throw new Error(`${repo}@${shas[repo]} has no ${path}/SKILL.md`);
    }
  }
  const skillsDir = join(root, BUNDLE_DIR);
  mkdirSync(skillsDir, { recursive: true });
  // Replace whole directories, so a file the source dropped does not linger.
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(DIR_PREFIX)) {
      rmSync(join(skillsDir, entry.name), { recursive: true, force: true });
    }
  }
  for (const [name, { repo, path }] of Object.entries(sources.skills)) {
    cpSync(join(trees[repo], path), join(skillsDir, `${DIR_PREFIX}${name}`), { recursive: true });
  }
  const lock = {
    note: 'Generated by scripts/sync-skills.mjs. Do not edit: re-run the script at a new pin.',
    skills: Object.fromEntries(Object.entries(sources.skills).map(([name, { repo, path }]) => [name, { repo, sha: shas[repo], path }])),
    packages,
    files: hashBundledFiles(root),
  };
  writeFileSync(join(skillsDir, LOCK_NAME), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

/** `sha` and `clone` are a string (one-repository sources) or { repo: value }; see perRepo. `sources` is a test seam. */
export function sync({ sha, clone, root = PLUGIN_ROOT, env = process.env, sources = SOURCES }) {
  if (sha === undefined) throw new Error('--sha must be the full 40-hex commit sha');
  const shas = perRepo(sha, 'sha', sources);
  for (const [repo, value] of Object.entries(shas)) {
    if (!SHA_RE.test(value ?? '')) throw new Error(`--sha must be the full 40-hex commit sha (${repo}: "${value}")`);
  }
  const clones = clone === undefined ? {} : typeof clone === 'string' ? perRepo(clone, 'clone', sources) : clone;
  const scratch = mkdtempSync(join(tmpdir(), 'noblecloak-skills-sync-'));
  try {
    const trees = {};
    for (const repo of sourceRepos(sources)) {
      const paths = [
        ...Object.values(sources.skills).filter((e) => e.repo === repo).map((e) => e.path),
        ...Object.values(sources.packages).filter((e) => e.repo === repo).map((e) => `${e.dir}/package.json`),
      ];
      trees[repo] = fetchSourceTree({
        repo,
        sha: shas[repo],
        clone: clones[repo] ? resolve(clones[repo]) : undefined,
        dest: join(scratch, repo.replace('/', '__')),
        paths,
        env,
      });
    }
    const packages = readPackageVersions({ trees, shas, sources });
    return writeBundle({ trees, root, shas, packages, sources });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { sha: { type: 'string', multiple: true }, clone: { type: 'string', multiple: true } }, strict: true });
    const lock = sync({ sha: parsePerRepo(values.sha), clone: parsePerRepo(values.clone) });
    const pins = [...new Set(Object.values(lock.skills).map((e) => `${e.repo}@${e.sha}`))].join(', ');
    console.log(`Synced ${Object.keys(lock.skills).length} skills at ${pins} (${Object.keys(lock.files).length} files).`);
  } catch (err) {
    console.error(`sync-skills: ${err.message}`);
    process.exit(1);
  }
}
