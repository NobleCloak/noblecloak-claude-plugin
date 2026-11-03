#!/usr/bin/env node
/**
 * /noblecloak-setup: works out what the project is, resolves where the setup skills get their @noblecloak/*
 * packages, and (for LangGraph) opens the policy-set approval with the builder's token.
 *
 *   node setup.mjs [detect] [--project <dir>] [--source <dir>|registry] [--accept-version-drift]
 *   node setup.mjs propose <args for the langgraph skill's propose.mjs>
 *
 * `detect` (the default) prints what it found, the candidate skills (bundled under setup-skills/noblecloak-setup-*) and the
 * `--source` to pass to the chosen skill's apply.mjs. It writes nothing into the project. Exit codes: 0 at least one
 * candidate can run, 5 a candidate can run but a package version differs from the lock (see below), 2 the project is neither a Next.js App Router app nor a LangGraph project, 4 candidates exist
 * but none can run (a package tarball is missing from the release), 1 anything else (gh failed, checksum mismatch).
 *
 * Pre-release package source: nothing @noblecloak/* is on npm before the public release, so the skills' apply.mjs
 * installs from tarballs. Unless `--source` is given, `detect` downloads each package's tarball from the latest
 * published `spec-v*` release of the repository SOURCES.packages names for it (scripts/sync-skills.mjs) with `gh`,
 * checks every tarball against that release's SHA256SUMS, and passes one directory holding all of them. The
 * directory is the plugin's package cache, `<state dir>/packages/<tag>/` (by default
 * ~/.noblecloak/claude-plugin/packages/<tag>/; when the repositories' latest tags differ, <tag> is the distinct tags
 * joined with '+'), never a temp directory: apply.mjs records the tarball paths in the
 * project's package.json (`file:` dependencies and overrides), so they must outlive this run. Each run downloads all
 * four packages afresh and replaces that tag's directory, so its contents do not depend on the project; nothing
 * removes it. After the public release, set SOURCE_FROM_RELEASE to false: the default becomes `registry` and the
 * release path (resolveReleaseSource) is deleted.
 *
 * The skills are pinned (SKILLS.lock) but the release is the latest one, so for a tarball source `detect` compares
 * each needed tarball's version with the lock's `packages` (the versions at the pinned commit) and prints a
 * `WARNING:` line for each that differs and exits 5 instead of 0 (the candidates are still printed). Passing
 * `--accept-version-drift` (after the builder agreed to the mismatch) keeps the WARNING lines but exits 0. The registry
 * source is not checked. Exit 5 leaves the package cache in place, like every other exit.
 *
 * `propose` runs the langgraph skill's propose.mjs with NC_PROPOSER_TOKEN set to the plugin's govern-audience user
 * token (the one /noblecloak-propose-tool uses; minted or refreshed through the plugin's PKCE flow). The token goes
 * into that child process's environment only: not its arguments, not a file, and not this process's environment.
 * The token is for the govern API origin, so the destination (`--base-url`, else NC_BASE_URL) must be set and have
 * that origin; otherwise nothing is minted and the exit is 1. With `--dry-run` nothing is sent, so no token is
 * fetched and the destination is not checked. Exit codes are propose.mjs's own, plus 3 when
 * the plugin is not signed in and 1 when the token cannot be obtained. When propose.mjs exits 3 after being given the
 * plugin's token (the deployment rejected it, or it is not a user token), the stored govern token is dropped, as
 * /noblecloak-propose-tool does on a 401, so the next run signs in afresh instead of replaying it.
 *
 * Env: NOBLECLOAK_GH names the gh binary (default `gh`) and NOBLECLOAK_SETUP_SKILLS_DIR the skills directory
 * (default: this plugin's `setup-skills/`); both are test seams.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  AuthDiscoveryError,
  approvalsUrl,
  dropTokenFor,
  ensureStateDir,
  governResourceIndicator,
  loadAuthState,
  resolveResourceIndicator,
  stateDir,
  TokenRefreshError,
} from './lib/governance.mjs';
import { governToken } from './lib/govern-token.mjs';
import { SignInError } from './lib/pkce-flow.mjs';
import { BUNDLE_DIR, DIR_PREFIX, LOCK_NAME, SOURCES } from './sync-skills.mjs';

/** Pre-release switch: true resolves the package source from a release; false means `registry` (see header). */
export const SOURCE_FROM_RELEASE = true;

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MODULE_SKILLS = ['approvals', 'permissions', 'connections'];
export const LANGGRAPH_PACKAGES = ['@langchain/langgraph', 'langchain'];
/** The tarballs (by package) each kind of skill installs; mirrors TARBALL_PACKAGES in the skills' apply.mjs. */
export const REQUIRED_TARBALLS = { module: ['react', 'client', 'theme'], langgraph: ['langgraph', 'client'] };
/** A spec release tag; strict, since the tag names a directory in the package cache. */
const RELEASE_TAG = /^spec-v\d[0-9A-Za-z.+_-]*$/;
/** Every package a setup skill installs; the release download takes all of them, whatever the project is. */
export const RELEASE_PACKAGES = [...new Set([...REQUIRED_TARBALLS.module, ...REQUIRED_TARBALLS.langgraph])];

