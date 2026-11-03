/**
 * Outage-resilience integration tests (brief 2026-06-15: circuit breaker +
 * bounded drain + worker watchdog + drain-independent spill bound).
 *
 * Runs the real dispatcher/worker child processes against the stub ingest
 * server, simulating a down / hanging / recovering COO. Asserts the pipeline
 * stays strictly bounded during a sustained outage and reconciles to 0 orphans
 * once COO recovers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  postToolUseInput,
  readSentIds,
  readSpillRecords,
  runPostEvents,
  runWorker,
  seedAuditRecord,
  startStub,
  stubEnv,
  subagentStartInput,
  subagentStopInput,
  makeStateDir,
  waitForSentIds,
  waitForSpill,
} from './helpers.mjs';

import { breakerStatePath, readBreaker } from '../scripts/lib/governance.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** A denied orphan Pre record — it never produces a Post, so only a drain ships it. */
function orphanPre(id) {
  return {
    ts: new Date().toISOString(),
    hook_event: 'PreToolUse',
    session_id: SESSION_ID,
    tool_use_id: id,
    tool_name: 'Bash',
    tool_ref: 'tool:claude-code:bash',
    bn_invocation_channel: 'interactive',
    enforce: true,
    resolve: { mode: 'enforce_block', source: 'policy', side_effect_level: 'delete' },
    would_decision: 'deny',
    decision: 'deny',
    degraded: false,
  };
}

// ── D2 — SubagentStart no longer drains; SubagentStop still does ────────────

test('D2: SubagentStart does NOT drain the orphan Pre queue', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, orphanPre('toolu_orphan'));

  await runPostEvents(subagentStartInput(), stubEnv(stub, stateDir));
  // The subagent:started event ships, but the orphan :pre must NOT — Start is
  // not a drain boundary anymore (brief root-cause #3).
  const events = await stub.waitForEvents(1);
  await stub.close();

  const ids = events.map((e) => e.body.id);
  assert.ok(
    ids.some((id) => id.endsWith(':started')),
    'the subagent started event still ships'
  );
  assert.ok(!ids.includes('toolu_orphan:pre'), 'SubagentStart did not drain the orphan pre');
  assert.deepEqual(readSentIds(stateDir), [], 'nothing drained/ledgered on Start');
});

test('D2: SubagentStop still drains the orphan Pre queue', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, orphanPre('toolu_orphan'));

  await runPostEvents(subagentStopInput(), stubEnv(stub, stateDir));
  const events = await stub.waitForEvents(2); // subagent:stopped + drained orphan :pre
  await stub.close();

  const ids = events.map((e) => e.body.id);
  assert.ok(ids.includes('toolu_orphan:pre'), 'SubagentStop drained the orphan pre');
  assert.deepEqual(await waitForSentIds(stateDir, 1), ['toolu_orphan'], 'drained pre is ledgered');
});

// ── D2 — an open breaker makes the worker skip the drain entirely ──────────

test('D2/D1: an open breaker skips the drain — the orphan pre is not even enumerated', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, orphanPre('toolu_orphan'));
  // Pre-open the breaker (failures past threshold, opened just now → within the
  // default 30s cooldown for the whole test).
  writeFileSync(breakerStatePath({ NOBLECLOAK_STATE_DIR: stateDir }), JSON.stringify({ failures: 99, openedAt: Date.now() }));

  // A PostToolUse for a DIFFERENT call (its own pre+post spill while open).
  await runPostEvents(postToolUseInput({ tool_use_id: 'toolu_live' }), stubEnv(stub, stateDir));
  await waitForSpill(stateDir, 2);
  await stub.close();

  assert.equal(stub.eventRequests().length, 0, 'breaker open → no network at all');
  const spillIds = readSpillRecords(stateDir).map((s) => s.id);
  assert.ok(!spillIds.includes('toolu_orphan:pre'), 'drain skipped — the orphan pre was never enumerated/spilled');
  assert.deepEqual(readSentIds(stateDir), [], 'nothing shipped while open');
});

