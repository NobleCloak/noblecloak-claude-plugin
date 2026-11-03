/**
 * One-time migration of an earlier install's state into ~/.noblecloak/claude-plugin
 * (QC-B1). Every test runs against a scratch `home` and a scratch plugin root;
 * nothing here reads or writes the real home directory.
 */
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIGRATED_STATE_FILES,
  MIGRATION_MARKER,
  defaultStateDir,
  migrateLegacyState,
  readMigrationMarker,
} from '../scripts/lib/governance.mjs';
import { REPO_ROOT } from './helpers.mjs';

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'nc-migrate-'));
  const home = join(root, 'home');
  const pluginRoot = join(root, 'checkout');
  mkdirSync(home, { recursive: true });
  mkdirSync(pluginRoot, { recursive: true });
  return { root, home, pluginRoot, dest: defaultStateDir(home) };
}

function writeState(dir, files, { mtimeSec = null } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const file = join(dir, name);
    writeFileSync(file, body, { mode: 0o644 }); // deliberately NOT 0600
    if (mtimeSec !== null && name === 'auth.json') utimesSync(file, mtimeSec, mtimeSec);
  }
}

const mode = (file) => statSync(file).mode & 0o777;

test('default state dir is ~/.noblecloak/claude-plugin, and NOBLECLOAK_STATE_DIR still wins', async () => {
  const { home } = scratch();
  assert.equal(defaultStateDir(home), join(home, '.noblecloak', 'claude-plugin'));
  const { stateDir } = await import('../scripts/lib/governance.mjs');
  assert.equal(stateDir({ NOBLECLOAK_STATE_DIR: '/x/y' }), '/x/y');
});

test('moves every state file from <pluginRoot>/.local, keeps 0600, writes the marker, never deletes the old dir', () => {
  const { home, pluginRoot, dest } = scratch();
  const old = join(pluginRoot, '.local');
  writeState(old, {
    'auth.json': '{"accessToken":"a"}',
    'client.json': '{"clientId":"c"}',
    'audit-queue.jsonl': '{"q":1}\n',
    'audit-spill.jsonl': '{"s":1}\n',
    'audit-sent.jsonl': '{"id":"t"}\n',
    'audit-dead.jsonl': '{"d":1}\n',
    'audit-breaker.json': '{"phase":"closed"}',
    'refresh-backoff.json': '{}',
    'notices.json': '{}',
    'signed-out.json': '{}',
    'audit-runs.json': '{}',
    'auth-401.json': '{}',
    'audit-health.json': '{}',
  });
  const result = migrateLegacyState({ env: {}, pluginRoot, home });
  assert.equal(result.status, 'migrated');
  assert.equal(result.source, old);
  assert.deepEqual([...result.moved].sort(), [...MIGRATED_STATE_FILES].sort());
  for (const name of MIGRATED_STATE_FILES) {
    assert.ok(existsSync(join(dest, name)), `${name} moved`);
    assert.ok(!existsSync(join(old, name)), `${name} no longer in the old dir`);
    assert.equal(mode(join(dest, name)), 0o600, `${name} is 0600`);
  }
  assert.equal(readFileSync(join(dest, 'auth.json'), 'utf-8'), '{"accessToken":"a"}');
  assert.equal(mode(join(dest, 'migrated-from')), 0o600);
  assert.equal(readMigrationMarker({ NOBLECLOAK_STATE_DIR: dest })?.source, old);
  assert.ok(existsSync(old), 'the old directory is never deleted');
  assert.match(result.message, new RegExp(`moved plugin state from ${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to`));
});

test('is idempotent: a second run is a no-op and does not touch the moved files', () => {
  const { home, pluginRoot, dest } = scratch();
  writeState(join(pluginRoot, '.local'), { 'auth.json': '{"v":1}', 'audit-queue.jsonl': 'x\n' });
  assert.equal(migrateLegacyState({ env: {}, pluginRoot, home }).status, 'migrated');
  writeFileSync(join(dest, 'audit-queue.jsonl'), 'newer\n');
  // Even with fresh state reappearing in the old place, a present auth.json ends it.
  writeState(join(pluginRoot, '.local'), { 'auth.json': '{"v":2}' });
  const again = migrateLegacyState({ env: {}, pluginRoot, home });
  assert.equal(again.status, 'present');
  assert.equal(again.message, null);
  assert.equal(readFileSync(join(dest, 'auth.json'), 'utf-8'), '{"v":1}');
  assert.equal(readFileSync(join(dest, 'audit-queue.jsonl'), 'utf-8'), 'newer\n');
  assert.equal(readFileSync(join(pluginRoot, '.local', 'auth.json'), 'utf-8'), '{"v":2}');
});

