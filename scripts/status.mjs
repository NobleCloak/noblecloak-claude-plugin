#!/usr/bin/env node
/**
 * Print NobleCloak connection status.
 *
 * Beyond token validity, this reports the two facts that diagnose the
 * "Tool 'X' not found in catalog" dead-end:
 *   1. WHO/WHERE — the org the governance-hooks token is bound to. Every
 *      gateway tool call resolves against the bound org's catalog, and the
 *      org is chosen on the consent page at login.
 *   2. Catalog health — one authenticated tools/list against the gateway:
 *      "Catalog: N tools visible". N=0 means every dispatch WILL fail; the
 *      remediation is printed inline.
 *
 * Two-token seam: this script can only see the plugin's own auth.json token
 * (the governance hooks' custodian). Claude Code's native MCP OAuth holds a
 * SEPARATE token for the live gateway session — each token binds the org picked on its own
 * consent page, so the bindings normally agree, but only the gateway can say authoritatively
 * (a gateway-side introspection ask). The output labels the org as the HOOKS
 * token's binding for exactly this reason.
 *
 * Local governance/audit state (always printed, logged in or not): sign-in
 * state (signed out since/why, from <state dir>/signed-out.json), token expiry, the
 * current token's org vs the org bound to this session's audit run (when
 * known — CLAUDE_CODE_SESSION_ID selects the session), the audit breaker, the
 * queue/spill sizes, unshipped records dropped by the queue caps, and records
 * COO refused permanently (dead letters).
 */

import {
  AUDIT_DEAD_LETTER_RETENTION,
  cooBaseUrl,
  isEnforceMode,
  issuerBaseUrl,
  loadAuthState,
  loadMcpConfig,
  readAuthFile,
  localAuditStatus,
  migrateLegacyState,
  readMigrationMarker,
  stateDir,
  probeCatalog,
  tokenIdentity,
} from './lib/governance.mjs';