/** The package cache: one verified directory per release tag. */
export function packageCacheDir(env = process.env) {
  return join(stateDir(env), 'packages');
}

/** What the project at `dir` is: { module, langgraph, evidence }. Reads package.json and looks for app/ or src/app/. */
export function detectProject(dir) {
  const evidence = [];
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
  } catch {
    evidence.push('no readable package.json');
  }
  const deps = { ...manifest.devDependencies, ...manifest.dependencies };
  const appDir = ['app', join('src', 'app')].find((d) => existsSync(join(dir, d)));
  const module = 'next' in deps && appDir !== undefined;
  if ('next' in deps) evidence.push(appDir ? `next + ${appDir}/` : 'next, but no app/ or src/app/ (not the App Router)');
  const found = LANGGRAPH_PACKAGES.filter((name) => name in deps);
  if (found.length > 0) evidence.push(found.join(' + '));
  return { module, langgraph: found.length > 0, evidence };
}

const gh = (env) => env.NOBLECLOAK_GH ?? 'gh';

function runGh(env, args) {
  const r = spawnSync(gh(env), args, { encoding: 'utf-8' });
  if (r.error) throw new Error(`gh could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/** Parses `sha256sum` output ("<hex>  <name>") into { name: hex }. */
export function parseSums(text) {
  const sums = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums[m[2]] = m[1];
  }
  return sums;
}

const TARBALL_NAME = /^noblecloak-([a-z][a-z-]*?)-(\d.*)\.tgz$/;

/** The package names ("react", "client", ...) of the noblecloak-<name>-<version>.tgz files in `dir`. */
export function tarballPackages(dir) {
  return Object.keys(tarballVersions(dir));
}

/** { name: version } of the noblecloak-<name>-<version>.tgz files in `dir`. */
export function tarballVersions(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .map((file) => TARBALL_NAME.exec(file))
      .filter(Boolean)
      .map((m) => [m[1], m[2]])
  );
}

/** The package versions the bundled skills were written against (SKILLS.lock `packages`), or {} when unreadable. */
export function lockedPackages(env = process.env) {
  try {
    return JSON.parse(readFileSync(join(skillsDir(env), LOCK_NAME), 'utf-8')).packages ?? {};
  } catch {
    return {};
  }
}

/**
 * The packages in `need` whose tarball version in `dir` differs from the locked one, as [{ name, locked, found }].
 * A package with no tarball or no locked version is not listed (a missing tarball is reported as BLOCKED instead).
 */
export function versionMismatches(dir, need, locked) {
  const found = tarballVersions(dir);
  return need
    .filter((name) => found[name] !== undefined && locked[name] !== undefined && found[name] !== locked[name])
    .map((name) => ({ name, locked: locked[name], found: found[name] }));
}

/** RELEASE_PACKAGES grouped by the release repository SOURCES names for each: [[repo, [package, ...]], ...] by repo. */
export function releaseGroups(packages = RELEASE_PACKAGES, sources = SOURCES) {
  const groups = new Map();
  for (const name of packages) {
    const repo = sources.packages[name]?.repo;
    if (!repo) throw new Error(`SOURCES.packages has no entry for ${name}`);
    groups.set(repo, [...(groups.get(repo) ?? []), name]);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * Downloads, from each release repository (releaseGroups), the latest published spec-v* release's tarballs for the
 * packages that repository supplies into a staging directory in the package cache, checks each against that
 * release's SHA256SUMS, then moves them all to `<cache>/<tag>/` (replacing an earlier copy); `<tag>` is the distinct
 * tags joined with '+' (one tag when the repositories agree or there is one repository). The directory's SHA256SUMS
 * is the releases' files concatenated. Returns { dir, tag, packages } (the names present). Throws, removing the
 * staging directory and leaving any earlier `<tag>/` in place, when gh fails, SHA256SUMS is missing, or a tarball is
 * absent from it or differs.
 */
export function resolveReleaseSource({ env = process.env, sources = SOURCES }) {
  const groups = releaseGroups(RELEASE_PACKAGES, sources).map(([repo, names]) => {
    const listed = JSON.parse(
      runGh(env, ['release', 'list', '--repo', repo, '--exclude-drafts', '--exclude-pre-releases', '--limit', '50', '--json', 'tagName'])
    );
    const tag = listed.map((r) => r.tagName).find((t) => RELEASE_TAG.test(t));
    if (!tag) throw new Error(`${repo} has no published spec-v* release`);
    return { repo, names, tag };
  });
  const tag = [...new Set(groups.map((g) => g.tag))].join('+');
  ensureStateDir(env);
  const cache = packageCacheDir(env);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(cache, '.staging-'));
  try {
    const sumsText = [];
    groups.forEach(({ repo, names, tag: groupTag }, i) => {
      const part = join(dir, `.part-${i}`);
      mkdirSync(part);
      const patterns = ['SHA256SUMS', ...names.map((p) => `noblecloak-${p}-*.tgz`)].flatMap((p) => ['--pattern', p]);
      runGh(env, ['release', 'download', groupTag, '--repo', repo, '--dir', part, ...patterns]);
      if (!existsSync(join(part, 'SHA256SUMS'))) throw new Error(`release ${groupTag} of ${repo} has no SHA256SUMS`);
      const text = readFileSync(join(part, 'SHA256SUMS'), 'utf-8');
      const sums = parseSums(text);
      for (const file of readdirSync(part).filter((f) => f.endsWith('.tgz'))) {
        const expected = sums[file];
        if (!expected) throw new Error(`${file} is not listed in release ${groupTag}'s SHA256SUMS`);
        const actual = createHash('sha256').update(readFileSync(join(part, file))).digest('hex');
        if (actual !== expected) throw new Error(`${file} does not match release ${groupTag}'s SHA256SUMS`);
        renameSync(join(part, file), join(dir, file));
      }
      sumsText.push(text);
      rmSync(part, { recursive: true, force: true });
    });
    writeFileSync(join(dir, 'SHA256SUMS'), sumsText.join(''));
    const final = join(cache, tag);
    rmSync(final, { recursive: true, force: true });
    renameSync(dir, final);
    return { dir: final, tag, packages: tarballPackages(final) };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Candidate skills for a detection result, each with whether the available packages let it run. */
