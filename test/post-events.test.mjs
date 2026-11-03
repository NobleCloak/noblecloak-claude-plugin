/**
 * Integration tests for scripts/hooks/post-events.mjs — the async whole-tree
 * audit emitter (epic build item #5, brief 2026-06-09-plugin-posttooluse-adapter).
 *
 * Runs the dispatcher as a child process against a local stub ingest server
 * (the spike pattern), covering the brief's D4 matrix. The POST to
 * /v1/coo/local/events is fire-and-forget, so event assertions poll the stub
 * via stub.waitForEvents AFTER the child exits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  postToolUseInput,
  postToolUseFailureInput,
  readQueueRecords,
  readSentIds,
  readSpillRecords,
  runPostEvents,
  seedAuditRecord,
  startStub,
  stubEnv,
  subagentStartInput,
  subagentStopInput,
  makeStateDir,
  waitForSentIds,
  waitForSpill,
} from './helpers.mjs';

import {
  deriveCeId,
  markPreShipped,
  AUDIT_SHIPPED_RETENTION,
  CE_TYPE_TOOL_CALL_AUTHORIZED,
  CE_TYPE_TOOL_CALL_DENIED,
} from '../scripts/lib/governance.mjs';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// The deployment's wire values, pinned literally (see the CE_* constants in governance.mjs).
const CE_SOURCE = 'bianoble/local-execution/claude-code';
const TOOL_CALL_TYPES = [CE_TYPE_TOOL_CALL_AUTHORIZED, CE_TYPE_TOOL_CALL_DENIED];

/** A Pre-side audit record (brief #4 shape) for a Bash call that resolved allow. */
function preRecord(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    hook_event: 'PreToolUse',
    session_id: SESSION_ID,
    tool_use_id: 'toolu_0123456789',
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

function eventsByType(events) {
  const out = {};
  for (const e of events) {
    out[e.body.type] = out[e.body.type] || [];
    out[e.body.type].push(e.body);
  }
  return out;
}

// ── PostToolUse success ─────────────────────────────────────────────────────

test('PostToolUse success: authorized post event emitted with outcome.ok=true', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord());
  const result = await runPostEvents(postToolUseInput(), stubEnv(stub, stateDir));
  assert.equal(result.code, 0);
  const events = await stub.waitForEvents(2);
  await stub.close();

  const post = events.find((e) => e.body.id === 'toolu_0123456789:post');
  assert.ok(post, 'a :post event is emitted');
  assert.equal(post.body.specversion, '1.0');
  assert.equal(post.body.type, 'com.bianoble.tool.call.authorized.v1');
  assert.equal(post.body.source, CE_SOURCE);
  assert.equal(post.body.subject, SESSION_ID); // run_id = session_id
  assert.equal(post.body.data.outcome.ok, true);
  assert.equal(post.body.data.tool_ref, 'tool:claude-code:bash');
});

test('PostToolUse success: tool_response content never appears in any request body', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord());
  const secret = 'TOP-SECRET-STDOUT-PAYLOAD';
  await runPostEvents(
    postToolUseInput({ tool_response: { stdout: secret, stderr: '', exitCode: 0 } }),
    stubEnv(stub, stateDir)
  );
  const events = await stub.waitForEvents(2);
  await stub.close();
  for (const e of events) {
    assert.ok(!e.rawBody.includes(secret), 'raw tool_response must never be shipped');
  }
});

test('PostToolUse success: pre-phase event also emitted with decision from the audit record', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord());
  await runPostEvents(postToolUseInput(), stubEnv(stub, stateDir));
  const events = await stub.waitForEvents(2);
  await stub.close();

  const pre = events.find((e) => e.body.id === 'toolu_0123456789:pre');
  assert.ok(pre, 'a :pre event is emitted alongside the :post event');
  assert.equal(pre.body.type, 'com.bianoble.tool.call.authorized.v1');
  assert.equal(pre.body.data.decision.mode, 'always_allow');
  // Policy-mode vocab on the wire: the permissionDecision 'allow' normalizes to
  // 'always_allow' so COO's ingest enum accepts it.
  assert.equal(pre.body.data.decision.would_have_been, 'always_allow');
  assert.equal(pre.body.data.decision.enforce_active, false);
  assert.equal(pre.body.data.outcome, undefined); // pre carries no outcome
});

