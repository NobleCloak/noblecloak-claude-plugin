#!/usr/bin/env node
/**
 * PreToolUse governance adapter — ADR-0033 §9 plugin adapter (epic build item #4).
 *
 * Every matched local tool call resolves against COO's
 * POST /v1/coo/local/resolve before executing:
 *   - AUDIT-ONLY by default (NOBLECLOAK_LOCAL_ENFORCE unset/false): always emits
 *     permissionDecision 'allow', still resolves, records the would-be decision
 *     in the audit queue for brief #5's emitter. No exceptions — even deny
 *     responses pass through.
 *   - ENFORCE (NOBLECLOAK_LOCAL_ENFORCE=true): obeys the server decision
 *     (always_allow→allow, ask→ask, deny→deny; headless ask→deny is applied
 *     SERVER-side). On resolve failure: side-effect-aware fail-mode (read →
 *     fail-open, write/external/delete/admin → fail-closed).
 *
 * Protocol: command hook, JSON on stdin, JSON hookSpecificOutput on stdout.
 * Pinned to Claude Code ≥ 2.1.165 field shapes (spike 2026-06-05):
 *   stdin: session_id, transcript_path, cwd, permission_mode, tool_name,
 *          tool_input, tool_use_id (+ agent_id/agent_type inside subagents)
 *   env:   CLAUDE_CODE_ENTRYPOINT, CLAUDE_PROJECT_DIR, CLAUDE_CODE_SESSION_ID
 *
 * NEVER throws: top-level catch → fail-mode decision + one stderr line, exit 0
 * with valid JSON (an unhandled hook exception interrupts the agent).
 */

import {
  appendAuditRecord,
  argDigest,
  argSummary,
  budgetClock,
  cooBaseUrl,
  detectChannel,
  failModeDecision,
  isNobleCloakMcpTool,
  isEnforceMode,
  isRejectedRefresh,
  mapModeToDecision,
  offlineSideEffectLevel,
  refreshAuthState,
  remainingBudgetMs,
  resolveTimeoutMs,
  takeNotices,
  toolRefFor,
  usableBearer,
  writeSignedOut,
  DEFAULT_TOTAL_BUDGET_MS,
  RESOLVE_PATH,
  UNKNOWN_TOOL_SIDE_EFFECT,
} from '../lib/governance.mjs';

// ── Hook output protocol ───────────────────────────────────────────────────

// Session id of the current hook input, once parsed — lets emit() attach any
// queued once-per-session notices (signed out, breaker open, run/org mismatch).
let currentSessionId = null;

/**
 * Write the decision JSON. Pending user-visible notices ride along as
 * `systemMessage` (shown to the user by Claude Code for PreToolUse; stderr from
 * an exit-0 hook is not). Notice lookup is best-effort and never blocks the decision.
 */