export function candidates(detected, available) {
  const make = (kind, skills) => {
    const missing = REQUIRED_TARBALLS[kind].filter((p) => !available.includes(p));
    return { kind, skills, missing, runnable: missing.length === 0 };
  };
  return [
    ...(detected.module ? [make('module', MODULE_SKILLS)] : []),
    ...(detected.langgraph ? [make('langgraph', ['langgraph'])] : []),
  ];
}

function skillsDir(env) {
  return env.NOBLECLOAK_SETUP_SKILLS_DIR ?? join(PLUGIN_ROOT, BUNDLE_DIR);
}

/** Runs detection and source resolution. Returns { detected, found, source, tag, exit, lines }. */
export function runDetect({ project, source, env = process.env, resolveRelease = resolveReleaseSource, acceptVersionDrift = false }) {
  const detected = detectProject(project);
  const lines = [`Project: ${project}`];
  if (!detected.module && !detected.langgraph) {
    lines.push(`Detected: neither a Next.js App Router app nor a LangGraph project (${detected.evidence.join('; ') || 'nothing found'}).`);
    lines.push('No setup skill applies. Tell the builder; do not guess.');
    return { detected, found: [], exit: 2, lines };
  }
  lines.push(`Detected: ${[detected.module && 'Next.js App Router app', detected.langgraph && 'LangGraph project'].filter(Boolean).join(' AND ')} (${detected.evidence.join('; ')}).`);
  const need = [...new Set([...(detected.module ? REQUIRED_TARBALLS.module : []), ...(detected.langgraph ? REQUIRED_TARBALLS.langgraph : [])])];
  let resolved;
  let from;
  if (source !== undefined) {
    resolved = source === 'registry' ? { source: 'registry', packages: need } : { source: resolve(source), packages: tarballPackages(resolve(source)) };
    from = source === 'registry' ? 'registry' : `directory ${resolved.source}`;
  } else if (SOURCE_FROM_RELEASE) {
    const release = resolveRelease({ env });
    resolved = { source: release.dir, packages: release.packages, tag: release.tag };
    from = `release ${release.tag}, checksums verified against SHA256SUMS`;
  } else {
    resolved = { source: 'registry', packages: need };
    from = 'registry';
  }
  const found = candidates(detected, resolved.packages);
  lines.push(`Source: --source ${resolved.source} (${from}).`);
  for (const c of found) {
    if (c.runnable) {
      lines.push(`Candidate ${c.kind}: ${c.skills.map((s) => `${s} (${join(skillsDir(env), DIR_PREFIX + s, 'SKILL.md')})`).join(', ')}`);
    } else {
      lines.push(`BLOCKED ${c.kind}: the package source has no ${c.missing.map((p) => `noblecloak-${p}-<version>.tgz`).join(', ')}. Stop and tell the builder; do not run the ${c.kind} skill.`);
    }
  }
  let drift = false;
  if (resolved.source !== 'registry') {
    for (const m of versionMismatches(resolved.source, need, lockedPackages(env))) {
      drift = true;
      lines.push(
        `WARNING: the bundled skills were written against @noblecloak/${m.name} ${m.locked}, but the package source has ${m.found}. Tell the builder, and ask whether to continue before running a skill.`
      );
    }
  }
  if (drift && !acceptVersionDrift && found.some((c) => c.runnable)) {
    lines.push('Exit 5: do not run a skill yet. If the builder agrees to the different version, re-run with --accept-version-drift.');
  }
  if (found.filter((c) => c.runnable).length > 1) lines.push('Both kinds match: ask the builder which one to set up.');
  return { detected, found, source: resolved.source, tag: resolved.tag, exit: !found.some((c) => c.runnable) ? 4 : drift && !acceptVersionDrift ? 5 : 0, lines };
}