// ── PostToolUseFailure ──────────────────────────────────────────────────────

test('PostToolUseFailure: denied-or-authorized post event carries failure outcome', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord());
  await runPostEvents(
    postToolUseFailureInput({ error: 'command exited with code 1', is_interrupt: false, duration_ms: 33 }),
    stubEnv(stub, stateDir)
  );
  const events = await stub.waitForEvents(2);
  await stub.close();

  const post = events.find((e) => e.body.id === 'toolu_0123456789:post');
  assert.ok(post);
  assert.equal(post.body.data.outcome.ok, false);
  assert.equal(post.body.data.outcome.error, 'command exited with code 1');
  assert.equal(post.body.data.outcome.is_interrupt, false);
  assert.equal(post.body.data.outcome.duration_ms, 33);
});

test('PostToolUseFailure: pre-phase event emitted independently (fabricated-success defense)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord({ decision: 'deny', would_decision: 'deny', enforce: true, resolve: { mode: 'deny', source: 'policy', side_effect_level: 'delete' } }));
  await runPostEvents(postToolUseFailureInput(), stubEnv(stub, stateDir));
  const events = await stub.waitForEvents(2);
  await stub.close();

  const pre = events.find((e) => e.body.id === 'toolu_0123456789:pre');
  assert.ok(pre, 'pre event fires even on the failure path');
  assert.equal(pre.body.type, 'com.bianoble.tool.call.denied.v1');
  assert.equal(pre.body.data.outcome, undefined);
});

// ── Subagent lifecycle ──────────────────────────────────────────────────────

test('SubagentStart: subagent.started event with agent_id, agent_type, cwd', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await runPostEvents(subagentStartInput(), stubEnv(stub, stateDir));
  const events = await stub.waitForEvents(1);
  await stub.close();

  const [evt] = events;
  assert.equal(evt.body.type, 'com.bianoble.local.subagent.started.v1');
  assert.equal(evt.body.id, 'agent_abc123:started');
  assert.equal(evt.body.subject, SESSION_ID);
  assert.equal(evt.body.data.agent_id, 'agent_abc123');
  assert.equal(evt.body.data.agent_type, 'general-purpose');
  assert.equal(evt.body.data.cwd, '/tmp/project');
});

test('SubagentStop: subagent.stopped event with agent_transcript_path', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await runPostEvents(subagentStopInput(), stubEnv(stub, stateDir));
  const events = await stub.waitForEvents(1);
  await stub.close();

  const [evt] = events;
  assert.equal(evt.body.type, 'com.bianoble.local.subagent.stopped.v1');
  assert.equal(evt.body.id, 'agent_abc123:stopped');
  assert.equal(evt.body.data.agent_id, 'agent_abc123');
  assert.equal(evt.body.data.agent_transcript_path, '/tmp/agent-transcript.jsonl');
});

// ── Non-blocking guarantee ──────────────────────────────────────────────────

test('non-blocking: ingest hangs, dispatcher still exits 0 fast (< 500ms wall-clock)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.hangPaths = ['/v1/coo/local/events'];
  await seedAuditRecord(stateDir, preRecord());
  const result = await runPostEvents(postToolUseInput(), stubEnv(stub, stateDir));
  assert.equal(result.code, 0);
  // The dispatcher hands the POSTs to a DETACHED worker and exits immediately —
  // it never awaits the network at all, so wall-clock is single/double-digit
  // ms regardless of how long ingest hangs. (Old in-process race blocked up to
  // EMIT_GRACE_MS=1000ms; finding #3.) Allow generous headroom for child spawn.
  assert.ok(result.elapsedMs < 500, `expected fast exit, got ${result.elapsedMs}ms`);
  // Let the detached worker reach its AbortSignal.timeout + spill before close.
  await waitForSpill(stateDir, 2);
  await stub.close();
});

test('hung ingest still spills (finding #2): a HANGING endpoint produces a spill record', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  // The stub accepts the connection but never responds — the exact "ingest
  // hangs" degraded case the spill exists for. The detached worker's
  // AbortSignal.timeout(2000) fires and its catch→spill runs; nothing kills the
  // worker at a grace window, so the envelope is NEVER silently dropped.
  stub.hangPaths = ['/v1/coo/local/events'];
  await seedAuditRecord(stateDir, preRecord());
  await runPostEvents(postToolUseInput(), stubEnv(stub, stateDir));
  const spill = await waitForSpill(stateDir, 2);
  await stub.close();
  // Both the in-band :pre and :post spill on the hung endpoint (never silently
  // dropped). The same-process drain skips the pre it just attempted, so exactly
  // these two land.
  const ids = spill.map((s) => s.id).sort();
  assert.deepEqual(ids, ['toolu_0123456789:post', 'toolu_0123456789:pre']);
});

