/**
 * `setup.mjs service-principal` end to end: the real entry point and the real spawn of `npx`, with a fake `npx` (a node script
 * first on PATH) standing in for the published CLI. Authorization-server discovery is answered by the local stub server.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { makeStateDir, REPO_ROOT, startStub } from './helpers.mjs';

const ORG = '11111111-2222-3333-4444-555555555555';
const mkTmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// Behaviour is picked by FAKE_NPX_MODE. It records its argv, and prints on stderr/stdout like the CLI.
const FAKE_NPX = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_NPX_ARGV, JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_NPX_MODE;
const ok = JSON.stringify({ sp_id: 'sp-e2e-1', path: '/cred/e2e.json', private_jwk: { d: 'SECRET' } });
if (mode === 'ok') {
  process.stderr.write('Sign in to continue. Open this URL in your browser:\\nhttps://auth.example/authorize\\n');
  setTimeout(() => { process.stdout.write('npm notice noise\\n' + ok + '\\n'); process.exit(0); }, 700);
} else if (mode === 'signal') {
  // Ctrl-C / SIGTERM reach the CLI as well; it carries on and reports.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  process.stderr.write('child-ready\\n');
  setTimeout(() => { process.stdout.write(ok + '\\n'); process.exit(0); }, 500);
} else if (mode === 'signal-fail') {
  process.on('SIGINT', () => {});
  process.stderr.write('child-ready\\n');
  setTimeout(() => {
    process.stderr.write('error: Interrupted. The server may or may not have applied the request: run noblecloak sp list to check.\\n');
    process.exit(3);
  }, 400);
} else if (mode === 'cancelled') {
  process.stderr.write('error: Sign-in was cancelled.\\n');
  process.exit(3);
} else if (mode === 'forbidden') {
  process.stderr.write('error: Forbidden: you are not an administrator of that organisation (FORBIDDEN: no).\\n');
  process.exit(4);
} else {
  process.exit(9);
}
`;

let stub;
let binDir;
before(async () => {
  stub = await startStub();
  stub.discoveryDoc = { issuer: 'https://auth.noblecloak.com' };
  binDir = mkTmp('sp-bin-');
  const npx = join(binDir, 'npx');
  writeFileSync(npx, FAKE_NPX);
  chmodSync(npx, 0o755);
});
after(async () => stub.close());

function jwt(claims) {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

/**
 * Starts setup.mjs service-principal. Returns { child, stderr (live), done: Promise<{code, stdout, stderr, times}>, argvFile }.
 * `onStderr(chunk, child)` sees each stderr chunk as it arrives.
 */
function start(mode, { args = [], onStderr = () => {} } = {}) {
  const state = makeStateDir();
  writeFileSync(join(state, 'auth.json'), JSON.stringify({ issuer: stub.url, accessToken: jwt({ sub: 'u1', org_id: ORG }), refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
  const home = mkTmp('sp-e2e-home-');
  const argvFile = join(home, 'argv.json');
  const env = {
    PATH: `${binDir}${delimiter}${process.env.PATH}`,
    HOME: home,
    NOBLECLOAK_STATE_DIR: state,
    NOBLECLOAK_ISSUER: stub.url,
    NOBLECLOAK_MCP_FILE: join(state, 'absent.json'),
    NOBLECLOAK_GOVERN_URL: 'https://govern.noblecloak.com',
    FAKE_NPX_MODE: mode,
    FAKE_NPX_ARGV: argvFile,
  };
  const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'setup.mjs'), 'service-principal', ...args], { env, cwd: mkTmp('sp-e2e-proj-') });
  const times = {};
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => {
    stderr += c;
    if (String(c).includes('Sign in to continue')) times.signInLink ??= Date.now();
    onStderr(String(c), child);
  });
  const done = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      times.close = Date.now();
      resolve({ code, signal, stdout, stderr, times });
    })
  );
  return { child, done, argvFile };
}

test('e2e: the CLI stderr (sign-in link) reaches the parent stderr live, stdout noise before the JSON is tolerated, exit 0', async () => {
  const { done, argvFile } = start('ok', { args: ['--name=-scratch agent'] });
  const r = await done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Sign in to continue\. Open this URL in your browser:\nhttps:\/\/auth\.example\/authorize/);
  // live: the link is on our stderr well before the child exits (it waits 700 ms), not flushed at the end
  assert.ok(r.times.close - r.times.signInLink >= 400, `the link arrived ${r.times.close - r.times.signInLink} ms before exit`);
  assert.match(r.stdout, /^Service principal created: sp-e2e-1$/m);
  assert.match(r.stdout, /^NOBLECLOAK_SP_CREDENTIALS=\/cred\/e2e\.json$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
  // the pinned CLI is what npx is asked for, with the leading-dash name attached to its flag
  const argv = JSON.parse(readFileSync(argvFile, 'utf-8'));
  assert.deepEqual(argv.slice(0, 4), ['-y', '@noblecloak/cli@0.1.2', 'sp', 'create']);
  assert.ok(argv.includes('--name=-scratch agent'));
  assert.ok(argv.includes('--auth-url=https://auth.noblecloak.com'));
  assert.ok(argv.includes('--admin-audience=https://admin-api.noblecloak.com'));
});

test('e2e: CLI exit codes map through the real spawn (3 cancelled sign-in -> 5, 4 -> 4, other -> 1)', async () => {
  const cancelled = await start('cancelled').done;
  assert.equal(cancelled.code, 5);
  assert.match(cancelled.stderr, /error: Sign-in was cancelled\./);
  assert.equal((await start('forbidden').done).code, 4);
  assert.equal((await start('other').done).code, 1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  test(`e2e: ${sig} to the plugin while the CLI runs does not lose the CLI's success result`, async () => {
    let sent = false;
    const { done } = start('signal', {
      onStderr: (chunk, child) => {
        if (!sent && chunk.includes('child-ready')) {
          sent = true;
          child.kill(sig);
        }
      },
    });
    const r = await done;
    assert.equal(sent, true);
    assert.equal(r.signal, null, `the plugin was killed by ${r.signal}`);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Service principal created: sp-e2e-1$/m);
  });
}

test('e2e: SIGINT during an interrupted create still shows the CLI "may or may not have applied" text and the recovery command', async () => {
  let sent = false;
  const { done } = start('signal-fail', {
    onStderr: (chunk, child) => {
      if (!sent && chunk.includes('child-ready')) {
        sent = true;
        child.kill('SIGINT');
      }
    },
  });
  const r = await done;
  assert.equal(r.signal, null);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /may or may not have applied the request/);
  assert.match(r.stderr, /npx -y @noblecloak\/cli@0\.1\.2 sp list --org=11111111-2222-3333-4444-555555555555 --auth-url=https:\/\/auth\.noblecloak\.com --admin-audience=https:\/\/admin-api\.noblecloak\.com/);
});

test('runCli removes its signal handlers when the child closes, and when npx cannot be spawned', async () => {
  const { runCli } = await import('../scripts/lib/service-principal.mjs');
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const env = { PATH: `${binDir}${delimiter}${process.env.PATH}`, FAKE_NPX_MODE: 'other', FAKE_NPX_ARGV: join(mkTmp('sp-lc-'), 'a.json') };
  const sink = { write() {} };
  assert.equal((await runCli(['x'], { env, stderrSink: sink })).status, 9);
  const missing = await runCli(['x'], { env: { PATH: mkTmp('sp-empty-') }, stderrSink: sink });
  assert.ok(missing.error);
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});
