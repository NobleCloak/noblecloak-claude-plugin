#!/usr/bin/env node
/**
 * Token refresh script — called by the SessionStart hook.
 *
 * Refreshes the plugin's governance access token (`auth.json`) if expired or
 * near-expiry, and likewise every per-resource token under `auth.json`'s `tokens`
 * (the govern token minted by /noblecloak-propose-tool). It does NOT write `.mcp.json`: the MCP connection is owned by
 * Claude Code's native OAuth against the committed, tokenless `.mcp.json`. This
 * script only keeps `auth.json` fresh for the governance hooks
 * (`/v1/coo/local/resolve` + `/v1/coo/local/events`).
 *
 * Auth endpoints are discovered per RFC 8414 from NOBLECLOAK_ISSUER (the per-env
 * API host — Core is the OAuth 2.1 AS). The refresh shares one cumulative
 * deadline (SCRIPT_BUDGET_MS) so the worst-case path (lock wait + discovery +
 * token POST) stays under the hooks.json SessionStart timeout (15s).
 */

import {
  AuthDiscoveryError,
  TokenRefreshError,
  clearSignedOut,
  credentialFingerprint,
  isRejectedRefresh,
  isTokenExpired,
  loadAuthState,
  markNoticeShown,
  migrateLegacyState,
  readSignedOut,
  refreshAuthState,
  refreshTokenFor,
  signedOutMessage,
  takeNotices,
  writeSignedOut,
} from './lib/governance.mjs';

// hooks.json SessionStart timeout is 15s; leave headroom for node startup.
const SCRIPT_BUDGET_MS = 12_000;
const scriptDeadline = Date.now() + SCRIPT_BUDGET_MS;

// ── Output channels ─────────────────────────────────────────────────────
//
// Claude Code hook contract (code.claude.com/docs/en/hooks, fetched
// 2026-10-20): a SessionStart hook's plain stdout is added to CLAUDE's context,
// not shown to the user; stderr from an exit-0 hook is never shown; the JSON
// `systemMessage` field is the "warning message shown to the user". So this
// script collects two lists and writes ONE JSON object at the end:
//   visible → systemMessage (what the user must act on: signed out, refresh trouble)
//   context → hookSpecificOutput.additionalContext (what Claude should know)
// The stderr lines are kept for the debug log.
const visible = [];
const context = [];

function finish() {
  if (visible.length > 0 || context.length > 0) {
    process.stdout.write(
      JSON.stringify({
        ...(visible.length > 0 ? { systemMessage: visible.join('\n') } : {}),
        ...(context.length > 0
          ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n') } }
          : {}),
      })
    );
  }
  process.exit(0);
}

/**
 * The session id from the SessionStart hook input on stdin (falls back to
 * CLAUDE_CODE_SESSION_ID). Never blocks: a TTY (a manual `npm run refresh`) is
 * not read, and a stdin that never closes is abandoned after 1s.
 */
async function readSessionId() {
  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID || null;
  if (process.stdin.isTTY) return fromEnv;
  try {
    const raw = await Promise.race([
      (async () => {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf-8');
      })(),
      new Promise((resolve) => setTimeout(() => resolve(''), 1000).unref()),
    ]);
    const input = raw ? JSON.parse(raw) : null;
    return typeof input?.session_id === 'string' ? input.session_id : fromEnv;
  } catch {
    return fromEnv;
  }
}

// ── Main ────────────────────────────────────────────────────────────────

const BUFFER_MS = 5 * 60 * 1000; // refresh anything expiring within 5 minutes

/** Print the failure advice for one refresh error; `relogin` is the fix for a rejected grant. */
function reportRefreshFailure(err, reloginAdvice) {
  if (err instanceof AuthDiscoveryError) {
    // Discovery/infrastructure failure — re-login would not help.
    console.error(`NobleCloak: Token refresh unavailable — ${err.message}`);
  } else if (err instanceof TokenRefreshError && err.transient) {
    // 5xx / network / non-JSON token endpoint — transient; re-login would not help.
    console.error(`NobleCloak: Token refresh failed — ${err.message}`);
  } else {
    // The grant itself was rejected (e.g. invalid_grant) — re-login IS the fix.
    console.error(`NobleCloak: Token refresh failed — ${err.message}. ${reloginAdvice}`);
  }
}