/**
 * The origin propose.mjs will send to: the last `--base-url` in `args` (also `--base-url=<x>`), else NC_BASE_URL.
 * Returns undefined when neither is set, and the raw text when it is not a URL (so it never equals a real origin).
 */
export function proposeTarget(args, env) {
  let raw;
  args.forEach((arg, i) => {
    if (arg === '--base-url') raw = args[i + 1] ?? '';
    else if (arg.startsWith('--base-url=')) raw = arg.slice('--base-url='.length);
  });
  raw = (raw ?? env.NC_BASE_URL ?? '').trim();
  if (raw === '') return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

/**
 * Runs the langgraph skill's propose.mjs with the plugin's govern token in NC_PROPOSER_TOKEN of the child only.
 * `getToken`, `run` and `dropToken` are injectable for tests. Returns the exit code.
 */
export async function runPropose({ args, env = process.env, getToken = governToken, run = spawnSync, log = console.error, dropToken = dropTokenFor }) {
  const script = join(skillsDir(env), `${DIR_PREFIX}langgraph`, 'scripts', 'propose.mjs');
  if (!existsSync(script)) {
    log(`The bundled langgraph skill is missing (${script}).`);
    return 1;
  }
  const childEnv = { ...env };
  let resource;
  if (!args.includes('--dry-run')) {
    if (!loadAuthState(env)) {
      log('Not signed in — run /noblecloak-login first.');
      return 3;
    }
    resource = governResourceIndicator(env);
    if (!resource) {
      log('Cannot determine the govern API origin — set NOBLECLOAK_GOVERN_URL.');
      return 1;
    }
    if (resource === resolveResourceIndicator(env)) {
      log(`The govern API origin (${resource}) equals the MCP gateway origin — check NOBLECLOAK_GOVERN_URL.`);
      return 1;
    }
    const target = proposeTarget(args, env);
    if (target === undefined) {
      log('Set NC_BASE_URL (or pass --base-url) to the module API origin; this command does not guess where the token goes.');
      return 1;
    }
    if (target !== resource) {
      log(`Refused: propose.mjs would send to ${target}, but the token is for the govern API origin ${resource}. Point NC_BASE_URL/--base-url at ${resource}.`);
      return 1;
    }
    try {
      childEnv.NC_PROPOSER_TOKEN = await getToken(resource);
    } catch (err) {
      if (err instanceof SignInError && err.notSignedIn) {
        log(`Not signed in to the approvals API — ${err.message}. Re-run to try again.`);
        return 3;
      }
      const hint = err instanceof TokenRefreshError || err instanceof AuthDiscoveryError ? ' Try again shortly.' : '';
      log(`Could not get a user token for the approvals API — ${err.message}.${hint}`);
      return 1;
    }
    // NC_BASE_URL is the builder's (checked above); the plugin fills only the approvals address when it is unset.
    const approvals = approvalsUrl(env, resource);
    if (!childEnv.NOBLECLOAK_APPROVALS_URL && approvals) childEnv.NOBLECLOAK_APPROVALS_URL = approvals;
  } else {
    delete childEnv.NC_PROPOSER_TOKEN;
  }
  const result = run(process.execPath, [script, ...args], { env: childEnv, stdio: 'inherit' });
  if (result.error) {
    log(`Could not run propose.mjs: ${result.error.message}`);
    return 1;
  }
  if (result.status === 3 && resource !== undefined) {
    // propose.mjs exits 3 when the token it was given is not accepted: drop it so the re-run signs in afresh.
    await dropToken(resource, env).catch(() => {});
    log('The stored approvals token was cleared; re-run to sign in again.');
  }
  return result.status ?? 1;
}

async function main(argv) {
  const [first, ...rest] = argv;
  if (first === 'propose') return runPropose({ args: rest });
  let values;
  try {
    ({ values } = parseArgs({ args: first === 'detect' ? rest : argv, options: { project: { type: 'string' }, source: { type: 'string' }, 'accept-version-drift': { type: 'boolean' } }, strict: true }));
  } catch (err) {
    console.error(`${err.message}\nUsage: setup.mjs [detect] [--project <dir>] [--source <dir>|registry] | setup.mjs propose <propose.mjs args>`);
    return 1;
  }
  try {
    const out = runDetect({ project: resolve(values.project ?? process.cwd()), source: values.source, acceptVersionDrift: values['accept-version-drift'] === true });
    console.log(out.lines.join('\n'));
    return out.exit;
  } catch (err) {
    console.error(`Could not resolve the package source — ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