// ── Spill on ingest down ────────────────────────────────────────────────────

test('spill: ingest returns 503, envelopes land in audit-spill.jsonl', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.eventStatus = 503;
  await seedAuditRecord(stateDir, preRecord());
  await runPostEvents(postToolUseInput(), stubEnv(stub, stateDir));
  // The POSTs (and their failure → spill) settle in the detached worker after
  // the dispatcher exits; poll the spill file until both land.
  const spill = await waitForSpill(stateDir, 2);
  // Give the same-process drain a chance to (incorrectly) re-spill before
  // asserting exactness — it must NOT, because the in-band attempt is tracked.
  await new Promise((r) => setTimeout(r, 150));
  await stub.close();
  // Exactly the in-band :pre and :post spill (503). The same-process drain does
  // NOT re-spill the pre it just attempted; the still-unshipped pre stays
  // eligible for a LATER event's drain (finding #3 — not marked shipped).
  const ids = spill.map((s) => s.id).sort();
  assert.deepEqual(ids, ['toolu_0123456789:post', 'toolu_0123456789:pre']);
});

test('spill (finding #3): a spilled :pre during a COO outage is NOT marked shipped', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.eventStatus = 503; // COO down for the whole window
  await seedAuditRecord(stateDir, preRecord());
  await runPostEvents(postToolUseInput(), stubEnv(stub, stateDir));
  await waitForSpill(stateDir, 2);
  await stub.close();
  // The fabricated-success defense must not silently degrade to a local-only
  // file: because the :pre only spilled (never reached ingest), the ledger
  // stays empty, so the next drain after COO recovers can re-ship it.
  assert.deepEqual(readSentIds(stateDir), [], 'spilled :pre stays out of the shipped ledger');
});

test('recovery (finding #3): a :pre spilled during an outage re-ships once COO recovers', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_outage' }));

  // Outage: 503 for both this call's pre+post and the drain's re-attempt.
  stub.eventStatus = 503;
  await runPostEvents(postToolUseInput({ tool_use_id: 'toolu_outage' }), stubEnv(stub, stateDir));
  await waitForSpill(stateDir, 2);
  assert.deepEqual(readSentIds(stateDir), [], 'nothing shipped during the outage');

  // COO recovers. A later audited event drains the still-unshipped :pre and it
  // now reaches ingest — the outage-window audit is reconstructed, not lost.
  stub.eventStatus = 200;
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_after' }));
  await runPostEvents(postToolUseInput({ tool_use_id: 'toolu_after' }), stubEnv(stub, stateDir));
  const events = await stub.waitForEvents(1);
  await stub.close();

  const ids = events.map((e) => e.body.id);
  assert.ok(
    ids.includes('toolu_outage:pre'),
    "the outage-window :pre is re-shipped after recovery (it was not sealed as 'shipped')"
  );
});

// ── ce_id idempotency ───────────────────────────────────────────────────────

test('ce_id idempotency: deriveCeId is deterministic per (tool_use_id, phase)', () => {
  assert.equal(deriveCeId('toolu_X', 'pre'), 'toolu_X:pre');
  assert.equal(deriveCeId('toolu_X', 'pre'), deriveCeId('toolu_X', 'pre'));
  assert.equal(deriveCeId('toolu_X', 'post'), 'toolu_X:post');
  assert.notEqual(deriveCeId('toolu_X', 'pre'), deriveCeId('toolu_X', 'post'));
});

// ── mcp__noblecloak gateway-governed corroboration (D1/D3/D4) ─────────────────

test('mcp__noblecloak* tool: exactly ONE :post event is emitted (gateway-governed, corroboration-marked)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const result = await runPostEvents(
    postToolUseInput({ tool_name: 'mcp__noblecloak__coo_list_agents', tool_input: { q: 1 }, tool_response: { ok: true } }),
    stubEnv(stub, stateDir)
  );
  assert.equal(result.code, 0);
  const events = await stub.waitForEvents(1);
  // Settle: a :pre companion must NEVER arrive for a gateway-governed tool.
  await new Promise((r) => setTimeout(r, 200));
  await stub.close();
  assert.equal(stub.eventRequests().length, 1);
  const [only] = events;
  assert.ok(only.body.id.endsWith(':post'), 'the single event is the :post');
});