const sessionId = await readSessionId();
try {
  // One-time move of an earlier install's sign-in state into ~/.noblecloak/claude-plugin.
  const { message } = migrateLegacyState();
  if (message) {
    console.error(message);
    visible.push(message);
  }
} catch (err) {
  console.error(`NobleCloak: state migration failed — ${err.message}`);
}
const auth = loadAuthState();
if (!auth) {
  // Not logged in. The MCP connection is Claude Code's native OAuth (the
  // committed .mcp.json), but the governance hooks need auth.json — surface a
  // one-line call to action to Claude's context instead of a silent no-op.
  // (Never logged in is not a refresh failure: this stays out of the user's
  // face for plugin users who don't use governance.)
  context.push('NobleCloak: governance not active — run /noblecloak-login (one click if you are already signed in).');
  // A fully automatic browser login is intentionally NOT performed from this
  // SessionStart hook: it would block session start and exceed the 15s hook
  // timeout. NOBLECLOAK_AUTO_LOGIN=1 only escalates the reminder to a
  // user-visible message — it does not log in for you.
  if (process.env.NOBLECLOAK_AUTO_LOGIN === '1') {
    console.error(
      'NobleCloak: NOBLECLOAK_AUTO_LOGIN=1 set — automatic login is not performed at session start; run /noblecloak-login.'
    );
    visible.push('NobleCloak: governance not active — run /noblecloak-login.');
  }
  finish();
}

// Gateway token (top-level auth.json fields — what the governance hooks use).
// A signed-out marker always re-tries here (one grant per session start),
// regardless of the hooks' re-check interval.
let showedSignedOut = false;
if (readSignedOut() || Date.now() > auth.expiresAt - BUFFER_MS) {
  if (!auth.refreshToken) {
    if (isTokenExpired(auth)) {
      console.error('NobleCloak: Token expired and no refresh token available. Run /noblecloak-login to re-authenticate.');
      writeSignedOut('token expired and no refresh token', process.env, { credentialFp: credentialFingerprint(auth) });
    } else {
      // Inside the refresh buffer but still valid (the hooks' own 30s-skew
      // check agrees): keep using it, never mark it signed out early. Soft,
      // visible heads-up so the user can re-login before it lapses.
      const at = new Date(auth.expiresAt).toISOString();
      console.error(`NobleCloak: Token expires at ${at} and no refresh token is available. Run /noblecloak-login to renew it.`);
      if (!readSignedOut()) {
        visible.push(
          `NobleCloak: your governance sign-in expires at ${at} and can't be renewed automatically. ` +
            'Run /noblecloak-login to renew it.'
        );
      }
    }
  } else {
    try {
      await refreshAuthState(process.env, { deadline: scriptDeadline });
      clearSignedOut();
      context.push('NobleCloak: Token refreshed.');
    } catch (err) {
      reportRefreshFailure(err, 'Run /noblecloak-login to re-authenticate.');
      if (isRejectedRefresh(err)) {
        writeSignedOut(err.message, process.env, { credentialFp: err.credentialFp });
      } else if (!readSignedOut()) {
        // Transient (5xx / network / discovery): softer, still visible. The
        // expired token is not sent; the hooks retry the refresh on the next call.
        visible.push(
          `NobleCloak: couldn't refresh your governance sign-in right now (${err.message}). ` +
            'It will retry on the next tool call; if this keeps happening, run /noblecloak-status.'
        );
      }
    }
  }
  const marker = readSignedOut();
  if (marker) {
    visible.push(signedOutMessage(marker));
    showedSignedOut = true;
  }
}

// Per-resource tokens (auth.json `tokens`, e.g. the govern token from
// /noblecloak-propose-tool). Each is refreshed on its own; a failure of one never
// blocks the others, and the fix for a rejected grant is to re-run the command
// that signs in to that resource (it re-consents), not /noblecloak-login.
for (const [resource, entry] of Object.entries(auth.tokens ?? {})) {
  if (!(Date.now() > entry.expiresAt - BUFFER_MS)) continue;
  if (!entry.refreshToken) {
    console.error(`NobleCloak: ${resource} token expired and no refresh token available; re-run /noblecloak-propose-tool to sign in again.`);
    visible.push(`NobleCloak: your ${resource} sign-in expired; re-run /noblecloak-propose-tool to sign in again.`);
    continue;
  }
  try {
    await refreshTokenFor(resource, process.env, { deadline: scriptDeadline });
    context.push(`NobleCloak: Token refreshed (${resource}).`);
  } catch (err) {
    reportRefreshFailure(err, 'Re-run /noblecloak-propose-tool to sign in again.');
    visible.push(
      isRejectedRefresh(err)
        ? `NobleCloak: your ${resource} sign-in was rejected (${err.message}); re-run /noblecloak-propose-tool to sign in again.`
        : `NobleCloak: couldn't refresh your ${resource} sign-in right now (${err.message}); it will retry next session.`
    );
  }
}

// Notices queued by the detached audit worker (breaker open, run/org mismatch
// for a resumed session) — shown once per session. The signed-out notice is
// marked shown first when this script already printed it.
if (showedSignedOut) markNoticeShown('signed-out', sessionId);
visible.push(...takeNotices(sessionId));

finish();