// ── D3 — worker watchdog hard-bounds lifetime ──────────────────────────────

test('D3: the worker watchdog exits the worker before a hung endpoint can stall it', async () => {
  const stub = await startStub();
  stub.hang = true; // never responds — the per-request AbortSignal is 2s
  const stateDir = makeStateDir();
  const payloadPath = join(stateDir, 'wd-payload.json');
  // One in-band envelope. Without the watchdog the emit blocks ~2s on the
  // AbortSignal; a 250ms deadline must exit the worker well before that.
  const envelope = { specversion: '1.0', id: 'toolu_wd:post', subject: SESSION_ID, type: 'x', data: {} };
  writeFileSync(payloadPath, JSON.stringify({ envelopes: [envelope], drain: false }));
  const env = { ...stubEnv(stub, stateDir), NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS: '250' };

  const started = Date.now();
  await runWorker([payloadPath], env);
  const elapsed = Date.now() - started;
  await stub.close();

  assert.ok(
    elapsed < 1500,
    `worker exited via the 250ms watchdog, not the 2s request abort (elapsed=${elapsed}ms)`
  );
});

test('D3: a watchdog-killed worker records a countable degraded marker and logs (not a silent success)', async () => {
  const stub = await startStub();
  stub.hang = true; // hang so the worker can only exit via the watchdog mid-work
  const stateDir = makeStateDir();
  const payloadPath = join(stateDir, 'wd-marker-payload.json');
  // A drain payload so the worker is mid-work (in-band emit + drain) when the
  // deadline fires — exit(0) would otherwise look identical to a clean exit.
  await seedAuditRecord(stateDir, orphanPre('toolu_wd_orphan'));
  const envelope = { specversion: '1.0', id: 'toolu_wd2:post', subject: SESSION_ID, type: 'x', data: {} };
  writeFileSync(payloadPath, JSON.stringify({ envelopes: [envelope], drain: true }));
  const env = { ...stubEnv(stub, stateDir), NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS: '150' };

  const result = await runWorker([payloadPath], env);
  await stub.close();

  assert.equal(result.code, 0, 'still exits 0 — the watchdog must not disturb the session');
  assert.match(result.stderr, /worker deadline exceeded/, 'the deadline kill is logged, not silent');
  const marker = readSpillRecords(stateDir).find(
    (r) => r.bn_degraded && r.degraded_side === 'worker' && r.degraded_reason === 'worker-deadline'
  );
  assert.ok(marker, 'a countable worker-deadline degraded marker was recorded');
  assert.ok(typeof marker.time === 'string');
});

test('D3: a watchdog-killed worker does not orphan the drain lock for the full stale window', async () => {
  const stub = await startStub();
  stub.hang = true;
  const stateDir = makeStateDir();
  // Two orphan pres so the drain is actively shipping (holding the drain lock)
  // when the deadline fires.
  await seedAuditRecord(stateDir, orphanPre('toolu_wd_a'));
  await seedAuditRecord(stateDir, orphanPre('toolu_wd_b'));
  const payloadPath = join(stateDir, 'wd-lock-payload.json');
  writeFileSync(payloadPath, JSON.stringify({ envelopes: [], drain: true }));
  const env = { ...stubEnv(stub, stateDir), NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS: '150' };

  await runWorker([payloadPath], env);
  await stub.close();

  // The watchdog best-effort releases the drain lock on the way out, so a
  // subsequent worker can immediately take it — not blocked for the stale window.
  const { acquireDrainLock, releaseDrainLock } = await import('../scripts/lib/governance.mjs');
  const lock = acquireDrainLock(env);
  assert.ok(lock, 'the drain lock was released by the watchdog — next worker can take it immediately');
  releaseDrainLock(lock);
});

// ── D4 — spill bounding runs independently of the drain/compaction path ─────