test('mcp__noblecloak* :post: bn_corroborated_by=action_ledger, enforce_active:false, surface attributed', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await runPostEvents(
    postToolUseInput({ tool_name: 'mcp__noblecloak__coo_list_agents', tool_input: { q: 1 }, tool_response: { ok: true } }),
    stubEnv(stub, stateDir)
  );
  const [event] = await stub.waitForEvents(1);
  await new Promise((r) => setTimeout(r, 200));
  await stub.close();
  assert.equal(stub.eventRequests().length, 1);
  assert.equal(event.body.data.bn_corroborated_by, 'action_ledger');
  assert.equal(event.body.data.decision.enforce_active, false);
  assert.equal(typeof event.body.data.surface.reported, 'string');
  assert.equal('client_id' in event.body.data.surface, false);
});

test('mcp__noblecloak* PostToolUseFailure: still exactly one :post, enforce_active:false', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await runPostEvents(
    postToolUseFailureInput({ tool_name: 'mcp__noblecloak__coo_list_agents', error: 'boom', is_interrupt: false }),
    stubEnv(stub, stateDir)
  );
  const events = await stub.waitForEvents(1);
  await new Promise((r) => setTimeout(r, 200));
  await stub.close();
  assert.equal(stub.eventRequests().length, 1);
  const [only] = events;
  assert.ok(only.body.id.endsWith(':post'));
  assert.equal(only.body.data.decision.enforce_active, false);
  assert.equal(only.body.data.bn_corroborated_by, 'action_ledger');
  assert.equal(only.body.data.outcome.ok, false);
});

test('local Bash still emits the [:pre, :post] PAIR with no bn_corroborated_by', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord());
  await runPostEvents(postToolUseInput(), stubEnv(stub, stateDir)); // Bash
  const events = await stub.waitForEvents(2);
  await stub.close();
  const pre = events.find((e) => e.body.id === 'toolu_0123456789:pre');
  const post = events.find((e) => e.body.id === 'toolu_0123456789:post');
  assert.ok(pre && post, 'a governed local tool still ships the pair');
  assert.equal('bn_corroborated_by' in pre.body.data, false);
  assert.equal('bn_corroborated_by' in post.body.data, false);
});

test('non-NobleCloak mcp__ tool emits the [:pre, :post] PAIR with no bn_corroborated_by (gatewayGoverned:false)', async () => {
  // A non-NobleCloak MCP tool (e.g. mcp__github__*) is NOT gateway-governed — the
  // dispatcher must select gatewayGoverned:false, so it ships the pre+post PAIR
  // (an independently-governed local tool) and never stamps bn_corroborated_by
  // (that marker is reserved for NobleCloak gateway-governed calls only).
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(
    stateDir,
    preRecord({
      tool_use_id: 'toolu_gh',
      tool_name: 'mcp__github__create_issue',
      tool_ref: 'mcp__github__create_issue',
      resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'write' },
    })
  );
  await runPostEvents(
    postToolUseInput({
      tool_use_id: 'toolu_gh',
      tool_name: 'mcp__github__create_issue',
      tool_input: { title: 'x' },
      tool_response: { ok: true },
    }),
    stubEnv(stub, stateDir)
  );
  const events = await stub.waitForEvents(2);
  await new Promise((r) => setTimeout(r, 150));
  await stub.close();
  const pre = events.find((e) => e.body.id === 'toolu_gh:pre');
  const post = events.find((e) => e.body.id === 'toolu_gh:post');
  assert.ok(pre && post, 'a non-NobleCloak MCP tool still ships the pre+post pair');
  assert.equal('bn_corroborated_by' in pre.body.data, false);
  assert.equal('bn_corroborated_by' in post.body.data, false);
});

// ── SDK dedup marker ────────────────────────────────────────────────────────

