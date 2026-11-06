#!/usr/bin/env node
/**
 * PostToolUse / PostToolUseFailure / SubagentStart / SubagentStop audit
 * dispatcher — the async whole-tree audit (epic build item #5,
 * brief 2026-06-09-plugin-posttooluse-adapter).
 *
 * One dispatcher for all four post-side events, keyed on hook_event_name.
 * Every governed tool call and every subagent spawn/stop lands in
 * coo_run_events asynchronously — fire-and-forget, never blocking the session
 * or a wide fan-out. Audit failure NEVER fails the tool call; it spills to
 * <state dir>/audit-spill.jsonl so degraded periods stay reconstructable.
 *
 * NON-BLOCKING by construction (brief "Decided constraints"): this process does
 * only synchronous work — parse stdin, build the envelopes, hand them to a
 * DETACHED, unref'd worker (post-events-worker.mjs) via a temp payload file —
 * then exits 0 in single-digit ms. The worker owns ALL network I/O: it POSTs
 * each envelope with the full AbortSignal.timeout(2000) backstop and spills
 * synchronously on failure/timeout/hung-endpoint. Because the worker is not
 * parented to the hook, nothing kills it mid-POST, so the abort always fires
 * and the catch→spill always runs — a hung ingest can neither wedge the
 * session nor silently drop an envelope.
 *
 * Chosen async form: detached child process (NOT the host's `{ async: true }`
 * output). The spike (2026-06-05, Claude Code 2.1.165) did not verify that the
 * host honors `{ async: true }` for these events, so we use a host-independent
 * detached child that is correct regardless of host behavior. Recorded here per
 * the brief's "pick what 2.1.165 honors and record it".
 *
 * A governed LOCAL tool call emits TWO envelopes — pre-phase (decision, joined
 * from brief #4's audit-queue record) and post-phase (decision + outcome). Both
 * fire independently. Calls that NEVER produce a Post (a denied/blocked call in
 * enforce mode, or a blocked subagent tool call that fabricates success) are
 * still shipped: the worker drains the Pre queue for any tool_use_id that no
 * Post reconciled and ships its `:pre` envelope — the fabricated-success
 * defense (brief Goal). A shipped ledger (audit-sent.jsonl) makes the drain
 * idempotent; server-side `(run_id, ce_id)` dedup makes a late Post harmless.
 *
 * A gateway-governed NobleCloak MCP tool call is the D3 exception (2026-07-09
 * session tool-call log brief): it emits exactly ONE envelope, the `:post`.
 * PreToolUse writes no audit-queue record for it (it stays gateway-governed,
 * never locally enforced), so there is no `:pre` to ship; the single `:post` is
 * an INDEPENDENT corroborating record (bn_corroborated_by:'action_ledger',
 * enforce_active:false) alongside the gateway's authoritative action-ledger audit.
 *
 * Pinned to Claude Code ≥ 2.1.165 field shapes (spike 2026-06-05):
 *   PostToolUse:        PreToolUse fields + tool_response, duration_ms
 *   PostToolUseFailure: PreToolUse fields + error, is_interrupt, duration_ms
 *   SubagentStart:      session_id, cwd, agent_id, agent_type, hook_event_name
 *   SubagentStop:       SubagentStart fields + agent_transcript_path, …
 *
 * Raw payloads never leave the machine — tool_response is dropped; only the
 * arg-digest/safe-summary (from the Pre record) and a truncated outcome ship.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSubagentEnvelope,
  buildToolCallEnvelopes,
  ensureStateDir,
  findPreRecord,
  isNobleCloakMcpTool,
  spillAuditEvent,
  stateDir,
  takeNotices,
} from '../lib/governance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'post-events-worker.mjs');

function logErr(message) {
  process.stderr.write(`noblecloak-audit: ${message}\n`);
}

/**
 * Mirror the Pre-side degraded-record posture (governance.mjs degraded_reason
 * 'malformed-input' / 'internal-error: <message>'): record post-side adapter
 * degradation to the audit data so it is countable, not stderr-only. We have no
 * envelope to ship and no tool_use_id to correlate, so we spill a minimal
 * degraded marker. Wrapped so the write itself can never disturb exit-0.
 */
