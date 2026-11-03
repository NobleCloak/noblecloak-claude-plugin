#!/usr/bin/env node
/**
 * Detached audit-emit worker — the out-of-band half of the PostToolUse adapter
 * (brief 2026-06-09-plugin-posttooluse-adapter).
 *
 * The dispatcher (post-events.mjs) is a hook: it must return IMMEDIATELY so it
 * never blocks the session or a 16-wide fan-out. It does the synchronous work
 * (parse, build envelopes, write this worker's payload), spawns this worker
 * `detached` + `unref`'d, and exits 0. This process — no longer parented to the
 * hook — owns the network: it POSTs each envelope with the full
 * AbortSignal.timeout(2000) backstop and spills synchronously on failure,
 * timeout, OR a hung endpoint. Because nothing kills it mid-POST (no
 * grace-window cutoff, unlike the old in-process race), the abort always fires
 * and the catch→spill always runs — closing the hung-ingest gap that race had.
 *
 * Chosen async form: DETACHED CHILD PROCESS (not the host's `{ async: true }`
 * hook output). Rationale recorded for the brief's "pick what 2.1.165 honors
 * and record it": the spike (2026-06-05, Claude Code 2.1.165) did not verify
 * that the host honors `{ async: true }` for PostToolUse/Subagent events, so we
 * use a host-independent detached child that is correct regardless. The hook
 * returns in single-digit ms; this worker completes the POST/spill/drain
 * out-of-band.
 *
 * Payload (argv[2]) is a temp-file path holding JSON:
 *   { envelopes: Envelope[], drain: boolean }
 * Env config (COO base, state dir, dev token) is inherited from the dispatcher.
 */

import { readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  acquireDrainLock,
  boundAuditSpill,
  compactAuditQueueAndLedger,
  cooCallsSuspended,
  drainUnshippedPreEnvelopes,
  emitAuditEvent,
  EMIT_DELIVERED,
  EMIT_REJECTED,
  loadShippedSet,
  markPreDead,
  markPreShipped,
  readBreaker,
  readSignedOut,
  recordWorkerDegraded,
  releaseDrainLock,
  workerDeadlineMs,
} from '../lib/governance.mjs';

// Re-export the canonical deadline accessor (defined in governance.mjs so the
// shared drain-lock stale window can be derived from the SAME value) so the
// worker's own tests can import it from here unchanged.
export { workerDeadlineMs };

function logErr(message) {
  process.stderr.write(`noblecloak-audit-worker: ${message}\n`);
}

// The drain lock currently held by this worker (or null). The watchdog reads it
// to best-effort release a lock orphaned by a mid-drain process.exit (see below).
let heldDrainLock = null;

// Hard process-level watchdog (brief 2026-06-15 D3): a worker can NEVER outlive
// this bound, regardless of backlog size or a hung / SYN_SENT endpoint whose
// socket the per-request AbortSignal can't actually tear down. Armed the instant
// the worker starts; `unref`'d so it never keeps an otherwise-finished worker
// alive. The breaker + drain cap keep the normal path far under this — the
// watchdog is the last-resort backstop against an unbounded worker lifetime.
//
// process.exit terminates synchronously, so a deadline that fires mid-drain
// skips the try/finally that would releaseDrainLock — leaving the shared drain
// lock orphaned until its stale window elapses (which blocks every other worker's
// drain). Before exiting we therefore: (1) best-effort release a still-held drain
// lock so a watchdog kill self-heals immediately instead of waiting out the stale
// steal; (2) record a countable degraded marker + log, because exit(0) is an
// unconditional success signal yet the worker may have shipped only part of its
// work (a recurring deadline kill must be visible in the audit data, not look
// identical to a clean exit). The durability invariant is preserved regardless —
// the unshipped obligation lives in the queue ledger, deferred to the next event.
function armWatchdog(env = process.env) {
  setTimeout(() => {
    try {
      releaseDrainLock(heldDrainLock);
    } catch {
      // best-effort — the stale steal is the backstop if this fails
    }
    try {
      recordWorkerDegraded('worker-deadline', env);
    } catch {
      // best-effort — never let the degraded-marker write block the exit
    }
    logErr('worker deadline exceeded — exiting; remaining work deferred to next event.');
    process.exit(0);
  }, workerDeadlineMs(env)).unref();
}