test('migrates exactly one candidate: the one holding an auth.json; others are left alone and named', () => {
  const { root, home, pluginRoot, dest } = scratch();
  const checkout = join(pluginRoot, '.local');
  const explicit = join(root, 'moved-checkout', '.local');
  writeState(checkout, { 'auth.json': 'checkout', 'audit-queue.jsonl': 'checkout-q\n' });
  writeState(explicit, { 'audit-queue.jsonl': 'stale-q\n', 'audit-spill.jsonl': 'stale-s\n' }); // no auth.json
  const result = migrateLegacyState({ env: { NOBLECLOAK_MIGRATE_FROM: explicit }, pluginRoot, home });
  assert.equal(result.source, checkout);
  assert.equal(readFileSync(join(dest, 'auth.json'), 'utf-8'), 'checkout');
  assert.equal(readFileSync(join(dest, 'audit-queue.jsonl'), 'utf-8'), 'checkout-q\n');
  assert.ok(!existsSync(join(dest, 'audit-spill.jsonl')), 'the other candidate\'s files are not merged in');
  assert.ok(existsSync(join(explicit, 'audit-queue.jsonl')) && existsSync(join(explicit, 'audit-spill.jsonl')));
  assert.ok(result.message.includes(explicit), 'the unchosen candidate is named');
  assert.match(result.message, /Left in place, not chosen/);
});

test('NOBLECLOAK_MIGRATE_FROM is a candidate and wins when it holds an auth.json', () => {
  const { root, home, pluginRoot, dest } = scratch();
  const explicit = join(root, 'moved-checkout', '.local');
  writeState(explicit, { 'auth.json': 'explicit', 'client.json': 'ec' }, { mtimeSec: 1_000_000_000 });
  writeState(join(pluginRoot, '.local'), { 'auth.json': 'checkout' }, { mtimeSec: 2_000_000_000 });
  const result = migrateLegacyState({ env: { NOBLECLOAK_MIGRATE_FROM: explicit }, pluginRoot, home });
  assert.equal(result.source, explicit);
  assert.equal(readFileSync(join(dest, 'auth.json'), 'utf-8'), 'explicit');
  assert.equal(readFileSync(join(dest, 'client.json'), 'utf-8'), 'ec');
});

test('no candidate has an auth.json: migrates nothing, one line lists the candidates found', () => {
  const { home, pluginRoot, dest } = scratch();
  const stale = join(pluginRoot, '.local');
  writeState(stale, { 'audit-queue.jsonl': 'q\n', 'audit-spill.jsonl': 's\n' });
  const result = migrateLegacyState({ env: {}, pluginRoot, home });
  assert.equal(result.status, 'no-auth');
  assert.ok(!existsSync(dest) || readdirSync(dest).length === 0, 'nothing written to the new directory');
  assert.ok(existsSync(join(stale, 'audit-queue.jsonl')), 'stale files stay');
  assert.equal(result.message, null, 'not shown at every session start or hook run');
  assert.ok(result.detail.includes(stale) && result.detail.includes('audit-queue.jsonl'));
  assert.ok(!result.detail.includes('\n'), 'one line');
});

test('nothing to migrate and no candidate directory: silent', () => {
  const { home, pluginRoot, dest } = scratch();
  const result = migrateLegacyState({ env: {}, pluginRoot, home });
  assert.equal(result.status, 'none');
  assert.equal(result.message, null);
  assert.ok(!existsSync(dest));
});

test('NOBLECLOAK_STATE_DIR set: no migration (the person chose the location)', () => {
  const { home, pluginRoot, dest } = scratch();
  writeState(join(pluginRoot, '.local'), { 'auth.json': 'a' });
  const result = migrateLegacyState({ env: { NOBLECLOAK_STATE_DIR: join(home, 'custom') }, pluginRoot, home });
  assert.equal(result.status, 'override');
  assert.ok(existsSync(join(pluginRoot, '.local', 'auth.json')));
  assert.ok(!existsSync(dest));
});