test('D4: a non-draining event (SubagentStart) still bounds an oversized spill', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  // Pre-existing oversized spill. SubagentStart neither drains nor compacts, so
  // only the worker's early boundAuditSpill call can cap it (brief D4).
  const spillFile = join(stateDir, 'audit-spill.jsonl');
  for (let i = 0; i < 40; i += 1) appendFileSync(spillFile, `${JSON.stringify({ id: `old${i}:pre` })}\n`);
  const env = { ...stubEnv(stub, stateDir), NOBLECLOAK_AUDIT_SPILL_RETENTION: '10' };

  await runPostEvents(subagentStartInput(), env);
  await stub.waitForEvents(1); // the subagent:started event ships → the worker ran

  // Poll until the detached worker has bounded the spill.
  const deadline = Date.now() + 3000;
  let data = readSpillRecords(stateDir).filter((r) => !r.bn_degraded);
  while (data.length > 10 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    data = readSpillRecords(stateDir).filter((r) => !r.bn_degraded);
  }
  await stub.close();

  assert.ok(data.length <= 10, `spill bounded to retention by the early call (got ${data.length})`);
  assert.ok(
    readSpillRecords(stateDir).some((r) => r.bn_degraded && r.degraded_reason === 'spill-cap-trimmed'),
    'trim marker surfaced'
  );
});

// ── D5 — sustained outage stays bounded, then reconciles to 0 orphans ───────

test('D5: a sustained COO outage stays bounded, then reconciles to 0 orphans on recovery', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const env = {
    ...stubEnv(stub, stateDir),
    // Small breaker so the outage trips it fast; short cooldown so recovery can
    // half-open within the test; small spill retention to prove bounding.
    NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '2',
    NOBLECLOAK_AUDIT_BREAKER_COOLDOWN_MS: '300',
    NOBLECLOAK_AUDIT_SPILL_RETENTION: '50',
  };

  // Five denied orphan Pre records — they never produce a Post, so the ONLY way
  // they ever reach ingest is the post-recovery drain (the fabricated-success
  // defense the outage must not break).
  const orphanIds = ['toolu_o0', 'toolu_o1', 'toolu_o2', 'toolu_o3', 'toolu_o4'];
  for (const id of orphanIds) await seedAuditRecord(stateDir, orphanPre(id));

  // ── Sustained outage ──
  stub.eventStatus = 503;
  for (let i = 0; i < 4; i += 1) {
    await runPostEvents(postToolUseInput({ tool_use_id: `toolu_out${i}` }), env);
  }
  await waitForSpill(stateDir, 2); // workers have run and spilled
  await sleep(150);

  // Bounded + self-limiting: the breaker tripped, nothing reconciled, the spill
  // never ran away, and the orphans were never enumerated/shipped during the outage.
  assert.notEqual(readBreaker(env).phase, 'closed', 'breaker tripped during the sustained outage');
  assert.deepEqual(readSentIds(stateDir), [], 'nothing reconciled while COO is down');
  const outageData = readSpillRecords(stateDir).filter((r) => !r.bn_degraded);
  assert.ok(outageData.length <= 50, `spill stayed under cap during the outage (got ${outageData.length})`);

  // ── Recovery ──
  stub.eventStatus = 200;
  await sleep(350); // exceed the 300ms cooldown → breaker half-opens to probe
  // A drain event after recovery: the in-band probe succeeds → breaker closes →
  // the drain re-ships the still-unshipped orphans.
  await runPostEvents(postToolUseInput({ tool_use_id: 'toolu_recovery' }), env);

  const deadline = Date.now() + 3000;
  let sent = new Set(readSentIds(stateDir));
  while (!orphanIds.every((id) => sent.has(id)) && Date.now() < deadline) {
    await sleep(25);
    sent = new Set(readSentIds(stateDir));
  }
  await stub.close();

  for (const id of orphanIds) {
    assert.ok(sent.has(id), `orphan ${id} reconciled after recovery — the outage deferred, never dropped, the obligation`);
  }
  assert.equal(readBreaker(env).phase, 'closed', 'breaker closed again after a successful probe');
});
