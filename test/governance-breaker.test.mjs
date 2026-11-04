/**
 * Circuit breaker (brief 2026-06-15 D1) — pure state-machine unit tests.
 *
 * The breaker shares state across INDEPENDENT detached workers via a small
 * state file, so its transitions are exercised here directly (no network): a
 * run of consecutive emit failures opens it, a cooldown elapses to half-open,
 * a probe success closes it, a probe failure re-opens it. Increment races
 * across workers are tolerated by design — the load-bearing property is "once
 * open, every reader fast-fails," not an exact count.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUDIT_BREAKER_THRESHOLD,
  AUDIT_BREAKER_COOLDOWN_MS,
  breakerStatePath,
  emitAuditEvent,
  EMIT_DELIVERED,
  EMIT_SPILLED,
  readBreaker,
  recordBreakerFailure,
  recordBreakerSuccess,
  classifyEmitFailure,
  EMIT_REJECTED,
  isRunRejected,
  readAuditHealth,
  readAuditRuns,
  takeNotices,
  BREAKER_OPEN_MESSAGE,
  TENANT_RUN_MISMATCH_MESSAGE,
  AUDIT_RUN_REJECTION_TTL_MS,
} from '../scripts/lib/governance.mjs';

import { makeStateDir, readSpillRecords, startStub, REPO_ROOT } from './helpers.mjs';

/** Raw `{ failures, openedAt }` from disk, or null if no breaker file yet. */
function readBreakerFile(dir) {
  const f = breakerStatePath({ NOBLECLOAK_STATE_DIR: dir });
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null;
}

function env(stateDir, extra = {}) {
  return { NOBLECLOAK_STATE_DIR: stateDir, ...extra };
}

test('breaker defaults: no state file → closed, zero failures', () => {
  const e = env(makeStateDir());
  const b = readBreaker(e, 1000);
  assert.equal(b.phase, 'closed');
  assert.equal(b.failures, 0);
  assert.equal(b.openedAt, null);
});

test('K consecutive failures trip the breaker open', () => {
  const e = env(makeStateDir(), { NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '3', NOBLECLOAK_AUDIT_BREAKER_COOLDOWN_MS: '1000' });
  recordBreakerFailure(e, 100);
  recordBreakerFailure(e, 100);
  assert.equal(readBreaker(e, 100).phase, 'closed', 'still closed below threshold');
  recordBreakerFailure(e, 100);
  const b = readBreaker(e, 100);
  assert.equal(b.phase, 'open', 'open at threshold');
  assert.equal(b.openedAt, 100);
});

test('open breaker stays open until the cooldown elapses, then half-opens', () => {
  const e = env(makeStateDir(), { NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '1', NOBLECLOAK_AUDIT_BREAKER_COOLDOWN_MS: '1000' });
  recordBreakerFailure(e, 5000); // opens at 5000
  assert.equal(readBreaker(e, 5500).phase, 'open', 'within cooldown → open (fast-fail)');
  assert.equal(readBreaker(e, 5999).phase, 'open', 'just before cooldown end → open');
  assert.equal(readBreaker(e, 6000).phase, 'half_open', 'at cooldown end → half-open (probe)');
  assert.equal(readBreaker(e, 9000).phase, 'half_open', 'well past cooldown → still half-open until a probe resolves it');
});

test('a probe success closes the breaker and clears the failure count', () => {
  const e = env(makeStateDir(), { NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '1', NOBLECLOAK_AUDIT_BREAKER_COOLDOWN_MS: '1000' });
  recordBreakerFailure(e, 5000);
  assert.equal(readBreaker(e, 6000).phase, 'half_open');
  recordBreakerSuccess(e);
  const b = readBreaker(e, 6000);
  assert.equal(b.phase, 'closed');
  assert.equal(b.failures, 0);
  assert.equal(b.openedAt, null);
});

test('a probe failure re-opens the breaker and re-arms the cooldown', () => {
  const e = env(makeStateDir(), { NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '1', NOBLECLOAK_AUDIT_BREAKER_COOLDOWN_MS: '1000' });
  recordBreakerFailure(e, 5000); // open at 5000
  assert.equal(readBreaker(e, 6000).phase, 'half_open');
  recordBreakerFailure(e, 6000); // probe failed → re-open at 6000
  assert.equal(readBreaker(e, 6500).phase, 'open', 're-armed cooldown keeps it open');
  assert.equal(readBreaker(e, 7000).phase, 'half_open', 'half-opens again one cooldown later');
});