test('never overwrites a file already at the destination, and never moves lock files', () => {
  const { home, pluginRoot, dest } = scratch();
  const old = join(pluginRoot, '.local');
  writeState(old, { 'auth.json': 'a', 'audit-queue.jsonl': 'old-q\n', 'auth.json.lock': '123', 'audit-drain.lock': '1' });
  writeState(dest, { 'audit-queue.jsonl': 'new-q\n' }); // a hook already wrote here before the migration ran
  const result = migrateLegacyState({ env: {}, pluginRoot, home });
  assert.equal(result.status, 'migrated');
  assert.equal(readFileSync(join(dest, 'audit-queue.jsonl'), 'utf-8'), 'new-q\n');
  assert.equal(readFileSync(join(old, 'audit-queue.jsonl'), 'utf-8'), 'old-q\n');
  assert.ok(result.leftBehind.includes(join(old, 'audit-queue.jsonl')));
  assert.ok(result.message.includes('Not moved'));
  assert.ok(existsSync(join(old, 'auth.json.lock')) && existsSync(join(old, 'audit-drain.lock')));
  assert.ok(!existsSync(join(dest, 'auth.json.lock')));
});

test('logging out after a migration is not undone: a sign-in left in a non-chosen candidate stays put', () => {
  const { root, home, pluginRoot, dest } = scratch();
  const env = { NOBLECLOAK_MIGRATE_FROM: join(root, 'moved-checkout', '.local') };
  writeState(env.NOBLECLOAK_MIGRATE_FROM, { 'auth.json': '{"v":"explicit"}' });
  writeState(join(pluginRoot, '.local'), { 'auth.json': '{"v":"left"}' });
  assert.equal(migrateLegacyState({ env, pluginRoot, home }).status, 'migrated');
  unlinkSync(join(dest, 'auth.json')); // what /noblecloak-logout does
  const again = migrateLegacyState({ env, pluginRoot, home });
  assert.equal(again.status, 'done');
  assert.equal(again.message, null);
  assert.ok(!existsSync(join(dest, 'auth.json')));
  assert.equal(readFileSync(join(pluginRoot, '.local', 'auth.json'), 'utf-8'), '{"v":"left"}');
});

test('wiring: /noblecloak-logout before any migration clears the old sign-in for good', async () => {
  const { root, home, pluginRoot, dest } = scratch();
  const old = oldInstallWithAuth(root);
  const out = await runNode([join(REPO_ROOT, 'scripts', 'logout.mjs')], { NOBLECLOAK_MIGRATE_FROM: old }, home);
  assert.equal(out.code, 0);
  assert.ok(out.stdout.includes('Governance token cleared'));
  assert.ok(!existsSync(join(dest, 'auth.json')) && !existsSync(join(old, 'auth.json')));
  const later = migrateLegacyState({ env: { NOBLECLOAK_MIGRATE_FROM: old }, pluginRoot, home });
  assert.equal(later.status, 'done');
  assert.ok(!existsSync(join(dest, 'auth.json')));
});

test('auth.json that cannot be moved: status failed, no marker, nothing claimed as migrated, retried later', { skip: process.getuid?.() === 0 }, () => {
  const { home, pluginRoot, dest } = scratch();
  const old = join(pluginRoot, '.local');
  writeState(old, { 'auth.json': '{"v":1}', 'audit-queue.jsonl': 'q\n' });
  chmodSync(old, 0o500); // rename needs write permission on the source directory
  try {
    const result = migrateLegacyState({ env: {}, pluginRoot, home });
    assert.equal(result.status, 'failed');
    assert.ok(!result.moved.includes('auth.json'));
    assert.ok(!result.message.includes('moved plugin state'));
    assert.ok(!existsSync(join(dest, MIGRATION_MARKER)));
    assert.equal(readMigrationMarker({ NOBLECLOAK_STATE_DIR: dest }), null);
  } finally {
    chmodSync(old, 0o700);
  }
  assert.equal(migrateLegacyState({ env: {}, pluginRoot, home }).status, 'migrated');
});

// ── wiring: the entry points actually call it, with a scratch HOME ─────────