test('NOBLECLOAK_SDK_HOOK_ACTIVE: dispatcher exits 0 immediately, no event, no spill', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord());
  const result = await runPostEvents(
    postToolUseInput(),
    stubEnv(stub, stateDir, { NOBLECLOAK_SDK_HOOK_ACTIVE: '1' })
  );
  assert.equal(result.code, 0);
  await new Promise((r) => setTimeout(r, 200));
  await stub.close();
  assert.equal(stub.eventRequests().length, 0);
  assert.equal(readSpillRecords(stateDir).length, 0);
});

// ── pre-without-post: the pre-for-B is not held back by a missing post-for-A ─

test('pre-without-post (fabricated-success defense): A blocked call with NO Post still ships its :pre', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  // A got a Pre record but never a PostToolUse (blocked subagent — fabricated
  // success). B is the tool we are now firing PostToolUse for. A's :pre is the
  // ONLY truthful record of A, so the drain must ship it independently — it is
  // NOT held back waiting for a Post that will never come (brief Goal).
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_A' }));
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_B' }));
  await runPostEvents(
    postToolUseInput({ tool_use_id: 'toolu_B' }),
    stubEnv(stub, stateDir)
  );
  // B's pre + B's post + A's drained pre = 3 events.
  const events = await stub.waitForEvents(3);
  await stub.close();
  const ids = events.map((e) => e.body.id).sort();
  assert.deepEqual(
    ids,
    ['toolu_A:pre', 'toolu_B:post', 'toolu_B:pre'],
    "A's :pre is shipped by the drain even though A never produced a Post"
  );
});

test('drained :pre is not re-shipped on the next event (shipped-ledger idempotency)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_A' }));
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_B' }));
  // First Post for B drains A's :pre (3 events).
  await runPostEvents(postToolUseInput({ tool_use_id: 'toolu_B' }), stubEnv(stub, stateDir));
  await stub.waitForEvents(3);
  // The ledger lands after the responses; the second event must start after it.
  await waitForSentIds(stateDir, 2);
  // A second, unrelated Post (C) must NOT re-ship A's or B's already-shipped
  // pre — only C's own pre+post. Total = 3 (first) + 2 (second) = 5.
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_C' }));
  await runPostEvents(postToolUseInput({ tool_use_id: 'toolu_C' }), stubEnv(stub, stateDir));
  const events = await stub.waitForEvents(5);
  // Give any erroneous duplicate a chance to land before asserting exactness.
  await new Promise((r) => setTimeout(r, 150));
  await stub.close();
  const ids = events.map((e) => e.body.id).sort();
  assert.deepEqual(ids, [
    'toolu_A:pre',
    'toolu_B:post',
    'toolu_B:pre',
    'toolu_C:post',
    'toolu_C:pre',
  ]);
});

test('enforce-mode denied call with NO Post ships its :pre via SubagentStop drain', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  // A call that resolved DENY in enforce mode — Claude Code never executes it,
  // so no Post ever fires. Its denied :pre is the only record; the drain on the
  // SubagentStop boundary must ship it.
  await seedAuditRecord(
    stateDir,
    preRecord({
      tool_use_id: 'toolu_denied',
      enforce: true,
      decision: 'deny',
      would_decision: 'deny',
      resolve: { mode: 'deny', source: 'policy', side_effect_level: 'delete' },
    })
  );
  await runPostEvents(subagentStopInput(), stubEnv(stub, stateDir));
  // SubagentStop's own stopped event + the drained denied :pre = 2 events.
  const events = await stub.waitForEvents(2);
  await stub.close();
  const pre = events.find((e) => e.body.id === 'toolu_denied:pre');
  assert.ok(pre, 'the denied call\'s :pre reaches the stub even with no Post');
  assert.equal(pre.body.type, 'com.bianoble.tool.call.denied.v1');
  assert.equal(pre.body.subject, SESSION_ID);
  assert.equal(pre.body.data.outcome, undefined);
});

// ── degraded path: no matching audit record ─────────────────────────────────

test('degraded: no matching audit record still emits post event with degraded decision metadata', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  // No seedAuditRecord — the queue has no record for this tool_use_id. The
  // post still ships (the tree needs the outcome) and a degraded :pre too;
  // the drain finds no queued Pre records, so exactly these 2 events.
  const result = await runPostEvents(postToolUseInput(), stubEnv(stub, stateDir));
  assert.equal(result.code, 0);
  const events = await stub.waitForEvents(2);
  await stub.close();

  const post = events.find((e) => e.body.id === 'toolu_0123456789:post');
  assert.ok(post, 'post event still emitted without a pre record');
  assert.equal(post.body.data.outcome.ok, true);
  assert.equal(post.body.data.decision.source, 'unknown-no-pre-record');
});