test('a success while closed keeps it closed and resets any partial failure run', () => {
  const e = env(makeStateDir(), { NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '3' });
  recordBreakerFailure(e, 100);
  recordBreakerFailure(e, 100);
  recordBreakerSuccess(e); // partial run interrupted by a success
  assert.equal(readBreaker(e, 100).failures, 0, 'partial failure run cleared');
  recordBreakerFailure(e, 100);
  assert.equal(readBreaker(e, 100).phase, 'closed', 'needs a fresh full run to trip');
});

test('threshold and cooldown honor env overrides; defaults are exported', () => {
  assert.equal(typeof AUDIT_BREAKER_THRESHOLD, 'number');
  assert.equal(typeof AUDIT_BREAKER_COOLDOWN_MS, 'number');
  const e = env(makeStateDir(), { NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '2', NOBLECLOAK_AUDIT_BREAKER_COOLDOWN_MS: '50' });
  recordBreakerFailure(e, 0);
  assert.equal(readBreaker(e, 0).phase, 'closed');
  recordBreakerFailure(e, 0);
  assert.equal(readBreaker(e, 0).phase, 'open');
  assert.equal(readBreaker(e, 50).phase, 'half_open', 'short env cooldown respected');
});

test('a corrupt breaker state file is read as closed (never throws)', () => {
  const dir = makeStateDir();
  const e = env(dir);
  writeFileSync(breakerStatePath(e), '{ this is not json');
  const b = readBreaker(e, 1000);
  assert.equal(b.phase, 'closed');
  assert.equal(b.failures, 0);
});

// ── half-open single-flight probe (finding #2: no thundering-herd probe) ─────
//
// When the cooldown elapses the phase flips to half_open for EVERY reader at
// once. Without a gate, every concurrent emit (across detached workers AND across
// the concurrent emits inside one worker's Promise.allSettled) would hit the
// still-down COO with the full 2s timeout simultaneously — the exact meltdown the
// breaker exists to prevent. emitAuditEvent must gate the probe to ONE in-flight
// network call via a non-blocking probe lock; readers that can't take it spill.

/** Put the breaker into half_open: opened far enough in the past to be past cooldown. */
function seedHalfOpen(dir) {
  const e = env(dir);
  // openedAt one hour ago, with a default 30s cooldown → readBreaker() (which uses
  // Date.now()) sees half_open.
  writeFileSync(breakerStatePath(e), JSON.stringify({ failures: 99, openedAt: Date.now() - 3_600_000 }));
}

test('half-open: a reader that cannot take the probe lock spills and never hits the network', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
  seedHalfOpen(dir);
  assert.equal(readBreaker(e).phase, 'half_open', 'precondition: breaker is half-open');

  // Simulate another emit already probing by holding the probe lock.
  writeFileSync(join(dir, 'audit-breaker-probe.lock'), 'someone-else');
  try {
    const status = await emitAuditEvent({ id: 'toolu_ho:pre' }, e);
    assert.equal(status, EMIT_SPILLED, 'lock held by the in-flight probe → this reader fast-fails');
    assert.equal(stub.eventRequests().length, 0, 'no network call — the probe is single-flight');
    const spilled = readSpillRecords(dir).map((r) => r.id);
    assert.ok(spilled.includes('toolu_ho:pre'), 'the envelope was spilled, not dropped');
  } finally {
    await stub.close();
  }
});

test('half-open: the single probe that takes the lock hits the network and a 2xx closes the breaker', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
  seedHalfOpen(dir);

  // Probe lock is free → exactly this emit probes; a 2xx closes the breaker.
  const status = await emitAuditEvent({ id: 'toolu_probe:post' }, e);
  await stub.close();

  assert.equal(status, EMIT_DELIVERED, 'the probe delivered');
  assert.equal(stub.eventRequests().length, 1, 'exactly one probe reached the network');
  const b = readBreaker(e);
  assert.equal(b.phase, 'closed', 'a successful probe closed the breaker');
  assert.equal(b.failures, 0);
});

