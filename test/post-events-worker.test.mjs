/**
 * Worker-level tests for scripts/hooks/post-events-worker.mjs (finding #8).
 *
 * The worker is normally exercised end-to-end via the dispatcher, which always
 * writes a well-formed payload file. These tests spawn the worker DIRECTLY to
 * isolate its own defensive branches — a missing argv, an absent/malformed
 * payload file, and the handoff-file cleanup — which guard against a partially
 * written or vanished handoff (the dispatcher and worker race on the temp file).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { makeStateDir, readSpillRecords, runWorker, seedAuditRecord, startStub } from './helpers.mjs';
import { workerDeadlineMs } from '../scripts/hooks/post-events-worker.mjs';
import { CE_SOURCE_LOCAL_EXECUTION } from '../scripts/lib/governance.mjs';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── watchdog deadline parsing (finding #8/#7) ───────────────────────────────
//
// workerDeadlineMs() gates the hard process-level watchdog. A regression that
// inverts the finite/positive guard (e.g. dropping Number.isFinite, yielding NaN)
// would make setTimeout fire immediately → every worker self-terminates at t=0,
// dropping all in-band emits. The integration tests only ever pass an explicit
// override, which masks the parser, so the default + bad-env fallback are asserted
// here against the exported pure helper.

test('workerDeadlineMs: defaults to 10s when the env var is absent', () => {
  assert.equal(workerDeadlineMs({}), 10_000);
});

test('workerDeadlineMs: honors a valid positive override', () => {
  assert.equal(workerDeadlineMs({ NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS: '250' }), 250);
});

test('workerDeadlineMs: malformed/zero/negative env all fall back to 10s (never 0 or NaN)', () => {
  for (const bad of ['', 'abc', '0', '-5', '  ', 'NaN']) {
    const ms = workerDeadlineMs({ NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS: bad });
    assert.equal(ms, 10_000, `${JSON.stringify(bad)} → 10s fallback`);
    assert.ok(ms > 0, 'a deadline is never 0/NaN — that would self-terminate the worker at t=0');
  }
});

/** A Pre-side audit record (brief #4 shape) for a Bash call that resolved allow. */
function preRecord(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    hook_event: 'PreToolUse',
    session_id: SESSION_ID,
    tool_use_id: 'toolu_worker_test',
    tool_name: 'Bash',
    tool_ref: 'tool:claude-code:bash',
    cwd: '/tmp/project',
    bn_invocation_channel: 'interactive',
    arg_digest: 'a'.repeat(64),
    arg_summary: 'echo',
    enforce: false,
    resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' },
    decision: 'allow',
    would_decision: 'allow',
    degraded: false,
    ...overrides,
  };
}

/** Minimal in-band `:pre` envelope for tool_use_id `tid`. */
function preEnvelope(tid) {
  return { id: `${tid}:pre`, source: CE_SOURCE_LOCAL_EXECUTION, type: 'x', subject: SESSION_ID, data: {} };
}