// ── no bearer token (logged-out audit path, finding #5) ─────────────────────

test('no bearer token: nothing is POSTed and both envelopes spill (logged-out path)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord());
  // stubEnv WITHOUT the dev-token override and with no auth.json on disk — the
  // steady state for a user who never ran /noblecloak-login. getBearerToken
  // returns null, so emitAuditEvent spills WITHOUT attempting any POST.
  const env = stubEnv(stub, stateDir);
  delete env.NOBLECLOAK_DEV_TOKEN;
  const result = await runPostEvents(postToolUseInput(), env);
  assert.equal(result.code, 0);
  const spill = await waitForSpill(stateDir, 2);
  // Give any (erroneous) POST a chance to land before asserting zero.
  await new Promise((r) => setTimeout(r, 150));
  await stub.close();
  assert.equal(stub.eventRequests().length, 0, 'no POST is attempted without a bearer token');
  // Exactly the in-band :pre and :post spill; the same-process drain does not
  // re-spill the pre it just attempted.
  const ids = spill.map((s) => s.id).sort();
  assert.deepEqual(ids, ['toolu_0123456789:post', 'toolu_0123456789:pre']);
  // And nothing is marked shipped — the logged-out window stays reconstructable.
  assert.deepEqual(readSentIds(stateDir), []);
});

// ── degraded-Post guard: missing tool_use_id / session_id (finding #6) ──────

test('degraded Post (no session_id): no tool-call event for it, but the drain still runs', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  // A previously-queued, unshipped Pre for a DIFFERENT call — it must still be
  // drained even though the triggering Post yields no envelopes of its own.
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_queued' }));
  const result = await runPostEvents(postToolUseInput({ session_id: undefined }), stubEnv(stub, stateDir));
  assert.equal(result.code, 0);
  // Only the drained :pre for the queued call ships — no pre/post for the
  // degraded triggering Post (it has no session_id to attach a run_id).
  const events = await stub.waitForEvents(1);
  await new Promise((r) => setTimeout(r, 150));
  await stub.close();
  const ids = events.map((e) => e.body.id);
  assert.deepEqual(ids, ['toolu_queued:pre'], 'drain runs even when the triggering Post yields no envelopes');
});

test('degraded Post (no tool_use_id): emits no malformed envelope, drain still runs', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_queued' }));
  const result = await runPostEvents(postToolUseInput({ tool_use_id: undefined }), stubEnv(stub, stateDir));
  assert.equal(result.code, 0);
  const events = await stub.waitForEvents(1);
  await new Promise((r) => setTimeout(r, 150));
  await stub.close();
  // No envelope with a malformed (undefined-keyed) id — only the drained :pre.
  const ids = events.map((e) => e.body.id);
  assert.deepEqual(ids, ['toolu_queued:pre']);
  for (const id of ids) assert.ok(!id.startsWith('undefined'), 'no malformed undefined-keyed envelope');
});

// ── malformed / non-object stdin (finding #7 + #4) ──────────────────────────

test('malformed stdin: exit 0, zero POSTs, and a countable degraded marker spills', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const result = await runPostEvents('not json at all', stubEnv(stub, stateDir));
  assert.equal(result.code, 0, 'a parse error never escapes to a non-zero exit');
  // Let any erroneous POST land; the degraded marker spill is synchronous.
  await new Promise((r) => setTimeout(r, 150));
  await stub.close();
  assert.equal(stub.eventRequests().length, 0, 'no event POSTed on malformed input');
  // finding #4 — degradation is countable from the audit data, not stderr-only.
  const markers = readSpillRecords(stateDir).filter((r) => r.bn_degraded);
  assert.equal(markers.length, 1, 'one degraded marker spilled');
  assert.equal(markers[0].degraded_reason, 'malformed-input');
  assert.equal(markers[0].degraded_side, 'post');
});

test('non-object stdin (JSON null): exit 0, zero POSTs, degraded marker spills', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const result = await runPostEvents('null', stubEnv(stub, stateDir));
  assert.equal(result.code, 0);
  await new Promise((r) => setTimeout(r, 150));
  await stub.close();
  assert.equal(stub.eventRequests().length, 0);
  const markers = readSpillRecords(stateDir).filter((r) => r.bn_degraded);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].degraded_reason, 'malformed-input');
});