test('half-open: the probe lock is released after the attempt so the next event can probe again', async () => {
  const stub = await startStub();
  stub.eventStatus = 503; // probe fails → re-arms the cooldown, frees the lock
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
  seedHalfOpen(dir);

  const status = await emitAuditEvent({ id: 'toolu_fail:post' }, e);
  await stub.close();

  assert.equal(status, EMIT_SPILLED, 'the failed probe spilled');
  // The probe lock must NOT leak — it is released in finally regardless of the
  // network outcome, so a later half-open window can probe again.
  assert.equal(
    existsSync(join(dir, 'audit-breaker-probe.lock')),
    false,
    'the probe lock was released after the failed probe'
  );
});

test('half-open: a 2xx closes the breaker AND releases the probe lock (success-path release)', async () => {
  // The release lives in a `finally`, so it must fire on the SUCCESS path too —
  // not only on failure. If a regression moved releaseLock into the failure/catch
  // branches only, a successful probe would LEAK the lock; harmless while closed,
  // but once the breaker re-opens and re-enters half-open the stale leftover lock
  // blocks the next probe until its 5s stale window elapses, delaying recovery.
  const stub = await startStub();
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
  seedHalfOpen(dir);

  const status = await emitAuditEvent({ id: 'toolu_ok:post' }, e);
  await stub.close();

  assert.equal(status, EMIT_DELIVERED, 'the probe delivered');
  assert.equal(readBreaker(e).phase, 'closed', 'a successful probe closed the breaker');
  assert.equal(
    existsSync(join(dir, 'audit-breaker-probe.lock')),
    false,
    'the probe lock was released after the DELIVERED probe (finally fires on success too)'
  );
});

test('half-open: a STALE (crashed-prober) probe lock is stolen — this emit spills, the next can probe', async () => {
  // tryAcquireLock on a stale lock STEALS (removes) it but still returns null, so
  // the stealing emit spills WITHOUT a network call this round; a subsequent emit
  // then finds a free lock and probes. If the steal branch regressed for the probe
  // lock specifically, a crashed prober's lock would wedge half-open recovery far
  // longer than the 5s stale window.
  const stub = await startStub();
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
  seedHalfOpen(dir);

  // A leftover probe lock from a crashed prober, backdated past the 5s stale window.
  const lockPath = join(dir, 'audit-breaker-probe.lock');
  writeFileSync(lockPath, 'crashed-prober');
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lockPath, old, old);

  // First emit: detects the stale lock, steals (frees) it, but spills this round.
  const first = await emitAuditEvent({ id: 'toolu_stale1:post' }, e);
  assert.equal(first, EMIT_SPILLED, 'the stealing emit spills (steal-but-do-not-reacquire)');
  assert.equal(stub.eventRequests().length, 0, 'no network on the steal round');
  assert.equal(existsSync(lockPath), false, 'the stale crashed-prober lock was stolen (removed)');
  assert.ok(
    readSpillRecords(dir).map((r) => r.id).includes('toolu_stale1:post'),
    'the envelope was spilled, not dropped'
  );

  // Second emit: lock is now free → it probes; a 2xx closes the breaker.
  const second = await emitAuditEvent({ id: 'toolu_stale2:post' }, e);
  await stub.close();
  assert.equal(second, EMIT_DELIVERED, 'a follow-up emit probes once the stale lock is gone');
  assert.equal(stub.eventRequests().length, 1, 'exactly one probe reached the network');
  assert.equal(readBreaker(e).phase, 'closed', 'the probe closed the breaker');
});

// ── open-path zero-write invariant (recovery clock must keep advancing) ──────
//
// The open-breaker branch of emitAuditEvent spills and returns BEFORE any breaker
// write — deliberately NOT recording a failure. This is the load-bearing recovery
// invariant: if the open path also recorded a failure, every fast-failed emit
// during the outage would re-arm openedAt to `now`, so `now - openedAt >= cooldown`
// would never become true — the breaker would never half-open and recovery would
// be permanently wedged under sustained fan-out (the meltdown scenario).

test('open: a fast-failed emit performs ZERO breaker writes (openedAt + failures unchanged)', async () => {
  const stub = await startStub();
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
  // Seed an OPEN breaker with a fixed openedAt well inside the (default 30s) cooldown.
  const openedAt = Date.now();
  writeFileSync(breakerStatePath(e), JSON.stringify({ failures: 7, openedAt }));
  assert.equal(readBreaker(e).phase, 'open', 'precondition: breaker is open');

  for (let i = 0; i < 5; i += 1) {
    const status = await emitAuditEvent({ id: `toolu_open${i}:post` }, e);
    assert.equal(status, EMIT_SPILLED, 'open → fast-fail spill');
  }
  await stub.close();

  assert.equal(stub.eventRequests().length, 0, 'open path never hits the network');
  const raw = readBreakerFile(dir);
  assert.equal(raw.openedAt, openedAt, 'openedAt is byte-for-byte unchanged — the cooldown clock keeps advancing');
  assert.equal(raw.failures, 7, 'failures did not increment — the open path records nothing');
});