/** Write a worker payload file and return its path. */
function writePayload(stateDir, payload) {
  const path = join(stateDir, 'audit-emit.worker-test.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

test('worker: no argv payload path → exit 0, no throw', async () => {
  const result = await runWorker([]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /no payload path/);
});

test('worker: payload path that does not exist → exit 0, no throw', async () => {
  const stateDir = makeStateDir();
  const missing = join(stateDir, 'does-not-exist.json');
  const result = await runWorker([missing]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /unreadable payload/);
});

test('worker: malformed JSON payload → exit 0, no throw, and the handoff file is removed', async () => {
  const stateDir = makeStateDir();
  const payload = join(stateDir, 'audit-emit.bad.json');
  writeFileSync(payload, 'this is not json');
  const result = await runWorker([payload], { NOBLECLOAK_STATE_DIR: stateDir });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /unreadable payload/);
  assert.equal(existsSync(payload), false, 'the handoff file is cleaned up even on a parse failure');
});

test('worker: well-formed empty payload (no envelopes, no drain) → exit 0, file removed', async () => {
  const stateDir = makeStateDir();
  const payload = join(stateDir, 'audit-emit.empty.json');
  writeFileSync(payload, JSON.stringify({ envelopes: [], drain: false }));
  const result = await runWorker([payload], { NOBLECLOAK_STATE_DIR: stateDir });
  assert.equal(result.code, 0);
  assert.equal(existsSync(payload), false, 'the handoff file is cleaned up after a successful run');
});

test('worker: a large spill trim logs the dropped count to stderr (finding #4)', async () => {
  const stateDir = makeStateDir();
  // An oversized pre-existing spill: the worker's early boundAuditSpill trims it
  // and must surface the drop count at the process level (the in-file marker is
  // in the very file being trimmed, so it is not enough on its own).
  const spillFile = join(stateDir, 'audit-spill.jsonl');
  for (let i = 0; i < 30; i += 1) appendFileSync(spillFile, `${JSON.stringify({ id: `old${i}:pre` })}\n`);
  const payload = join(stateDir, 'audit-emit.trim.json');
  writeFileSync(payload, JSON.stringify({ envelopes: [], drain: false }));
  const result = await runWorker([payload], { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_AUDIT_SPILL_RETENTION: '5' });

  assert.equal(result.code, 0);
  assert.match(result.stderr, /spill trimmed: dropped 25 forensic line\(s\)/, 'the dropped count is logged');
});

test('worker: a spill under the cap does NOT log a spurious trim line (finding #4)', async () => {
  const stateDir = makeStateDir();
  const spillFile = join(stateDir, 'audit-spill.jsonl');
  for (let i = 0; i < 3; i += 1) appendFileSync(spillFile, `${JSON.stringify({ id: `keep${i}:pre` })}\n`);
  const payload = join(stateDir, 'audit-emit.nocrim.json');
  writeFileSync(payload, JSON.stringify({ envelopes: [], drain: false }));
  const result = await runWorker([payload], { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_AUDIT_SPILL_RETENTION: '100' });

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /spill trimmed/, 'no trim log when nothing was dropped');
});

// ── degraded-FS error guards (findings #6, #7) ──────────────────────────────
//
// emitAuditEvent honors a never-throws contract, so the only way to reach the
// worker's drained-emit / per-envelope / compaction catch branches is an FS
// error in markPreShipped (append to audit-sent.jsonl) or compaction — exactly
// the full-/read-only-disk condition these guards exist for. We force it by
// making audit-sent.jsonl itself unwritable while the stub delivers a 200, so
// the :pre is DELIVERED and markPreShipped's append throws EACCES.

/** Make audit-sent.jsonl exist but unwritable so markPreShipped's append throws. */
function lockLedger(stateDir) {
  const ledger = join(stateDir, 'audit-sent.jsonl');
  writeFileSync(ledger, '');
  chmodSync(ledger, 0o400);
  return ledger;
}

test('worker: garbage NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS does NOT adopt a 0ms deadline — in-band emit still ships (finding #7)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const env = {
    NOBLECLOAK_STATE_DIR: stateDir,
    NOBLECLOAK_COO_URL: stub.url,
    NOBLECLOAK_DEV_TOKEN: 'tok',
    NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS: 'not-a-number',
  };
  const payload = writePayload(stateDir, {
    envelopes: [{ id: 'toolu_baddeadline:post', subject: SESSION_ID, data: {} }],
    drain: false,
  });
  try {
    const result = await runWorker([payload], env);
    assert.equal(result.code, 0);
    // A 0ms/NaN deadline would self-terminate before the emit; the 10s fallback
    // lets the emit complete normally against the fast stub.
    const events = await stub.waitForEvents(1);
    assert.deepEqual(events.map((e) => e.body.id), ['toolu_baddeadline:post'], 'the in-band emit shipped');
    assert.doesNotMatch(result.stderr, /worker deadline exceeded/, 'the watchdog did not fire at t=0');
  } finally {
    await stub.close();
  }
});