/** tool_use_id of a `<tool_use_id>:pre` envelope, else null. */
function preToolUseId(envelope) {
  if (typeof envelope?.id !== 'string') return null;
  const idx = envelope.id.lastIndexOf(':pre');
  if (idx === -1 || idx !== envelope.id.length - ':pre'.length) return null;
  return envelope.id.slice(0, idx);
}

/**
 * Ship one in-band envelope. The `:post` (and subagent events) always ship. A
 * `:pre` is marked shipped at most once per tool_use_id across the whole
 * session: if the drain on an earlier event already shipped it (the call's Post
 * simply hadn't fired yet), the shipped ledger short-circuits this in-band
 * re-send. Server-side `(run_id, ce_id)` dedup would make a duplicate harmless
 * anyway — this just keeps the wire (and the offline reconstruction) clean.
 *
 * A `:pre` is recorded in the ledger ONLY when emitAuditEvent reports
 * EMIT_DELIVERED (a confirmed 2xx). If COO is unreachable the envelope is
 * spilled (not delivered) and the tool_use_id stays OUT of the ledger, so it
 * remains eligible for re-ship on the next drain after COO recovers — the
 * fabricated-success defense must not silently degrade to a local-only file
 * during an outage window.
 *
 * `shipped` is the ledger snapshot taken before the in-band loop; we also add
 * to it as we go so two in-band pre's in one payload can't both ship (there is
 * never more than one today, but it keeps the invariant local).
 *
 * A `:pre` COO refused PERMANENTLY (EMIT_REJECTED — e.g. 403
 * tenant_run_mismatch) is marked dead in the same ledger, so no drain ever
 * re-sends it: re-sending can't succeed, and a dead backlog must not keep
 * re-spilling or count as an outage.
 *
 * Every in-band pre tool_use_id is recorded in `attempted` (whether delivered
 * or only spilled) so the same-process drain never RE-emits a pre this loop
 * just handled — without that, a pre that spilled in-band (COO down, so it is
 * not ledgered) would be spilled a second time by the immediately-following
 * drain. Cross-EVENT re-ship after recovery is still gated by the ledger, not
 * this per-process set.
 */