// ── cooldown floor (a 0/invalid env never voids the open phase) ──────────────

test('breaker cooldown: a 0/negative/malformed env override falls back to the default (open phase is never voided)', () => {
  // cooldownMs===0 would make readBreaker classify half_open the instant the
  // breaker opens, so the "open" fast-fail phase could never be observed. The
  // guard must require > 0 (like the threshold), falling back to the default.
  for (const bad of ['0', '-1', '', 'abc']) {
    const e = env(makeStateDir(), { NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '1', NOBLECLOAK_AUDIT_BREAKER_COOLDOWN_MS: bad });
    recordBreakerFailure(e, 1000); // opens at 1000
    assert.equal(
      readBreaker(e, 1000).phase,
      'open',
      `${JSON.stringify(bad)} → default cooldown, so the breaker is OPEN at openedAt (not instantly half_open)`
    );
    assert.equal(
      readBreaker(e, 1000 + AUDIT_BREAKER_COOLDOWN_MS).phase,
      'half_open',
      'half-opens only after the full default cooldown elapses'
    );
  }
});

// ── Permanent rejections are not outages (auth/audit hygiene 2026-10-20) ────
//
// The incident: after a re-login switched the default org, every queued event
// referenced a run seeded in the OLD org; COO answered each with 403
// tenant_run_mismatch (BN004), the drain re-posted them forever, and the
// breaker opened silently. A refusal with a RECOGNISED code (403
// tenant_run_mismatch, 400/422 validation_error) is now permanent:
// dead-lettered, never spilled for retry, never counted toward the breaker.
// Every other 4xx stays retryable (corrected 2026-10-20: a status alone must
// never drop an audit event).