function recordPostDegraded(reason) {
  try {
    spillAuditEvent({
      bn_degraded: true,
      degraded_side: 'post',
      degraded_reason: reason,
      time: new Date().toISOString(),
    });
  } catch (err) {
    logErr(`degraded-marker spill failed (${err?.message || err}).`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

/** Envelopes to emit for one hook input — empty when the event is not audited. */
function envelopesFor(input) {
  switch (input.hook_event_name) {
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      // ADR-0033 §2 (amended, 2026-07-09 brief) — NobleCloak MCP tools stay
      // gateway-governed and are NEVER locally enforced (the COO gateway is the
      // enforcement + authoritative-audit point). We no longer stay silent: the
      // hook now logs a single INDEPENDENT corroborating :post record for them,
      // marked bn_corroborated_by:'action_ledger' with enforce_active:false, so
      // the session tool-call log is complete. buildToolCallEnvelopes returns the
      // :post ONLY when gatewayGoverned (no :pre — PreToolUse writes no record).
      const gatewayGoverned = isNobleCloakMcpTool(input.tool_name);
      if (typeof input.tool_use_id !== 'string' || typeof input.session_id !== 'string') return [];
      const pre = findPreRecord(input.tool_use_id);
      return buildToolCallEnvelopes(input, pre, { gatewayGoverned });
    }
    case 'SubagentStart':
    case 'SubagentStop': {
      if (typeof input.agent_id !== 'string' || typeof input.session_id !== 'string') return [];
      return [buildSubagentEnvelope(input)];
    }
    default:
      return [];
  }
}

/**
 * Hand the envelopes (and a drain flag) to the detached worker and return
 * immediately. The worker outlives this process and owns the POST/spill/drain
 * out-of-band, so the hook never blocks on the network.
 */
function dispatchToWorker(envelopes, drain) {
  const dir = ensureStateDir();
  const payloadPath = join(dir, `audit-emit.${process.pid}.${randomBytes(4).toString('hex')}.json`);
  writeFileSync(payloadPath, JSON.stringify({ envelopes, drain }));

  const child = spawn(process.execPath, [WORKER_PATH, payloadPath], {
    detached: true,
    stdio: 'ignore',
    // The worker reads the same state-dir/COO/dev-token config from the env.
    env: process.env,
  });
  child.unref();
}

async function main() {
  // NOBLECLOAK_SDK_HOOK_ACTIVE no longer suppresses event delivery. Versions up
  // to 0.2.5 returned here when it was set (plugin-dev#1); it is now ignored.
  let input;
  try {
    input = JSON.parse(await readStdin());
    if (!input || typeof input !== 'object') throw new Error('not an object');
  } catch (err) {
    // Malformed stdin: nothing to emit. Audit is best-effort and must never
    // disturb the tool call, so note it, record a countable degraded marker
    // (mirrors the Pre-side 'malformed-input' record), and exit clean.
    logErr(`malformed hook input (${err.message}) — no event emitted.`);
    recordPostDegraded('malformed-input');
    return;
  }

  const envelopes = envelopesFor(input);

  // Drain the Pre queue (fabricated-success defense) on every tool-call Post and
  // on SubagentStop — so a denied/blocked call in the ROOT session (which never
  // produces a Post of its own) is still swept up by the next audited event, and
  // a blocked subagent's fabricated-success calls ship on SubagentStop. NOT on
  // SubagentStart: draining on Start as well as Stop doubled the Subagent-
  // boundary drain frequency for no benefit (brief 2026-06-15 root-cause #3).
  // The drain is now bounded (per-drain cap), single-flight (lock), and skipped
  // when the breaker is open — all in the detached worker, off the hot path.
  const drain =
    input.hook_event_name === 'SubagentStop' ||
    input.hook_event_name === 'PostToolUse' ||
    input.hook_event_name === 'PostToolUseFailure';

  // User-visible notices queued by earlier (detached) workers — breaker open,
  // this session's run refused for the current org, signed out — shown once per
  // session as `systemMessage` (Claude Code shows it to the user for
  // PostToolUse/PostToolUseFailure). Only on those two events: their contract
  // is the one verified (code.claude.com/docs/en/hooks, 2026-10-20). A notice
  // queued by THIS event's worker surfaces on the next hook.
  if (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') {
    const notices = takeNotices(input.session_id);
    if (notices.length > 0) process.stdout.write(JSON.stringify({ systemMessage: notices.join('\n') }));
  }

  // Nothing to do: no envelopes (excluded/malformed event) AND no drain.
  if (envelopes.length === 0 && !drain) return;

  dispatchToWorker(envelopes, drain);
}

// ── Never-block top level ──────────────────────────────────────────────────
try {
  await main();
} catch (err) {
  // Last resort: audit must never disturb the tool call. Swallow + log, and
  // record a countable degraded marker (mirrors the Pre-side top-level
  // 'internal-error: <message>' record) so a recurring adapter error is
  // visible in the audit data, not only in per-process stderr.
  logErr(`unexpected error — ${err?.stack || err?.message || err}.`);
  recordPostDegraded(`internal-error: ${String(err?.message || err).slice(0, 200)}`);
}

process.exit(0);