function runNode(args, env, home) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NOBLECLOAK_')));
    const child = spawn(process.execPath, args, { env: { ...clean, HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function oldInstallWithAuth(root) {
  const old = join(root, 'old-checkout', '.local');
  writeState(old, {
    'auth.json': JSON.stringify({
      accessToken: 'x.y.z',
      refreshToken: 'r',
      expiresAt: Date.now() - 60_000, // expired: status skips the network probe
      authenticatedAt: new Date().toISOString(),
    }),
  });
  return old;
}

test('wiring: /noblecloak-status migrates, names the source and reports the state directory', async () => {
  const { root, home, dest } = scratch();
  const old = oldInstallWithAuth(root);
  const { code, stdout } = await runNode([join(REPO_ROOT, 'scripts', 'status.mjs')], { NOBLECLOAK_MIGRATE_FROM: old }, home);
  assert.equal(code, 0);
  assert.ok(stdout.includes(`State directory: ${dest}`));
  assert.ok(stdout.includes(`moved plugin state from ${old}`));
  assert.ok(existsSync(join(dest, 'auth.json')) && !existsSync(join(old, 'auth.json')));
  // second run: no migration line, but the marker still says where it came from
  const again = await runNode([join(REPO_ROOT, 'scripts', 'status.mjs')], { NOBLECLOAK_MIGRATE_FROM: old }, home);
  assert.ok(!again.stdout.includes('moved plugin state'));
  assert.ok(again.stdout.includes(`State migrated from ${old}`));
});

test('wiring: /noblecloak-status shows the no-auth listing of old directories (the only place it is shown)', async () => {
  const { root, home } = scratch();
  const old = join(root, 'old-checkout', '.local');
  writeState(old, { 'client.json': '{"clientId":"c"}' }); // old state without auth.json
  const { code, stdout } = await runNode([join(REPO_ROOT, 'scripts', 'status.mjs')], { NOBLECLOAK_MIGRATE_FROM: old }, home);
  assert.equal(code, 0);
  assert.ok(stdout.includes('no earlier sign-in to migrate'), stdout);
  assert.ok(stdout.includes(old), 'names the old directory');
});

test('wiring: the SessionStart refresh migrates and tells the user in systemMessage', async () => {
  const { root, home, dest } = scratch();
  const old = oldInstallWithAuth(root);
  const { stdout } = await runNode([join(REPO_ROOT, 'scripts', 'refresh.mjs')], { NOBLECLOAK_MIGRATE_FROM: old, NOBLECLOAK_ISSUER: 'http://127.0.0.1:1' }, home);
  assert.ok(existsSync(join(dest, 'auth.json')));
  const first = stdout.trim().split('\n')[0];
  assert.ok(JSON.parse(first).systemMessage.includes(`moved plugin state from ${old}`));
});

test('wiring: a hook-side loadAuthState finds the old sign-in without a SessionStart refresh', async () => {
  const { root, home, dest } = scratch();
  const old = oldInstallWithAuth(root);
  const code =
    `import { loadAuthState } from ${JSON.stringify(join(REPO_ROOT, 'scripts', 'lib', 'governance.mjs'))};` +
    'process.stdout.write(String(loadAuthState()?.refreshToken ?? null));';
  const { stdout } = await runNode(['--input-type=module', '-e', code], { NOBLECLOAK_MIGRATE_FROM: old }, home);
  assert.equal(stdout, 'r');
  assert.ok(existsSync(join(dest, 'auth.json')));
});

test('wiring (source scan; login needs a browser): login.mjs migrates before it starts the OAuth flow', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'login.mjs'), 'utf-8');
  const migrate = src.indexOf('migrateLegacyState()');
  const login = src.indexOf('await login()');
  assert.ok(migrate !== -1 && login !== -1, 'both calls present');
  assert.ok(migrate < login, 'migration runs before login()');
});

/** Runs fn with fs.renameSync throwing EXDEV for every source except the migration's own temp name. */
function withExdev(fn) {
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).includes('.migrating-')) return real(from, to);
    const e = new Error('EXDEV');
    e.code = 'EXDEV';
    throw e;
  };
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
}

test('cross-filesystem move (EXDEV): destination file is 0600, source removed, no temp left', () => {
  const { home, pluginRoot, dest } = scratch();
  const old = join(pluginRoot, '.local');
  writeState(old, { 'auth.json': '{"accessToken":"OLD"}' });
  const result = withExdev(() => migrateLegacyState({ env: {}, pluginRoot, home }));
  assert.equal(result.status, 'migrated');
  assert.equal(mode(join(dest, 'auth.json')), 0o600);
  assert.ok(!existsSync(join(old, 'auth.json')));
  assert.deepEqual(readdirSync(dest).filter((f) => f.includes('.migrating-')), []);
});

test('cross-filesystem move whose source cannot be unlinked: nothing is left in the destination', { skip: process.getuid?.() === 0 }, () => {
  const { home, pluginRoot, dest } = scratch();
  const old = join(pluginRoot, '.local');
  writeState(old, { 'auth.json': '{"accessToken":"OLD"}' });
  chmodSync(old, 0o500); // unlink needs write permission on the source directory
  try {
    const result = withExdev(() => migrateLegacyState({ env: {}, pluginRoot, home }));
    assert.equal(result.status, 'failed');
    assert.deepEqual(readdirSync(dest), [], 'no auth.json, no temp copy, no marker');
  } finally {
    chmodSync(old, 0o700);
  }
});