test('worker: in-band delivered :pre with an unwritable ledger → exit 0, post still ships, ship-catch logs (finding #7)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' };
  const ledger = lockLedger(stateDir);
  try {
    // No drain — isolate the in-band ship() path. A delivered :pre whose ledger
    // append throws must not strand the sibling :post.
    const payload = writePayload(stateDir, {
      envelopes: [preEnvelope('toolu_inband'), { id: 'toolu_inband:post', subject: SESSION_ID, data: {} }],
      drain: false,
    });
    const result = await runWorker([payload], env);
    assert.equal(result.code, 0, 'worker exits 0 despite the ledger-write failure');
    // Both envelopes reached the stub — one bad ship() did not strand the rest.
    const events = await stub.waitForEvents(2);
    const ids = events.map((e) => e.body.id).sort();
    assert.deepEqual(ids, ['toolu_inband:post', 'toolu_inband:pre']);
    assert.match(result.stderr, /emit failed/, 'the per-envelope ship() catch logged');
  } finally {
    chmodSync(ledger, 0o600);
    await stub.close();
  }
});

test('worker: drained delivered :pre with an unwritable ledger → exit 0, drained-emit catch logs (finding #6)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' };
  // Seed a queued, unshipped Pre so the drain has something to deliver.
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_drain' }));
  const ledger = lockLedger(stateDir);
  try {
    // drain:true, no in-band envelopes — the drained :pre delivers (200) and its
    // markPreShipped append throws; the worker's drained-emit catch must absorb it.
    const payload = writePayload(stateDir, { envelopes: [], drain: true });
    const result = await runWorker([payload], env);
    assert.equal(result.code, 0, 'worker exits 0 despite the drained ledger-write failure');
    await stub.waitForEvents(1); // the drained :pre still reached ingest
    assert.match(result.stderr, /drained emit failed/, 'the drained-emit catch logged');
  } finally {
    chmodSync(ledger, 0o600);
    await stub.close();
  }
});

test('worker: compaction failure on a degraded FS → exit 0, compaction-failed logged (finding #6)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' };
  // Force compaction to actually run AND to fail: a prunable queue (so it tries
  // to rewrite) under a read-only state dir (so the temp+rename throws).
  for (let i = 0; i < 260; i += 1) {
    await seedAuditRecord(stateDir, preRecord({ tool_use_id: `s${i}` }));
    const { markPreShipped } = await import('../scripts/lib/governance.mjs');
    markPreShipped(`s${i}`, { NOBLECLOAK_STATE_DIR: stateDir });
  }
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'live' }));
  const payload = writePayload(stateDir, { envelopes: [], drain: true });
  // Read-only state dir: atomicWriteFileSync's temp create throws, and the
  // tryAcquireLock O_EXCL create throws too — compaction is a guarded best-effort
  // no-op either way, and the worker must still exit 0.
  chmodSync(stateDir, 0o500);
  try {
    const result = await runWorker([payload], env);
    assert.equal(result.code, 0, 'worker exits 0 even when compaction cannot write');
  } finally {
    chmodSync(stateDir, 0o700);
    await stub.close();
  }
});

// ── adv-5: a sign-out mid-drain stops the loop ──────────────────────────────

test('worker: a grant rejected on the first drained emit stops the drain — one POST, the rest not re-spilled', async () => {
  const stub = await startStub();
  stub.eventStatus = 401; // COO refuses the token…
  stub.tokenStatus = 400; // …and the refresh grant is dead
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const stateDir = makeStateDir();
  writeFileSync(
    join(stateDir, 'auth.json'),
    JSON.stringify({ issuer: stub.url, accessToken: 'revoked', refreshToken: 'dead', expiresAt: Date.now() + 3_600_000 })
  );
  const env = { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_ISSUER: stub.url };
  for (let i = 0; i < 3; i += 1) {
    await seedAuditRecord(stateDir, preRecord({ tool_use_id: `toolu_so_${i}`, ts: new Date(Date.now() - (3 - i) * 1000).toISOString() }));
  }
  try {
    const payload = writePayload(stateDir, { envelopes: [], drain: true });
    const result = await runWorker([payload], env);
    assert.equal(result.code, 0);
    assert.ok(existsSync(join(stateDir, 'signed-out.json')), 'the rejected grant signed the plugin out');
    assert.equal(stub.eventRequests().length, 1, 'no events POST after the sign-out');
    assert.equal(readSpillRecords(stateDir).length, 1, 'only the attempted record is spilled; the rest stay queued');
  } finally {
    await stub.close();
  }
});