// ── bounded retention: queue + ledger compaction (finding #1) ───────────────

test('compaction: a fully-shipped call is pruned from the queue and ledger after a drain', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  // Seed a long run of already-shipped Pre records (queued + ledgered) so they
  // sit beyond the shipped-retention tail, then let one real Post's drain
  // trigger compaction and collapse them down to the bounded tail.
  const N = AUDIT_SHIPPED_RETENTION + 50;
  for (let i = 0; i < N; i += 1) {
    await seedAuditRecord(stateDir, preRecord({ tool_use_id: `toolu_old_${i}` }));
    markPreShipped(`toolu_old_${i}`, { NOBLECLOAK_STATE_DIR: stateDir });
  }

  // Now fire a real Post (with its own Pre) — its drain triggers compaction.
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_live' }));
  await runPostEvents(postToolUseInput({ tool_use_id: 'toolu_live' }), stubEnv(stub, stateDir));
  await stub.waitForEvents(2);
  // Let the worker's post-drain compaction complete.
  await new Promise((r) => setTimeout(r, 200));
  await stub.close();

  const queue = readQueueRecords(stateDir);
  // The shipped tail is bounded: far fewer than N old records survive.
  assert.ok(queue.length <= AUDIT_SHIPPED_RETENTION + 5, `queue compacted to a bounded tail (was ${N + 1}, now ${queue.length})`);
  // The ledger never outgrows the compacted queue.
  assert.ok(readSentIds(stateDir).length <= queue.length, 'ledger does not outgrow the compacted queue');
});

// ── D5 — end-to-end tree reconstruction (0 orphans) ─────────────────────────

test('e2e: a session with one subagent fan-out reconstructs to 0 orphans offline', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const env = stubEnv(stub, stateDir);

  // Root session: one tool call. Subagent: started → one tool call → stopped.
  // Seed each Pre record immediately before its Post fires (the real ordering)
  // so the root Post's drain never sees the subagent call's pre prematurely.
  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_root' }));
  await runPostEvents(postToolUseInput({ tool_use_id: 'toolu_root' }), env);

  await runPostEvents(subagentStartInput({ agent_id: 'agent_A' }), env);

  await seedAuditRecord(stateDir, preRecord({ tool_use_id: 'toolu_sub', agent_id: 'agent_A', agent_type: 'general-purpose' }));
  await runPostEvents(
    postToolUseInput({ tool_use_id: 'toolu_sub', agent_id: 'agent_A', agent_type: 'general-purpose' }),
    env
  );
  await runPostEvents(subagentStopInput({ agent_id: 'agent_A' }), env);

  // 2 tool calls × (pre+post) + 2 subagent lifecycle = 6 events.
  const events = await stub.waitForEvents(6);
  await stub.close();
  assert.equal(events.length, 6);

  // Reconstruct the tree by (subject=run_id, data.agent_id, tool_use_id),
  // mirroring the spike's reconstruction standard.
  const bodies = events.map((e) => e.body);
  const subagentIds = new Set(
    bodies
      .filter((b) => b.type.includes('subagent.started'))
      .map((b) => b.data.agent_id)
  );

  let orphans = 0;
  for (const b of bodies) {
    // Every event hangs off the session root (subject).
    if (b.subject !== SESSION_ID) orphans += 1;
    // A subagent tool call must reference a subagent that started.
    if (TOOL_CALL_TYPES.includes(b.type) && b.data.agent_id) {
      if (!subagentIds.has(b.data.agent_id)) orphans += 1;
    }
  }
  assert.equal(orphans, 0, 'no orphan events — every node attaches to the tree');

  // Pre↔post pairing: each tool_use_id has exactly one :pre and one :post.
  const toolCalls = bodies.filter((b) => TOOL_CALL_TYPES.includes(b.type));
  const byTool = {};
  for (const b of toolCalls) {
    const [tid, phase] = b.id.split(':');
    byTool[tid] = byTool[tid] || new Set();
    byTool[tid].add(phase);
  }
  for (const [tid, phases] of Object.entries(byTool)) {
    assert.deepEqual([...phases].sort(), ['post', 'pre'], `${tid} paired pre↔post`);
  }
  // Subagent start/stop paired.
  const subPhases = bodies.filter((b) => b.type.includes('subagent')).map((b) => b.id);
  assert.deepEqual(subPhases.sort(), ['agent_A:started', 'agent_A:stopped']);
});