async function ship(envelope, shipped, attempted) {
  const tid = preToolUseId(envelope);
  if (tid && shipped.has(tid)) return; // already shipped by a prior drain
  if (tid) attempted.add(tid);
  const status = await emitAuditEvent(envelope, process.env, logErr);
  if (tid && status === EMIT_DELIVERED) {
    markPreShipped(tid);
    shipped.add(tid);
  } else if (tid && status === EMIT_REJECTED) {
    markPreDead(tid);
    shipped.add(tid);
  }
}

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    logErr('no payload path — nothing to emit.');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(payloadPath, 'utf-8'));
  } catch (err) {
    logErr(`unreadable payload (${err?.message || err}) — nothing to emit.`);
    return;
  } finally {
    // Best-effort cleanup of the handoff file regardless of parse outcome.
    try {
      rmSync(payloadPath, { force: true });
    } catch {
      // leave it — a stray temp file is harmless
    }
  }

  const envelopes = Array.isArray(payload.envelopes) ? payload.envelopes : [];
  const shipped = loadShippedSet();
  // tool_use_ids whose `:pre` this process already emitted in-band (delivered
  // OR spilled) — the drain skips these so an outage-spilled pre is not spilled
  // twice in the same process.
  const attempted = new Set();

  // Ship the in-band envelopes (the pre+post pair, or a subagent event)
  // CONCURRENTLY — they are independent POSTs, and serial awaits would stack
  // each one's full AbortSignal.timeout against a hung endpoint (2s × N). We
  // still AWAIT them all before draining so a normal pre+post records its
  // `:pre` in the ledger BEFORE the drain runs — otherwise the drain would
  // re-ship the same pre this call just sent.
  await Promise.allSettled(
    envelopes.map((envelope) =>
      ship(envelope, shipped, attempted).catch((err) => {
        // emitAuditEvent honors a never-throws contract (a spill-write failure
        // is logged inside it, not thrown); this is belt-and-suspenders so one
        // bad envelope never strands the rest (or the drain).
        logErr(`emit failed (${err?.message || err}) — continuing.`);
      })
    )
  );

  // Bound the spill BEFORE the drain (brief D4): independent of the
  // drain/compaction path, so it caps the file even on a non-draining event
  // (SubagentStart never compacts) or when the breaker skips the drain or the
  // watchdog kills us mid-drain — the gap that let the spill reach 1.86 GB. This
  // covers the pre-existing backlog AND any lines the in-band ship just spilled.
  try {
    const { trimmed, dropped } = boundAuditSpill(process.env);
    if (trimmed && dropped > 0) {
      // The in-file marker (governance.mjs boundAuditSpill) records the drop in
      // the spill itself, but that file is the one being trimmed/rotated — so a
      // substantial, ongoing forensic-data loss would be effectively silent at the
      // process level. Surface it here too so an operator sees it on stderr.
      logErr(`spill trimmed: dropped ${dropped} forensic line(s) to retention tail.`);
    }
  } catch (err) {
    logErr(`spill bounding failed (${err?.message || err}).`);
  }

  // Fabricated-success defense: ship the `:pre` for every queued Pre record
  // that no Post ever reconciled. Runs on SubagentStop (tree-segment boundary)
  // and tool-call Posts — see the dispatcher's drain decision. The drain is now
  // bounded and self-limiting (brief 2026-06-15):
  //   - SKIPPED while the breaker is open — no point enumerating and re-spilling
  //     the whole backlog during a known outage; the spilled pre's stay
  //     ledger-eligible for a post-recovery drain.
  //   - SINGLE-FLIGHT under a non-blocking lock — a worker that can't take the
  //     lock skips its drain (the holder covers the shared backlog), so many
  //     concurrent workers never re-ship the same backlog at once.
  //   - CAPPED to the oldest N envelopes per drain (inside drainUnshippedPreEnvelopes).
  //   - SKIPPED while signed out / logged out (cooCallsSuspended): no COO call
  //     may be made, and the queued records keep until sign-in. If a refresh
  //     inside this drain is
  //     rejected, the marker appears mid-loop and the loop stops.
  if (payload.drain && readBreaker(process.env).phase !== 'open' && !cooCallsSuspended(process.env)) {
    const lock = acquireDrainLock();
    if (lock) {
      // Publish the held lock so the watchdog can best-effort release it if a
      // mid-drain process.exit skips the finally below (otherwise the orphaned
      // lock blocks every other worker's drain until its stale window elapses).
      heldDrainLock = lock;
      try {
        let drained;
        try {
          drained = drainUnshippedPreEnvelopes();
        } catch (err) {
          logErr(`drain enumeration failed (${err?.message || err}).`);
          drained = [];
        }
        for (const { toolUseId, envelope } of drained) {
          // This process already emitted this pre in-band (delivered or spilled);
          // don't emit it twice in one run. A still-unshipped pre stays eligible
          // for the NEXT event's drain via the ledger.
          if (attempted.has(toolUseId)) continue;
          if (readSignedOut(process.env)) break; // signed out mid-drain — stop calling COO
          try {
            // Mark shipped only on a confirmed 2xx — a spilled :pre (COO outage)
            // stays eligible for re-ship on the next drain after recovery.
            const status = await emitAuditEvent(envelope, process.env, logErr);
            if (status === EMIT_DELIVERED) markPreShipped(toolUseId);
            else if (status === EMIT_REJECTED) markPreDead(toolUseId); // permanent — never re-send
          } catch (err) {
            logErr(`drained emit failed for ${toolUseId} (${err?.message || err}).`);
          }
        }
      } finally {
        releaseDrainLock(lock);
        heldDrainLock = null;
      }
    }
  }

  // Bounded retention: compact the append-only queue + ledger (and bound the
  // spill, at its tail) on any drain-eligible event — REGARDLESS of the breaker.
  // Compaction is local file I/O (no network), so it keeps the files bounded
  // even while COO is down, which the old "compact only after a completed drain"
  // path did not (the never-completing drain meant the spill never got bounded).
  // Best-effort — a compaction failure never disturbs the audit pipeline or exit-0.
  if (payload.drain) {
    try {
      compactAuditQueueAndLedger();
    } catch (err) {
      logErr(`compaction failed (${err?.message || err}).`);
    }
  }
}

// Run the worker only when executed directly (the detached child the dispatcher
// spawns), NOT when imported — importing for a unit test must not arm the
// watchdog, run main(), or process.exit(0). argv[1] is the script path the
// runtime invoked; it matches this module's URL only on direct execution.
const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  armWatchdog();
  try {
    await main();
  } catch (err) {
    logErr(`unexpected error — ${err?.stack || err?.message || err}.`);
  }
  process.exit(0);
}
