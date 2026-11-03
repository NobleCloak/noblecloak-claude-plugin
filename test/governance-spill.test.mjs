/**
 * Drain-independent spill bounding + degraded marker (brief 2026-06-15 D4).
 *
 * The spill cap already existed (AUDIT_SPILL_RETENTION + boundAuditSpill) but
 * only ran at the tail of compaction, which during the outage ran only AFTER a
 * never-completing drain — so the cap never fired and the spill reached 1.86 GB.
 * Here boundAuditSpill is exercised directly: it trims to the retention tail,
 * surfaces a countable degraded marker when it actually drops lines, and honors
 * an env-tunable retention.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { boundAuditSpill } from '../scripts/lib/governance.mjs';
import { makeStateDir, readSpillRecords } from './helpers.mjs';
import { readFileSync } from 'node:fs';

function seedSpill(dir, n) {
  const file = join(dir, 'audit-spill.jsonl');
  for (let i = 0; i < n; i += 1) appendFileSync(file, `${JSON.stringify({ id: `e${i}:pre`, n: i })}\n`);
  return file;
}

test('boundAuditSpill trims an oversized spill to the retention tail', () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_AUDIT_SPILL_RETENTION: '10' };
  seedSpill(dir, 30);

  const result = boundAuditSpill(env);
  assert.equal(result.trimmed, true);
  assert.equal(result.dropped, 20, 'dropped the 20 oldest');

  const records = readSpillRecords(dir);
  // 10 retained data lines + 1 degraded marker.
  const data = records.filter((r) => !r.bn_degraded);
  assert.equal(data.length, 10, 'retention tail kept');
  assert.equal(data[0].n, 20, 'kept the NEWEST 10 (oldest dropped)');
  assert.equal(data[9].n, 29);
});

test('boundAuditSpill surfaces a countable degraded marker when it trims', () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_AUDIT_SPILL_RETENTION: '5' };
  seedSpill(dir, 12);

  boundAuditSpill(env);
  const markers = readSpillRecords(dir).filter((r) => r.bn_degraded);
  assert.equal(markers.length, 1, 'exactly one trim marker');
  assert.equal(markers[0].degraded_side, 'spill');
  assert.equal(markers[0].degraded_reason, 'spill-cap-trimmed');
  assert.equal(markers[0].dropped, 7);
  assert.ok(typeof markers[0].time === 'string');
});

test('boundAuditSpill is a no-op (no marker) when the spill is under the cap', () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_AUDIT_SPILL_RETENTION: '100' };
  seedSpill(dir, 10);

  const result = boundAuditSpill(env);
  assert.equal(result.trimmed, false);
  assert.equal(result.dropped, 0);
  assert.equal(readSpillRecords(dir).filter((r) => r.bn_degraded).length, 0, 'no spurious marker');
  assert.equal(readSpillRecords(dir).length, 10, 'spill untouched');
});

test('boundAuditSpill on a missing spill file is a safe no-op', () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  const result = boundAuditSpill(env);
  assert.equal(result.trimmed, false);
  assert.equal(existsSync(join(dir, 'audit-spill.jsonl')), false);
});

test('boundAuditSpill aborts (no clobber, no marker) when the spill grows after the snapshot — concurrent-append guard', () => {
  // The function re-stats the spill before the rename and aborts if the size
  // changed since the snapshot read, so a concurrent emitAuditEvent spill append
  // is never clobbered. This is its ONLY concurrency-safety branch — exercise it
  // by appending in the exact window between the read and the re-stat via the
  // test-only _onSnapshot seam.
  const dir = makeStateDir();
  const file = join(dir, 'audit-spill.jsonl');
  const env = { NOBLECLOAK_STATE_DIR: dir, NOBLECLOAK_AUDIT_SPILL_RETENTION: '5' };
  seedSpill(dir, 20); // well over the cap → a trim WOULD happen if not aborted

  const before = readFileSync(file, 'utf-8');
  const result = boundAuditSpill(env, {
    _onSnapshot: () => appendFileSync(file, `${JSON.stringify({ id: 'concurrent:pre', n: 999 })}\n`),
  });

  assert.equal(result.trimmed, false, 'trim aborted — a concurrent append was detected');
  assert.equal(result.dropped, 0);
  const after = readFileSync(file, 'utf-8');
  // All 20 original lines survive plus the concurrent append; nothing clobbered.
  assert.equal(after, `${before}${JSON.stringify({ id: 'concurrent:pre', n: 999 })}\n`);
  assert.equal(readSpillRecords(dir).filter((r) => r.bn_degraded).length, 0, 'no trim marker written on abort');
});