const ORG_A = 'ba20a002-0000-0000-0000-000000000000';
const ORG_B = '47aca786-0000-0000-0000-000000000000';
function jwtFor(org) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub: 'u', org_id: org })}.sig`;
}
const MISMATCH_BODY = {
  error: { code: 'tenant_run_mismatch', message: 'Access denied', details: { errorId: 'e1' } },
  meta: { requestId: 'r1' },
};
function deadLetters(dir) {
  const f = join(dir, 'audit-dead.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test('classifyEmitFailure: 401 auth; permanent ONLY for recognised codes; everything else transient', () => {
  assert.equal(classifyEmitFailure(401), 'auth');
  assert.equal(classifyEmitFailure(401, 'tenant_run_mismatch'), 'auth');
  assert.equal(classifyEmitFailure(403, 'tenant_run_mismatch'), 'permanent');
  assert.equal(classifyEmitFailure(400, 'validation_error'), 'permanent');
  assert.equal(classifyEmitFailure(422, 'validation_error'), 'permanent');
  assert.equal(classifyEmitFailure(413, 'payload_too_large'), 'permanent');
  for (const s of [408, 429, 500, 502, 503, 504]) assert.equal(classifyEmitFailure(s), 'transient', String(s));
  for (const s of [400, 403, 404, 409, 410, 413, 422]) {
    assert.equal(classifyEmitFailure(s), 'transient', `${s} with no code`);
    assert.equal(classifyEmitFailure(s, 'something_else'), 'transient', `${s} with an unrecognised code`);
  }
  // A recognised code on the wrong status is not permanent either.
  assert.equal(classifyEmitFailure(404, 'tenant_run_mismatch'), 'transient');
  assert.equal(classifyEmitFailure(403, 'validation_error'), 'transient');
  assert.equal(classifyEmitFailure(400, 'payload_too_large'), 'transient');
  assert.equal(classifyEmitFailure(409, 'validation_error'), 'transient');
});

test('403 tenant_run_mismatch: EMIT_REJECTED, not spilled, breaker untouched, dead-lettered, run recorded rejected', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 403;
  stub.eventErrorBody = MISMATCH_BODY;
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: jwtFor(ORG_B) });

  const status = await emitAuditEvent({ id: 'toolu_1:pre', subject: 'session-old' }, e);
  assert.equal(status, EMIT_REJECTED);
  assert.deepEqual(readSpillRecords(dir), [], 'a permanent rejection is not spilled for retry');
  assert.equal(readBreakerFile(dir), null, 'no breaker write at all');
  const [dl] = deadLetters(dir);
  assert.equal(dl.status, 403);
  assert.equal(dl.code, 'tenant_run_mismatch');
  assert.equal(dl.envelope.id, 'toolu_1:pre');
  assert.equal(readAuditRuns(e)['session-old'].rejected.orgId, ORG_B);
  assert.equal(readAuditHealth(e).deadLettered.total, 1);
});

test('tenant_run_mismatch: later events for that session make NO network call; one warning per session', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 403;
  stub.eventErrorBody = MISMATCH_BODY;
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: jwtFor(ORG_B) });

  await emitAuditEvent({ id: 'a:pre', subject: 'session-old' }, e);
  for (const id of ['b:pre', 'b:post', 'c:pre']) {
    assert.equal(await emitAuditEvent({ id, subject: 'session-old' }, e), EMIT_REJECTED);
  }
  assert.equal(stub.eventRequests().length, 1, 'only the first event reached COO');
  assert.equal(deadLetters(dir).length, 4);

  // The warning is scoped to the refused session and shown once there.
  assert.deepEqual(takeNotices('session-old', e), [TENANT_RUN_MISMATCH_MESSAGE]);
  assert.deepEqual(takeNotices('session-old', e), []);
  assert.deepEqual(takeNotices('session-new', e), [], 'other sessions are not told about it');
  assert.match(TENANT_RUN_MISMATCH_MESSAGE, /start a new Claude Code session/i);

  // A different session in the same org still posts normally.
  stub.eventStatus = 200;
  assert.equal(await emitAuditEvent({ id: 'd:pre', subject: 'session-new' }, e), EMIT_DELIVERED);
});

test('tenant_run_mismatch: signing back in to the run\'s original org retries, and a delivery clears the rejection', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 403;
  stub.eventErrorBody = MISMATCH_BODY;
  const dir = makeStateDir();
  await emitAuditEvent({ id: 'a:pre', subject: 's' }, env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: jwtFor(ORG_B) }));
  const eA = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: jwtFor(ORG_A) });
  assert.equal(isRunRejected('s', ORG_A, eA), false, 'refused for org B only');
  stub.eventStatus = 200;
  assert.equal(await emitAuditEvent({ id: 'b:pre', subject: 's' }, eA), EMIT_DELIVERED);
  assert.equal(stub.eventRequests().length, 2);
  assert.equal(readAuditRuns(eA).s.rejected, undefined);
  assert.equal(readAuditRuns(eA).s.orgId, ORG_A, 'the run\'s org is now known');
  assert.deepEqual(takeNotices('s', eA), [], 'the mismatch notice was withdrawn');
});

test('tenant_run_mismatch with an UNKNOWN org on either side never suppresses: each event is attempted', async (t) => {
  // Current token's org unknown (dev token with no org_id claim).
  await t.test('current org unknown', async (tt) => {
    const stub = await startStub();
    tt.after(() => stub.close());
    stub.eventStatus = 403;
    stub.eventErrorBody = MISMATCH_BODY;
    const dir = makeStateDir();
    const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'opaque-dev-token' });
    for (const id of ['a:pre', 'b:pre', 'c:pre']) {
      assert.equal(await emitAuditEvent({ id, subject: 's' }, e), EMIT_REJECTED);
    }
    assert.equal(stub.eventRequests().length, 3, 'every event reached COO; COO decides');
    assert.equal(isRunRejected('s', undefined, e), false);
    stub.eventStatus = 200;
    assert.equal(await emitAuditEvent({ id: 'd:pre', subject: 's' }, e), EMIT_DELIVERED, 'recovers when COO accepts');
  });
  // Rejection recorded without an org; the current token's org is known.
  await t.test('rejected org unknown', async (tt) => {
    const stub = await startStub();
    tt.after(() => stub.close());
    const dir = makeStateDir();
    writeFileSync(join(dir, 'audit-runs.json'), JSON.stringify({ s: { rejected: { at: new Date().toISOString(), code: 'tenant_run_mismatch' } } }));
    const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: jwtFor(ORG_A) });
    assert.equal(isRunRejected('s', ORG_A, e), false);
    assert.equal(await emitAuditEvent({ id: 'a:pre', subject: 's' }, e), EMIT_DELIVERED);
    assert.equal(stub.eventRequests().length, 1);
  });
});

test('tenant_run_mismatch: the rejection expires after AUDIT_RUN_REJECTION_TTL_MS and the next event probes COO once', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 403;
  stub.eventErrorBody = MISMATCH_BODY;
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: jwtFor(ORG_B) });
  await emitAuditEvent({ id: 'a:pre', subject: 's' }, e);
  const at = Date.parse(readAuditRuns(e).s.rejected.at);
  assert.equal(isRunRejected('s', ORG_B, e, at + AUDIT_RUN_REJECTION_TTL_MS - 1), true, 'inside the TTL: suppressed');
  assert.equal(isRunRejected('s', ORG_B, e, at + AUDIT_RUN_REJECTION_TTL_MS), false, 'at the TTL: expired');

  // Age the stored rejection past the TTL: the next event goes to the network.
  const runs = readAuditRuns(e);
  runs.s.rejected.at = new Date(Date.now() - AUDIT_RUN_REJECTION_TTL_MS - 1000).toISOString();
  writeFileSync(join(dir, 'audit-runs.json'), JSON.stringify(runs));
  stub.eventStatus = 200; // the mismatch was fixed server-side
  assert.equal(await emitAuditEvent({ id: 'b:pre', subject: 's' }, e), EMIT_DELIVERED);
  assert.equal(stub.eventRequests().length, 2, 'one probe after expiry');
  assert.equal(readAuditRuns(e).s.rejected, undefined, 'the delivery cleared the rejection');

  // An unreadable timestamp never suppresses.
  writeFileSync(join(dir, 'audit-runs.json'), JSON.stringify({ s: { rejected: { at: 'garbage', orgId: ORG_B } } }));
  assert.equal(isRunRejected('s', ORG_B, e), false);
});

test('400/422 validation_error is permanent: dead-lettered, no spill, no breaker, no run rejection', async (t) => {
  for (const status of [400, 422]) {
    await t.test(String(status), async (tt) => {
      const stub = await startStub();
      tt.after(() => stub.close());
      stub.eventStatus = status;
      stub.eventErrorBody = { error: { code: 'validation_error', message: 'bad' }, meta: {} };
      const dir = makeStateDir();
      const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
      for (let i = 0; i < AUDIT_BREAKER_THRESHOLD + 2; i += 1) {
        assert.equal(await emitAuditEvent({ id: `x${i}:pre`, subject: 's' }, e), EMIT_REJECTED);
      }
      assert.equal(readBreaker(e).phase, 'closed', 'K+ permanent rejections never open the breaker');
      assert.deepEqual(readSpillRecords(dir), []);
      assert.equal(deadLetters(dir).length, AUDIT_BREAKER_THRESHOLD + 2);
      assert.equal(isRunRejected('s', undefined, e), false);
      assert.equal(stub.eventRequests().length, AUDIT_BREAKER_THRESHOLD + 2, 'not a known-bad run: each still tries');
    });
  }
});

test('413 payload_too_large is permanent: dead-lettered, no spill, no breaker, no run rejection', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 413;
  stub.eventErrorBody = { error: { code: 'payload_too_large', message: 'too big', details: {} }, meta: {} };
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
  for (let i = 0; i < AUDIT_BREAKER_THRESHOLD + 2; i += 1) {
    assert.equal(await emitAuditEvent({ id: `big${i}:pre`, subject: 's' }, e), EMIT_REJECTED);
  }
  assert.equal(readBreaker(e).phase, 'closed', 'oversize rejections never open the breaker');
  assert.deepEqual(readSpillRecords(dir), []);
  assert.equal(deadLetters(dir).length, AUDIT_BREAKER_THRESHOLD + 2);
  assert.equal(deadLetters(dir)[0].code, 'payload_too_large');
  assert.equal(isRunRejected('s', undefined, e), false);
});

test('a 4xx WITHOUT a recognised code is retryable: spilled, counts toward the breaker, never dead-lettered', async (t) => {
  const cases = [
    { status: 404, body: { error: { code: 'not_found', message: 'x' }, meta: {} } },
    { status: 409, body: { error: { code: 'conflict', message: 'x' }, meta: {} } },
    { status: 413, body: null },
    { status: 413, body: { error: { code: 'something_else', message: 'x' }, meta: {} } }, // a proxy 413, not COO's
    { status: 403, body: null }, // gateway/WAF 403 with no COO envelope
    { status: 403, body: { error: { code: 'forbidden', message: 'x' }, meta: {} } },
    { status: 400, body: { error: { code: 'bad_request', message: 'x' }, meta: {} } },
    { status: 422, body: { error: { code: 'tenant_run_mismatch', message: 'x' }, meta: {} } },
  ];
  for (const { status, body } of cases) {
    await t.test(`${status} ${body?.error?.code ?? '(no code)'}`, async (tt) => {
      const stub = await startStub();
      tt.after(() => stub.close());
      stub.eventStatus = status;
      if (body) stub.eventErrorBody = body;
      const dir = makeStateDir();
      const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: jwtFor(ORG_B) });
      for (let i = 0; i < AUDIT_BREAKER_THRESHOLD; i += 1) {
        assert.equal(await emitAuditEvent({ id: `r${i}:pre`, subject: 's' }, e), EMIT_SPILLED);
      }
      assert.equal(readBreaker(e).phase, 'open', 'counted toward the breaker');
      assert.equal(readSpillRecords(dir).length, AUDIT_BREAKER_THRESHOLD, 'kept for retry');
      assert.deepEqual(deadLetters(dir), [], 'never dead-lettered');
      assert.equal(isRunRejected('s', ORG_B, e), false, 'no run rejection learned');
    });
  }
});

test('no regression: 5xx, 408 and 429 still spill and count toward the breaker', async (t) => {
  for (const code of [503, 408, 429]) {
    await t.test(String(code), async (tt) => {
      const stub = await startStub();
      tt.after(() => stub.close());
      stub.eventStatus = code;
      const dir = makeStateDir();
      const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
      for (let i = 0; i < AUDIT_BREAKER_THRESHOLD; i += 1) {
        assert.equal(await emitAuditEvent({ id: `t${i}:pre`, subject: 's' }, e), EMIT_SPILLED);
      }
      assert.equal(readBreaker(e).phase, 'open');
      assert.equal(readSpillRecords(dir).length, AUDIT_BREAKER_THRESHOLD);
      assert.deepEqual(deadLetters(dir), []);
    });
  }
});

test('no regression: a timeout (hung ingest) spills and counts toward the breaker', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.hangPaths = ['/v1/coo/local/events'];
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
  assert.equal(await emitAuditEvent({ id: 'h:pre', subject: 's' }, e), EMIT_SPILLED);
  assert.equal(readBreakerFile(dir).failures, 1);
  assert.equal(readSpillRecords(dir).length, 1);
});

test('401 on emit: spilled (kept), counts toward the breaker, refresh attempted; a rejected grant signs out', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 401;
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const dir = makeStateDir();
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ issuer: stub.url, accessToken: 'revoked', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_ISSUER: stub.url });
  assert.equal(await emitAuditEvent({ id: 'u:pre', subject: 's' }, e), EMIT_SPILLED);
  assert.equal(readBreakerFile(dir).failures, 1, 'a refused token counts toward the breaker (as before this change)');
  assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/token').length, 1);
  assert.ok(existsSync(join(dir, 'signed-out.json')));
  assert.equal(await emitAuditEvent({ id: 'v:pre', subject: 's' }, e), EMIT_SPILLED);
  assert.equal(stub.eventRequests().length, 1, 'signed out → no further COO call');
});

test('breaker opening queues a once-per-session notice; a delivery closes it and withdraws the notice', () => {
  const dir = makeStateDir();
  const e = env(dir);
  for (let i = 0; i < AUDIT_BREAKER_THRESHOLD - 1; i += 1) recordBreakerFailure(e);
  assert.deepEqual(takeNotices('s1', e), [], 'not open yet → no notice');
  recordBreakerFailure(e);
  assert.deepEqual(takeNotices('s1', e), [BREAKER_OPEN_MESSAGE]);
  recordBreakerFailure(e); // still open — re-arm, no duplicate notice for s1
  assert.deepEqual(takeNotices('s1', e), []);
  assert.deepEqual(takeNotices('s2', e), [BREAKER_OPEN_MESSAGE], 'each session hears it once');
  recordBreakerSuccess(e);
  assert.deepEqual(takeNotices('s3', e), [], 'closed → withdrawn');
});

// ── adv-1: a 401 storm is bounded by the breaker and one refresh per token ──

test('COO keeps refusing fresh tokens (401) while refresh succeeds: POSTs stop at the breaker threshold, one grant', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 401;
  const dir = makeStateDir();
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ issuer: stub.url, accessToken: 'first', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_ISSUER: stub.url });
  for (let i = 0; i < 20; i += 1) assert.equal(await emitAuditEvent({ id: `s${i}:pre`, subject: 's' }, e), EMIT_SPILLED);
  assert.ok(stub.eventRequests().length <= AUDIT_BREAKER_THRESHOLD, `posts=${stub.eventRequests().length}`);
  assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/token').length, 1, 'the refreshed token drew a 401 too → no second refresh');
  assert.equal(readBreaker(e).phase, 'open');
  assert.equal(existsSync(join(dir, 'signed-out.json')), false, 'refresh works; this is not a sign-out');
});

test('a once-revoked token: 401 → refresh → the next emit delivers and the breaker closes', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 401;
  const dir = makeStateDir();
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ issuer: stub.url, accessToken: 'revoked', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_ISSUER: stub.url });
  assert.equal(await emitAuditEvent({ id: 'a:pre', subject: 's' }, e), EMIT_SPILLED);
  stub.eventStatus = 200;
  assert.equal(await emitAuditEvent({ id: 'b:pre', subject: 's' }, e), EMIT_DELIVERED);
  assert.equal(stub.eventRequests().at(-1).headers.authorization, 'Bearer refreshed-token');
  assert.equal(readBreakerFile(dir).failures, 0);
});

test('401 while the refresh fails transiently: the backoff holds the grant count to one', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 401;
  stub.tokenStatus = 503;
  const dir = makeStateDir();
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ issuer: stub.url, accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_ISSUER: stub.url, NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '100' });
  for (let i = 0; i < 10; i += 1) await emitAuditEvent({ id: `t${i}:pre`, subject: 's' }, e);
  assert.equal(stub.requests.filter((r) => r.path === '/auth/oauth/token').length, 1);
});

// ── adv-4: what COO's local-events route sends ──────────────────────────────
// A rejected payload (data_invalid / cloudevents_envelope_invalid /
// unknown_ce_type / unknown_ce_source / non-JSON) is 400 `validation_error`
// (permanent); an oversize body is 413 `payload_too_large` (permanent). A
// server fault stays 400 `bad_request`, which is retried — pinned here so the
// docs cannot drift from it.

test('400 bad_request (COO local-events server fault) is spilled for retry and counts toward the breaker', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 400;
  stub.eventErrorBody = { error: { code: 'bad_request', message: 'data_invalid: tool_name — Required', details: {} }, meta: {} };
  const dir = makeStateDir();
  const e = env(dir, { NOBLECLOAK_COO_URL: stub.url, NOBLECLOAK_DEV_TOKEN: 'tok' });
  assert.equal(await emitAuditEvent({ id: 'bad:pre', subject: 's' }, e), EMIT_SPILLED);
  assert.equal(readSpillRecords(dir).length, 1);
  assert.equal(deadLetters(dir).length, 0);
  assert.equal(readBreakerFile(dir).failures, 1);
  assert.equal(classifyEmitFailure(400, 'bad_request'), 'transient');
});

test('docs list 413 payload_too_large as permanent and 400 bad_request as retried', () => {
  for (const f of ['docs/governance-hook.md', 'commands/noblecloak-status.md']) {
    const src = readFileSync(join(REPO_ROOT, f), 'utf-8');
    assert.match(src, /413[^\n]*`payload_too_large`/, f);
    assert.doesNotMatch(src, /take effect once COO sends/, f);
    if (f.endsWith('governance-hook.md')) assert.match(src, /^\|[^\n]*`tenant_run_mismatch`[^\n]*413 with code `payload_too_large`[^\n]*\*\*permanent\*\*/m, 'permanent table row');
    assert.match(src, /`bad_request`/, f);
    assert.doesNotMatch(src, /does not (?:send|emit) `validation_error`/, f);
  }
  const gov = readFileSync(join(REPO_ROOT, 'scripts/lib/governance.mjs'), 'utf-8');
  assert.doesNotMatch(gov, /does not send today/, 'governance.mjs');
  assert.match(gov, /413\s*\n\s*\* payload_too_large/, 'emit doc comment names 413');
});