function emit(decision, reason) {
  let notices = [];
  try {
    notices = takeNotices(currentSessionId);
  } catch {
    notices = [];
  }
  process.stdout.write(
    JSON.stringify({
      ...(notices.length > 0 ? { systemMessage: notices.join('\n') } : {}),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
}

function logErr(message) {
  process.stderr.write(`noblecloak-governance: ${message}\n`);
}

/** Audit write is best-effort by design — it must never affect the decision. */
function appendAuditRecordBestEffort(record) {
  try {
    appendAuditRecord(record);
  } catch (err) {
    logErr(`failed to append audit record — ${err.message}`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// ── Resolve call ───────────────────────────────────────────────────────────

async function postResolve(body, token, timeoutMs) {
  const response = await fetch(`${cooBaseUrl()}${RESOLVE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
}

/**
 * Resolve with a local expiry check, then 401→refresh→retry-once. Returns
 *   { ok: true, resolution, tokenSource } |
 *   { ok: false, reason }    (degraded — caller applies fail-mode)
 *
 * No COO call is made when the plugin is signed out (`<state dir>/signed-out.json`)
 * or holds an expired token whose one refresh did not succeed: the reason is
 * 'no-token' / 'signed-out' / 'token-expired' and the caller applies the same
 * fail-mode as any other degraded resolve (audit-only allows; enforce fails
 * closed for non-read tools). A refresh REJECTED on the 401 path writes the
 * signed-out marker so the next calls skip COO too.
 *
 * Every network step (resolve #1, OAuth discovery, token refresh, resolve #2)
 * shares one cumulative deadline (DEFAULT_TOTAL_BUDGET_MS) so the worst-case
 * path stays under the hooks.json PreToolUse timeout — if the host killed the
 * hook first, no decision JSON would be emitted and enforce-mode fail-closed
 * would silently degrade to the host's hook-timeout default.
 */
async function resolveWithAuth(body) {
  const timeoutMs = resolveTimeoutMs();
  // `deadline` rides the real clock so the refresh path's own deadline checks
  // stay consistent and a healthy refresh always finishes before it. `now` is
  // the (normally real) budget-checkpoint clock — consulted once per attempt
  // and never inside the refresh — which a test seam can advance to exercise
  // the budget-exhausted guard.
  const deadline = Date.now() + DEFAULT_TOTAL_BUDGET_MS;
  const now = budgetClock();
  let bearer = await usableBearer(process.env, { deadline, timeoutMs });
  if (!bearer.token) {
    return { ok: false, reason: bearer.reason };
  }

  let attempt = 0;
  // At most two attempts: initial + one retry after a 401-triggered refresh.
  while (attempt < 2) {
    attempt += 1;
    const attemptMs = remainingBudgetMs(deadline, timeoutMs, now);
    if (attemptMs <= 0) {
      return { ok: false, reason: 'budget-exhausted' };
    }
    let response;
    try {
      response = await postResolve(body, bearer.token, attemptMs);
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return { ok: false, reason: timedOut ? 'timeout' : `unreachable: ${err.message}` };
    }

    if (response.status === 401 && attempt === 1 && bearer.source === 'auth-file' && bearer.refreshToken) {
      try {
        const updated = await refreshAuthState(process.env, { timeoutMs, deadline });
        bearer = { token: updated.accessToken, source: 'auth-file', refreshToken: updated.refreshToken };
        continue; // retry once with the refreshed token
      } catch (err) {
        if (isRejectedRefresh(err)) {
          writeSignedOut(err.message, process.env, { credentialFp: err.credentialFp });
          return { ok: false, reason: 'signed-out' };
        }
        return { ok: false, reason: `refresh-failed: ${err.message}` };
      }
    }

    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}` };
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch {
      return { ok: false, reason: 'invalid-response-body' };
    }
    // COO wraps the resolution in a { data, meta } envelope (the canonical
    // NobleCloak API response shape); the policy fields (mode/source/
    // side_effect_level) live under .data. Unwrap it — falling back to the bare
    // object so a future unwrapped response stays compatible. This `resolution`
    // is also stored on the Pre record (record.resolve) and feeds the
    // PostToolUse event's decision.source, so the unwrap fixes both the resolve
    // decision and event delivery.
    const resolution =
      parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object'
        ? parsed.data
        : parsed;
    if (!resolution || typeof resolution !== 'object' || mapModeToDecision(resolution.mode) === null) {
      return { ok: false, reason: 'invalid-response-mode' };
    }
    return { ok: true, resolution, tokenSource: bearer.source };
  }
  return { ok: false, reason: 'retries-exhausted' };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(startedAt) {
  const enforce = isEnforceMode();

  // No environment variable turns this hook off. Versions up to 0.2.5 skipped
  // resolve and audit when NOBLECLOAK_SDK_HOOK_ACTIVE was set, which nothing
  // could verify (plugin-dev#1); that variable is now ignored.
  let input;
  try {
    input = JSON.parse(await readStdin());
    if (!input || typeof input !== 'object') throw new Error('not an object');
  } catch (err) {
    // Malformed stdin: we cannot classify the tool, so apply the same
    // fail-mode as every other degraded path with the unknown (non-read)
    // side-effect level — audit-only allows, enforce fails closed. Mirrors
    // the top-level catch exactly.
    const { decision, failMode } = failModeDecision(UNKNOWN_TOOL_SIDE_EFFECT, enforce);
    logErr(`malformed hook input (${err.message}) — applying fail-mode '${failMode}' (${decision}).`);
    appendAuditRecordBestEffort({
      ts: new Date(startedAt).toISOString(),
      hook_event: 'PreToolUse',
      session_id: null,
      tool_use_id: null,
      enforce,
      decision,
      would_decision: failModeDecision(UNKNOWN_TOOL_SIDE_EFFECT, true).decision,
      degraded: true,
      degraded_reason: 'malformed-input',
      fail_mode: failMode,
      duration_ms: Date.now() - startedAt,
    });
    emit(decision, `NobleCloak governance: malformed hook input — fail-mode ${failMode}.`);
    return;
  }

  if (typeof input.session_id === 'string') currentSessionId = input.session_id;
  const toolName = input.tool_name;

  // ADR-0033 §2 — govern the gap, never double-enforce: NobleCloak MCP tools are
  // gateway-governed; immediate allow, no resolve, no audit-queue record at
  // pre-time (the gateway is the enforcement + authoritative-audit point;
  // PostToolUse still emits an independent corroborating :post — see
  // post-events.mjs).
  if (isNobleCloakMcpTool(toolName)) {
    emit('allow', 'NobleCloak governance: noblecloak MCP tool — governed by the COO gateway.');
    return;
  }

  const toolRef = toolRefFor(toolName);
  const offlineLevel = offlineSideEffectLevel(toolRef);

  // D5 — version/shape guard (research-preview drift posture, spike Q4): if
  // load-bearing fields are missing the host's hook shape has drifted from the
  // pinned 2.1.165 contract; don't trust the input — loud stderr + fail-mode.
  if (typeof input.tool_use_id !== 'string' || typeof input.session_id !== 'string' || !toolRef) {
    const { decision, failMode } = failModeDecision(offlineLevel, enforce);
    logErr(
      'hook input is missing load-bearing fields (tool_use_id/session_id/tool_name) — ' +
        'Claude Code hook shape may have drifted from the pinned >=2.1.165 contract. ' +
        `Applying fail-mode '${failMode}' (${decision}).`
    );
    appendAuditRecordBestEffort({
      ts: new Date(startedAt).toISOString(),
      hook_event: 'PreToolUse',
      session_id: typeof input.session_id === 'string' ? input.session_id : null,
      tool_use_id: typeof input.tool_use_id === 'string' ? input.tool_use_id : null,
      ...(typeof input.tool_name === 'string' ? { tool_name: input.tool_name } : {}),
      ...(toolRef ? { tool_ref: toolRef } : {}),
      enforce,
      decision,
      would_decision: failModeDecision(offlineLevel, true).decision,
      degraded: true,
      degraded_reason: 'shape-drift',
      fail_mode: failMode,
      duration_ms: Date.now() - startedAt,
    });
    emit(decision, `NobleCloak governance: hook-input shape drift — fail-mode ${failMode}.`);
    return;
  }

  const channel = detectChannel(process.env.CLAUDE_CODE_ENTRYPOINT, input.agent_id);
  const digest = argDigest(input.tool_input);
  const summary = argSummary(toolName, input.tool_input, input.cwd);

  const requestBody = {
    tool_ref: toolRef,
    bn_invocation_channel: channel,
    session_id: input.session_id,
    ...(input.agent_id ? { agent_id: input.agent_id } : {}),
    ...(input.agent_type ? { agent_type: input.agent_type } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    arg_digest: digest,
    arg_summary: summary,
  };

  if (process.env.NOBLECLOAK_DEV_TOKEN) {
    logErr('using NOBLECLOAK_DEV_TOKEN (dev-only override) for resolve auth.');
  }

  const result = await resolveWithAuth(requestBody);

  const record = {
    ts: new Date(startedAt).toISOString(),
    hook_event: 'PreToolUse',
    session_id: input.session_id,
    tool_use_id: input.tool_use_id,
    ...(input.agent_id ? { agent_id: input.agent_id } : {}),
    ...(input.agent_type ? { agent_type: input.agent_type } : {}),
    tool_name: toolName,
    tool_ref: toolRef,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    bn_invocation_channel: channel,
    arg_digest: digest,
    arg_summary: summary,
    enforce,
  };

  let decision;
  let reason;

  if (result.ok) {
    const { resolution } = result;
    const mapped = mapModeToDecision(resolution.mode);
    record.token_source = result.tokenSource;
    record.resolve = resolution;
    record.would_decision = mapped;
    record.degraded = false;
    if (enforce) {
      decision = mapped;
      reason =
        `NobleCloak governance: ${resolution.mode} (${resolution.source}) for ${toolRef}` +
        (resolution.headless_degraded ? ` — ${resolution.reason || 'ask-unresolvable-headless'}` : '');
    } else {
      decision = 'allow';
      reason =
        mapped === 'allow'
          ? `NobleCloak governance (audit-only): ${resolution.mode} (${resolution.source}) for ${toolRef}`
          : `NobleCloak governance (audit-only): would ${mapped} ${toolRef} (${resolution.source}) — allowed; recorded for audit.`;
    }
  } else {
    const { decision: failDecision, failMode } = failModeDecision(offlineLevel, enforce);
    decision = failDecision;
    record.would_decision = failModeDecision(offlineLevel, true).decision;
    record.degraded = true;
    record.degraded_reason = result.reason;
    record.fail_mode = failMode;
    reason = `NobleCloak governance: resolve unavailable (${result.reason}) — fail-mode ${failMode} for ${toolRef} (${offlineLevel}).`;
    logErr(`resolve degraded (${result.reason}) — ${failMode} (${decision}) for ${toolRef}.`);
  }

  record.decision = decision;
  record.duration_ms = Date.now() - startedAt;

  appendAuditRecordBestEffort(record);

  emit(decision, reason);
}

// ── Never-throw top level ──────────────────────────────────────────────────

const hookStartedAt = Date.now();
try {
  await main(hookStartedAt);
} catch (err) {
  // Unknown failure: we may not even know the tool — audit-only allows;
  // enforce fails closed (we cannot classify, so treat as non-read). This is
  // the path of last resort: every step below is individually guarded so a
  // failure here can never escape as an unhandled hook exception.
  const enforce = (() => {
    try {
      return isEnforceMode();
    } catch {
      return false;
    }
  })();
  const { decision, failMode } = failModeDecision(UNKNOWN_TOOL_SIDE_EFFECT, enforce);
  // Same countability contract as the malformed-input/shape-drift paths:
  // internal-error degradation must be visible to the brief #5 emitter from
  // the audit data, not stderr-only.
  try {
    appendAuditRecordBestEffort({
      ts: new Date(hookStartedAt).toISOString(),
      hook_event: 'PreToolUse',
      session_id: null,
      tool_use_id: null,
      enforce,
      decision,
      would_decision: failModeDecision(UNKNOWN_TOOL_SIDE_EFFECT, true).decision,
      degraded: true,
      degraded_reason: `internal-error: ${String(err?.message || err).slice(0, 200)}`,
      fail_mode: failMode,
      duration_ms: Date.now() - hookStartedAt,
    });
  } catch {
    // best-effort of the best-effort — never let audit break the emit
  }
  logErr(`unexpected error — ${err?.stack || err?.message || err}. Emitting fail-mode ${failMode} (${decision}).`);
  emit(decision, `NobleCloak governance: internal hook error — fail-mode ${failMode}.`);
}

process.exit(0);