// ── signed out: the worker makes no COO call and skips the drain (2026-10-20) ──

test('signed out: no event POST, no token call, and the drain does not re-spill the backlog', async (t) => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const stub = await startStub();
  t.after(() => stub.close());
  const stateDir = makeStateDir();
  writeFileSync(
    join(stateDir, 'auth.json'),
    JSON.stringify({ accessToken: 'dead', refreshToken: 'dead-r', expiresAt: Date.now() - 60_000 })
  );
  writeFileSync(join(stateDir, 'signed-out.json'), JSON.stringify({ since: 'x', reason: 'invalid_grant', checkedAt: Date.now() }));
  for (let i = 0; i < 5; i += 1) await seedAuditRecord(stateDir, preRecord({ tool_use_id: `toolu_backlog_${i}` }));
  await seedAuditRecord(stateDir, preRecord());
  const env = stubEnv(stub, stateDir);
  delete env.NOBLECLOAK_DEV_TOKEN;
  const result = await runPostEvents(postToolUseInput(), env);
  assert.equal(result.code, 0);
  const spill = await waitForSpill(stateDir, 2);
  await new Promise((r) => setTimeout(r, 300));
  await stub.close();
  assert.equal(stub.requests.length, 0, 'zero requests of any kind while signed out');
  const ids = spill.map((s) => s.id).sort();
  assert.deepEqual(ids, ['toolu_0123456789:post', 'toolu_0123456789:pre'], 'only the in-band pair spills; the backlog is not re-spilled');
  assert.equal(readQueueRecords(stateDir).length, 6, 'the backlog is kept for after sign-in');
});

// ── permanent rejection end-to-end: dead pre's are never re-sent (2026-10-20) ──

test('403 tenant_run_mismatch on a drained backlog: each :pre is marked dead, the next drain re-sends nothing', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.eventStatus = 403;
  stub.eventErrorBody = { error: { code: 'tenant_run_mismatch', message: 'Access denied' }, meta: {} };
  const stateDir = makeStateDir();
  for (let i = 0; i < 3; i += 1) await seedAuditRecord(stateDir, preRecord({ tool_use_id: `toolu_old_${i}` }));
  // A token whose org is KNOWN (org_id claim): suppression needs both orgs known and equal.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const orgToken = `${b64({ alg: 'none' })}.${b64({ sub: 'u', org_id: '47aca786-0000-0000-0000-000000000000' })}.sig`;
  const env = stubEnv(stub, stateDir, { NOBLECLOAK_DEV_TOKEN: orgToken });

  await runPostEvents(subagentStopInput(), env);
  // stopped + first drained pre reach COO; once the run is known refused the
  // rest are dead-lettered without a network call.
  await stub.waitForEvents(2);
  const handled = await waitForSentIds(stateDir, 3);
  assert.deepEqual(handled.sort(), ['toolu_old_0', 'toolu_old_1', 'toolu_old_2'], 'all marked handled (dead)');
  assert.deepEqual(readSpillRecords(stateDir).filter((r) => r.id?.endsWith(':pre')), [], 'nothing spilled for retry');
  const posted = stub.eventRequests().length;

  // Next drain-eligible event in the SAME session: no backlog re-send, no network for this run at all.
  await runPostEvents(subagentStopInput({ agent_id: 'agent_two' }), env);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(stub.eventRequests().length, posted, 'known-refused run: zero further POSTs');
});

test('dispatcher shows a pending notice for this session as systemMessage on PostToolUse, once', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const stateDir = makeStateDir();
  const { postNotice } = await import('../scripts/lib/governance.mjs');
  postNotice('breaker-open', 'NobleCloak: audit delivery is failing', { NOBLECLOAK_STATE_DIR: stateDir });
  const first = await runPostEvents(postToolUseInput(), stubEnv(stub, stateDir));
  const second = await runPostEvents(postToolUseInput({ tool_use_id: 'toolu_2' }), stubEnv(stub, stateDir));
  assert.equal(first.output.systemMessage, 'NobleCloak: audit delivery is failing');
  assert.equal(second.output, null, 'shown once per session — no output the second time');
});
