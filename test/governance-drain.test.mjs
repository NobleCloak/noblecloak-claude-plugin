/**
 * Bounded drain + single-flight lock (brief 2026-06-15 D2) — unit tests.
 *
 * The drain used to re-ship the ENTIRE unshipped backlog on every post-side
 * event, and many workers drained the same backlog at once. Here we assert the
 * two primitives that bound it: a per-drain cap on the OLDEST N envelopes, and a
 * non-blocking single-flight lock (reusing the same tryAcquireLock primitive
 * compaction uses) so a worker that can't take the lock skips the drain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_DRAIN_CAP,
  acquireDrainLock,
  releaseDrainLock,
  drainUnshippedPreEnvelopes,
  compactAuditQueueAndLedger,
  markPreShipped,
  readAuditHealth,
  AUDIT_UNSHIPPED_RETENTION,
  AUDIT_UNSHIPPED_MAX_AGE_MS,
} from '../scripts/lib/governance.mjs';

import { makeStateDir, readQueueRecords, seedAuditRecord } from './helpers.mjs';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function pre(id, i) {
  return {
    ts: new Date(Date.UTC(2026, 5, 15, 0, 0, i)).toISOString(),
    hook_event: 'PreToolUse',
    session_id: SESSION_ID,
    tool_use_id: id,
    tool_name: 'Bash',
    tool_ref: 'tool:claude-code:bash',
    bn_invocation_channel: 'interactive',
    enforce: false,
    resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' },
    would_decision: 'allow',
    degraded: false,
  };
}

test('AUDIT_DRAIN_CAP is a positive integer default', () => {
  assert.ok(Number.isInteger(AUDIT_DRAIN_CAP) && AUDIT_DRAIN_CAP > 0);
});

test('drain caps to the OLDEST N unshipped envelopes', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  for (let i = 0; i < 5; i += 1) await seedAuditRecord(dir, pre(`toolu_${i}`, i));

  const drained = drainUnshippedPreEnvelopes(env, '2026-06-15T00:00:00.000Z', 2);
  assert.equal(drained.length, 2, 'capped to N');
  assert.deepEqual(
    drained.map((d) => d.toolUseId),
    ['toolu_0', 'toolu_1'],
    'the oldest two, not the newest'
  );
});

test('drain cap honors the NOBLECLOAK_AUDIT_DRAIN_CAP env override', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_AUDIT_DRAIN_CAP: '3' };
  for (let i = 0; i < 10; i += 1) await seedAuditRecord(dir, pre(`toolu_${i}`, i));

  const drained = drainUnshippedPreEnvelopes(env);
  assert.equal(drained.length, 3, 'env cap applied when no explicit cap passed');
});

test('a backlog smaller than the cap drains entirely', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  for (let i = 0; i < 2; i += 1) await seedAuditRecord(dir, pre(`toolu_${i}`, i));
  const drained = drainUnshippedPreEnvelopes(env, '2026-06-15T00:00:00.000Z', 50);
  assert.equal(drained.length, 2);
});

test('drain lock is single-flight: a second acquire is refused until release', () => {
  const env = { NOBLECLOAK_STATE_DIR: makeStateDir() };
  const first = acquireDrainLock(env);
  assert.ok(first, 'first acquire succeeds');
  assert.equal(acquireDrainLock(env), null, 'contended acquire refused (worker skips its drain)');
  releaseDrainLock(first);
  const second = acquireDrainLock(env);
  assert.ok(second, 'lock is re-acquirable after release');
  releaseDrainLock(second);
});

// ── Bounded UNSHIPPED queue (ruled 2026-10-20) ─────────────────────────────
//
// Two months signed out grew audit-queue.jsonl to 117 MB: compaction kept every
// unshipped drainable Pre with no cap. Unshipped records are now capped by age
// and count; drops are counted (undelivered) for /noblecloak-status.

function preAt(id, msAgo) {
  return { ...pre(id, 0), ts: new Date(Date.now() - msAgo).toISOString() };
}
const ids = (dir) => readQueueRecords(dir).map((r) => r.tool_use_id);

test('unshipped caps: defaults are 2,000 records / 7 days', () => {
  assert.equal(AUDIT_UNSHIPPED_RETENTION, 2000);
  assert.equal(AUDIT_UNSHIPPED_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
});

test('unshipped COUNT cap drops the oldest first and records how many', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_AUDIT_UNSHIPPED_RETENTION: '3' };
  for (let i = 0; i < 5; i += 1) await seedAuditRecord(dir, preAt(`u${i}`, 60_000 - i));
  const result = compactAuditQueueAndLedger(env);
  assert.equal(result.compacted, true);
  assert.equal(result.droppedUnshipped, 2);
  assert.deepEqual(ids(dir), ['u2', 'u3', 'u4'], 'the newest 3 survive, in order');
  const h = readAuditHealth(env).unshippedDropped;
  assert.deepEqual([h.total, h.byCount, h.byAge, h.last], [2, 2, 0, 2]);
  assert.ok(Date.parse(h.lastAt) > 0);
});

test('unshipped AGE cap drops records older than the max age; younger ones are untouched', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  const day = 24 * 60 * 60 * 1000;
  await seedAuditRecord(dir, preAt('ancient', 60 * day));
  await seedAuditRecord(dir, preAt('old', 8 * day));
  await seedAuditRecord(dir, preAt('recent', 6 * day));
  await seedAuditRecord(dir, preAt('now', 1000));
  await seedAuditRecord(dir, { ...pre('no-ts', 0), ts: 'not-a-date' });
  compactAuditQueueAndLedger(env);
  assert.deepEqual(ids(dir), ['recent', 'now', 'no-ts'], 'an unparseable ts is never dropped by age');
  const h = readAuditHealth(env).unshippedDropped;
  assert.deepEqual([h.total, h.byAge, h.byCount], [2, 2, 0]);
});

test('under both caps: nothing dropped, no counter written, queue untouched', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  for (let i = 0; i < 10; i += 1) await seedAuditRecord(dir, preAt(`k${i}`, 1000));
  const result = compactAuditQueueAndLedger(env);
  assert.equal(result.compacted, false);
  assert.equal(ids(dir).length, 10);
  assert.equal(readAuditHealth(env).unshippedDropped, undefined);
});

test('drop counters accumulate across compactions', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_AUDIT_UNSHIPPED_RETENTION: '1' };
  await seedAuditRecord(dir, preAt('a', 2000));
  await seedAuditRecord(dir, preAt('b', 1000));
  compactAuditQueueAndLedger(env);
  await seedAuditRecord(dir, preAt('c', 500));
  await seedAuditRecord(dir, preAt('d', 100));
  compactAuditQueueAndLedger(env);
  assert.deepEqual(ids(dir), ['d']);
  assert.equal(readAuditHealth(env).unshippedDropped.total, 3);
});

test('the caps never touch the shipped join buffer and never mark a dropped record shipped', async () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_AUDIT_UNSHIPPED_RETENTION: '1' };
  await seedAuditRecord(dir, preAt('shipped-old', 30 * 24 * 60 * 60 * 1000)); // old, but delivered
  markPreShipped('shipped-old', env);
  await seedAuditRecord(dir, preAt('u-old', 2000));
  await seedAuditRecord(dir, preAt('u-new', 1000));
  compactAuditQueueAndLedger(env);
  assert.deepEqual(ids(dir), ['shipped-old', 'u-new'], 'shipped tail kept by its own rule; oldest unshipped dropped');
  const drained = drainUnshippedPreEnvelopes(env).map((d) => d.toolUseId);
  assert.deepEqual(drained, ['u-new'], 'the dropped record is gone, not ledgered as delivered');
});