function kb(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The local governance + audit section; printed on every exit path. */
function printLocalAudit() {
  const st = localAuditStatus(process.env, { sessionId: process.env.CLAUDE_CODE_SESSION_ID || null });
  console.log('\nLocal governance + audit:');
  if (st.signedOut) {
    const since = st.signedOut.since ? ` since ${st.signedOut.since}` : '';
    const reason = st.signedOut.reason ? ` — ${st.signedOut.reason}` : '';
    console.log(`  Sign-in: SIGNED OUT${since}${reason}`);
    console.log('    The hooks make no COO calls (no policy checks, no audit delivery). Run /noblecloak-login.');
  } else {
    console.log(`  Sign-in: ${st.loggedIn ? 'signed in' : 'not logged in'}`);
  }
  if (st.tokenExpiresAt) {
    console.log(`  Token expires: ${st.tokenExpiresAt}${st.tokenExpired ? ' (EXPIRED)' : ''}`);
  }
  console.log(`  Current org (hooks token): ${st.currentOrgId ?? 'unknown'}`);
  if (st.session) {
    const runOrg = st.session.orgId ?? 'unknown';
    console.log(`  This session's audit run org: ${runOrg}${st.session.rejected ? ' — REFUSED for the current org' : ''}`);
  }
  if (st.rejectedRuns.length > 0) {
    const latest = st.rejectedRuns[st.rejectedRuns.length - 1];
    console.log(
      `  Audit runs refused by COO (tenant_run_mismatch): ${st.rejectedRuns.length} session(s); latest ${latest.sessionId}` +
        ` at ${latest.at} (signed in to ${latest.orgId ?? 'unknown'}${latest.runOrgId ? `, run belongs to ${latest.runOrgId}` : ''})` +
        (latest.retryAt ? `; retried once after ${latest.retryAt}` : '')
    );
    console.log(
      '    Those sessions\' audit runs belong to a different org than your sign-in. Start a new Claude Code' +
        ' session (or sign back in to the original org) to resume audit delivery.'
    );
  }
  const b = st.breaker;
  console.log(
    `  Audit breaker: ${b.phase}${b.phase === 'closed' ? '' : ` (${b.failures} consecutive failures; opened ${b.openedAt}, next probe after ${b.retryAt})`}`
  );
  console.log(`  Audit queue: ${st.queue.records} records, ${kb(st.queue.bytes)}; spill: ${st.spill.records} records, ${kb(st.spill.bytes)}`);
  const d = st.unshippedDropped;
  console.log(
    `  Unshipped records dropped (NOT delivered): ${d.total ?? 0}` +
      (d.total ? ` — last ${d.last} at ${d.lastAt} (by age ${d.byAge ?? 0}, by count ${d.byCount ?? 0})` : '')
  );
  const dl = st.deadLettered;
  console.log(
    `  Refused by COO permanently (dead letters): ${dl.total ?? 0}` +
      (dl.total ? ` — last at ${dl.lastAt}${dl.lastCode ? ` (${dl.lastCode})` : ''}` : '')
  );
  if (dl.trimmed) {
    console.log(
      `    ${dl.trimmed} of them trimmed from the local forensic tail ${stateDir()}/audit-dead.jsonl (only the newest ${AUDIT_DEAD_LETTER_RETENTION} are kept)` +
        (dl.lastTrimmedAt ? `; last trim ${dl.lastTrimmedAt}` : '')
    );
  }
}

let migrationMessage = null;
try {
  const migration = migrateLegacyState();
  migrationMessage = migration.message ?? migration.detail ?? null;
} catch (err) {
  migrationMessage = `NobleCloak: state migration failed — ${err.message}`;
}
const auth = loadAuthState();
const mcp = loadMcpConfig();

console.log(`State directory: ${stateDir()}`);
if (migrationMessage) console.log(migrationMessage);
const migratedFrom = readMigrationMarker();
if (migratedFrom && !migrationMessage) console.log(`State migrated from ${migratedFrom.source} (${migratedFrom.at ?? 'unknown time'}).`);
console.log(`Issuer: ${issuerBaseUrl()} (discovery: /.well-known/oauth-authorization-server)`);
console.log(`Governance: COO ${cooBaseUrl()} — ${isEnforceMode() ? 'ENFORCE' : 'audit-only'} mode`);

if (!auth) {
  console.log('Status: Not connected');
  // loadAuthState ignores a sign-in made against another deployment; say so.
  const saved = readAuthFile();
  if (saved) {
    console.log(
      `The saved sign-in belongs to ${saved.issuer ?? 'another deployment (saved by plugin 0.1.x)'}, not ${issuerBaseUrl()}; it is not used.`
    );
  }
  console.log('Run /noblecloak-login to connect your NobleCloak workspace.');
  printLocalAudit();
  process.exit(0);
}

const isExpired = Date.now() > auth.expiresAt;
const expiresIn = Math.max(0, Math.round((auth.expiresAt - Date.now()) / 60000));
// The committed .mcp.json declares the gateway; Claude Code owns the live MCP
// connection via native OAuth. Report the configured gateway URL, not a
// "connected" claim this script can't actually verify.
const gateway = mcp?.mcpServers?.noblecloak?.url ?? 'not configured';

console.log(`Status: ${isExpired ? 'Token expired' : 'Connected'}`);
console.log(`Authenticated: ${auth.authenticatedAt}`);

const identity = tokenIdentity(auth);
if (identity?.sub) {
  console.log(`Signed in as: ${identity.sub}`);
}
if (identity?.orgId) {
  console.log(`Organization (hooks token): ${identity.orgId}`);
  console.log(
    "  All NobleCloak gateway tool calls resolve against this org's catalog. Claude Code's"
  );
  console.log(
    '  native MCP session holds its own token (it binds the org picked on its own consent page — normally the same org).'
  );
} else {
  console.log('Organization (hooks token): UNKNOWN — token carries no org_id claim.');
}

console.log(`Token (governance hooks): ${isExpired ? 'EXPIRED' : `valid for ${expiresIn} minutes`}`);
console.log(`MCP gateway: ${gateway}`);
console.log('MCP connection: managed by Claude Code (native OAuth) — see /mcp for live status.');

if (isExpired) {
  console.log('Catalog: skipped (token expired).');
  console.log('\nRun /noblecloak-login to re-authenticate.');
  printLocalAudit();
  process.exit(0);
}

// ── Catalog health probe ─────────────────────────────
const probe = await probeCatalog(auth.accessToken);
if (probe.ok) {
  console.log(`Catalog: ${probe.count} tools visible to this session.`);
  if (probe.count === 0) {
    console.log(
      "  ⚠ Your session's org has NO cataloged tools — every tool call will fail with"
    );
    console.log(
      '  "not found in catalog". Connect an MCP service in THIS org (or switch your default'
    );
    console.log('  org and re-run /noblecloak-login), then reconnect the MCP server via /mcp.');
  }
} else if (probe.reason === 'no_gateway') {
  console.log('Catalog: skipped (no MCP gateway configured in .mcp.json).');
} else {
  console.log(`Catalog: probe failed (${probe.reason}${probe.detail ? ` — ${probe.detail}` : ''}).`);
  console.log('  The gateway may be unreachable, or the token may not be accepted. If tool calls');
  console.log('  also fail, run /noblecloak-login and reconnect the MCP server via /mcp.');
}

printLocalAudit();
