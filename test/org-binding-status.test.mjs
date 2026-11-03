/**
 * Tests for org binding surfacing + catalog health probe.
 *
 * Covers the new lib helpers (decodeJwtClaims, tokenIdentity, gatewayUrl,
 * probeCatalog) and the status script's diagnosis output end-to-end against a
 * local stub gateway.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUDIT_DEAD_LETTER_RETENTION,
  compactAuditQueueAndLedger,
  decodeJwtClaims,
  gatewayUrl,
  localAuditStatus,
  readAuditHealth,
  recordDeadLetter,
  probeCatalog,
  resolveResourceIndicator,
  tokenIdentity,
} from '../scripts/lib/governance.mjs';
import { REPO_ROOT } from './helpers.mjs';

const STATUS_PATH = join(REPO_ROOT, 'scripts', 'status.mjs');

function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const ORG = '729d0339-6b36-4881-8aea-f0273a5d4d5d';
const SUB = 'a3df103b-3668-4ec5-9c85-8e1281f6cd3d';

// ── decodeJwtClaims ───────────────────────────────────────────────────────

test('decodeJwtClaims decodes a well-formed payload', () => {
  const claims = decodeJwtClaims(makeJwt({ sub: SUB, org_id: ORG, scope: 'mcp' }));
  assert.equal(claims.sub, SUB);
  assert.equal(claims.org_id, ORG);
});

test('decodeJwtClaims returns null on malformed input (never throws)', () => {
  assert.equal(decodeJwtClaims(null), null);
  assert.equal(decodeJwtClaims(''), null);
  assert.equal(decodeJwtClaims('not-a-jwt'), null);
  assert.equal(decodeJwtClaims('a.%%%%.c'), null);
  assert.equal(decodeJwtClaims(`x.${Buffer.from('[1,2]').toString('base64url')}.y`), null);
});

// ── tokenIdentity ─────────────────────────────────────────────────────────

test('tokenIdentity falls back to persisted orgId/sub when the token is opaque', () => {
  const identity = tokenIdentity({ accessToken: 'garbage', orgId: ORG, sub: SUB });
  assert.deepEqual(identity, { sub: SUB, orgId: ORG });
});

test('tokenIdentity prefers the LIVE token claims over stale persisted fields (refresh drift)', () => {
  // refreshAuthState preserves login-time orgId/sub while re-minting the
  // token — if the re-mint landed on a different org, the live token is the
  // truth and the display must follow it.
  const freshOrg = '47aca786-97d6-46d9-aada-c19549ca083e';
  const identity = tokenIdentity({
    accessToken: makeJwt({ sub: SUB, org_id: freshOrg }),
    orgId: ORG, // stale login-time binding
    sub: SUB,
  });
  assert.equal(identity.orgId, freshOrg);
});

test('tokenIdentity falls back to decoding the access token (pre-org-binding auth.json)', () => {
  const identity = tokenIdentity({ accessToken: makeJwt({ sub: SUB, org_id: ORG }) });
  assert.deepEqual(identity, { sub: SUB, orgId: ORG });
});

test('tokenIdentity returns null when nothing is derivable', () => {
  assert.equal(tokenIdentity(null), null);
  assert.equal(tokenIdentity({ accessToken: 'garbage' }), null);
});

// ── gatewayUrl + probeCatalog ─────────────────────────────────────────────

function withMcpFile(url) {
  const dir = mkdtempSync(join(tmpdir(), 'bn-probe-'));
  const file = join(dir, '.mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { noblecloak: { type: 'http', url } } }));
  return { NOBLECLOAK_MCP_FILE: file };
}

function startGateway(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1/mcp` });
    });
  });
}

test('probeCatalog returns no_gateway when .mcp.json is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bn-probe-empty-'));
  const env = { NOBLECLOAK_MCP_FILE: join(dir, 'missing.json') };
  assert.equal(gatewayUrl(env), null);
  const result = await probeCatalog('tok', env);
  assert.deepEqual(result, { ok: false, reason: 'no_gateway' });
});

test('probeCatalog counts tools from a plain-JSON tools/list result', async () => {
  const { server, url } = await startGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'catalog-probe',
        result: { tools: [{ name: 'noblecloak.search' }, { name: 'noblecloak.read' }] },
      })
    );
  });
  try {
    const result = await probeCatalog('tok', withMcpFile(url));
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    assert.deepEqual(result.names, ['noblecloak.search', 'noblecloak.read']);
  } finally {
    server.close();
  }
});

test('probeCatalog parses an SSE-framed tools/list result', async () => {
  const { server, url } = await startGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: 'catalog-probe',
        result: { tools: [{ name: 'noblecloak.act' }] },
      })}\n\n`
    );
  });
  try {
    const result = await probeCatalog('tok', withMcpFile(url));
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
  } finally {
    server.close();
  }
});

test('probeCatalog surfaces HTTP failures as http_<status>', async () => {
  const { server, url } = await startGateway((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'invalid_token' } }));
  });
  try {
    const result = await probeCatalog('tok', withMcpFile(url));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'http_401');
  } finally {
    server.close();
  }
});

test('probeCatalog surfaces a JSON-RPC error body as bad_response', async () => {
  const { server, url } = await startGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'catalog-probe', error: { code: -32000 } }));
  });
  try {
    const result = await probeCatalog('tok', withMcpFile(url));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_response');
  } finally {
    server.close();
  }
});

test('probeCatalog labels a reachable-but-non-JSON 200 as bad_response, NOT network', async () => {
  // A misrouted shared-ALB HTML error page is a known failure class — the
  // gateway RESPONDED, so the "may be unreachable" remediation must not fire.
  const { server, url } = await startGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>ALB default backend</body></html>');
  });
  try {
    const result = await probeCatalog('tok', withMcpFile(url));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_response');
  } finally {
    server.close();
  }
});

test('probeCatalog picks the catalog-probe event out of a multi-event SSE stream', async () => {
  // Streamable-HTTP servers may emit notifications before the response.
  const { server, url } = await startGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      [
        `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })}`,
        '',
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 'catalog-probe', result: { tools: [{ name: 'x' }, { name: 'y' }] } })}`,
        '',
      ].join('\n')
    );
  });
  try {
    const result = await probeCatalog('tok', withMcpFile(url));
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
  } finally {
    server.close();
  }
});

test('probeCatalog surfaces network failure without throwing', async () => {
  const result = await probeCatalog('tok', withMcpFile('http://127.0.0.1:1/v1/mcp'), {
    timeoutMs: 1500,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
});

test('probeCatalog sends the bearer token and both Accept types', async () => {
  let seen;
  const { server, url } = await startGateway((req, res) => {
    seen = { auth: req.headers.authorization, accept: req.headers.accept };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'catalog-probe', result: { tools: [] } }));
  });
  try {
    await probeCatalog('secret-token', withMcpFile(url));
    assert.equal(seen.auth, 'Bearer secret-token');
    assert.ok(seen.accept.includes('application/json'));
    assert.ok(seen.accept.includes('text/event-stream'));
  } finally {
    server.close();
  }
});

// ── status.mjs end-to-end ─────────────────────────────────────────────────

function runStatus(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STATUS_PATH], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function makeStateDir(authState) {
  const dir = mkdtempSync(join(tmpdir(), 'bn-status-'));
  mkdirSync(dir, { recursive: true });
  if (authState) writeFileSync(join(dir, 'auth.json'), JSON.stringify(authState));
  return dir;
}

test('status prints org binding + catalog count (healthy path)', async () => {
  const { server, url } = await startGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'catalog-probe',
        result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      })
    );
  });
  try {
    const stateDir = makeStateDir({
      accessToken: makeJwt({ sub: SUB, org_id: ORG }),
      refreshToken: 'r',
      expiresAt: Date.now() + 600_000,
      authenticatedAt: new Date().toISOString(),
      orgId: ORG,
      sub: SUB,
    });
    const { code, stdout } = await runStatus({
      NOBLECLOAK_STATE_DIR: stateDir,
      ...withMcpFile(url),
    });
    assert.equal(code, 0);
    assert.match(stdout, new RegExp(`Signed in as: ${SUB}`));
    assert.match(stdout, new RegExp(`Organization \\(hooks token\\): ${ORG}`));
    assert.match(stdout, /Catalog: 3 tools visible to this session\./);
    assert.doesNotMatch(stdout, /NO cataloged tools/);
  } finally {
    server.close();
  }
});

test('status prints the 0-tools remediation (the org-mismatch dead-end, diagnosed)', async () => {
  const { server, url } = await startGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'catalog-probe', result: { tools: [] } }));
  });
  try {
    const stateDir = makeStateDir({
      accessToken: makeJwt({ sub: SUB, org_id: ORG }),
      refreshToken: 'r',
      expiresAt: Date.now() + 600_000,
      authenticatedAt: new Date().toISOString(),
      orgId: ORG,
      sub: SUB,
    });
    const { code, stdout } = await runStatus({
      NOBLECLOAK_STATE_DIR: stateDir,
      ...withMcpFile(url),
    });
    assert.equal(code, 0);
    assert.match(stdout, /Catalog: 0 tools visible/);
    assert.match(stdout, /NO cataloged tools/);
    assert.match(stdout, /not found in catalog/);
    assert.match(stdout, /switch your default/);
  } finally {
    server.close();
  }
});

test('status skips the probe on an expired token', async () => {
  const stateDir = makeStateDir({
    accessToken: makeJwt({ sub: SUB, org_id: ORG }),
    refreshToken: 'r',
    expiresAt: Date.now() - 1000,
    authenticatedAt: new Date().toISOString(),
    orgId: ORG,
    sub: SUB,
  });
  const { code, stdout } = await runStatus({
    NOBLECLOAK_STATE_DIR: stateDir,
    ...withMcpFile('http://127.0.0.1:1/v1/mcp'),
  });
  assert.equal(code, 0);
  assert.match(stdout, /Catalog: skipped \(token expired\)\./);
  assert.match(stdout, /noblecloak-login/);
});

test('status reports UNKNOWN org for a pre-org-binding token with no org_id claim', async () => {
  const { server, url } = await startGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'catalog-probe', result: { tools: [] } }));
  });
  try {
    const stateDir = makeStateDir({
      accessToken: makeJwt({ sub: SUB }),
      refreshToken: 'r',
      expiresAt: Date.now() + 600_000,
      authenticatedAt: new Date().toISOString(),
    });
    const { code, stdout } = await runStatus({
      NOBLECLOAK_STATE_DIR: stateDir,
      ...withMcpFile(url),
    });
    assert.equal(code, 0);
    assert.match(stdout, /Organization \(hooks token\): UNKNOWN/);
  } finally {
    server.close();
  }
});

test('status reports a failed probe without crashing', async () => {
  const stateDir = makeStateDir({
    accessToken: makeJwt({ sub: SUB, org_id: ORG }),
    refreshToken: 'r',
    expiresAt: Date.now() + 600_000,
    authenticatedAt: new Date().toISOString(),
    orgId: ORG,
  });
  const { code, stdout } = await runStatus({
    NOBLECLOAK_STATE_DIR: stateDir,
    ...withMcpFile('http://127.0.0.1:1/v1/mcp'),
  });
  assert.equal(code, 0);
  assert.match(stdout, /Catalog: probe failed \(network/);
});

// ── local governance + audit state in /noblecloak-status (2026-10-20) ────────

const OLD_ORG = 'ba20a002-0000-0000-0000-000000000000';
const SESSION = 'sess-0000-1111';

/** A state dir with every new piece of state populated. */
function seedEverything({ expired = true } = {}) {
  const dir = makeStateDir({
    accessToken: makeJwt({ sub: SUB, org_id: ORG }),
    refreshToken: 'r',
    expiresAt: expired ? Date.UTC(2026, 7, 18) : Date.now() + 600_000,
    authenticatedAt: '2026-08-18T00:00:00.000Z',
    orgId: ORG,
  });
  writeFileSync(join(dir, 'signed-out.json'), JSON.stringify({ since: '2026-08-18T01:00:00.000Z', reason: 'Token refresh failed (400: invalid_grant)', checkedAt: Date.now() }));
  writeFileSync(join(dir, 'audit-runs.json'), JSON.stringify({ [SESSION]: { orgId: OLD_ORG, deliveredAt: '2026-08-01T00:00:00.000Z', rejected: { at: '2026-10-20T10:00:00.000Z', orgId: ORG, code: 'tenant_run_mismatch' } } }));
  writeFileSync(join(dir, 'audit-breaker.json'), JSON.stringify({ failures: 5, openedAt: Date.now() }));
  writeFileSync(join(dir, 'audit-queue.jsonl'), '{"a":1}\n{"b":2}\n{"c":3}\n');
  writeFileSync(join(dir, 'audit-spill.jsonl'), '{"x":1}\n');
  writeFileSync(join(dir, 'audit-health.json'), JSON.stringify({
    unshippedDropped: { total: 1234, byAge: 1200, byCount: 34, last: 34, lastAt: '2026-10-20T11:00:00.000Z' },
    deadLettered: { total: 77, lastAt: '2026-10-20T10:05:00.000Z', lastCode: 'tenant_run_mismatch' },
  }));
  return dir;
}

test('localAuditStatus reports every new field', () => {
  const dir = seedEverything();
  const st = localAuditStatus({ NOBLECLOAK_STATE_DIR: dir }, { sessionId: SESSION });
  assert.equal(st.signedIn, false);
  assert.equal(st.signedOut.since, '2026-08-18T01:00:00.000Z');
  assert.match(st.signedOut.reason, /invalid_grant/);
  assert.equal(st.tokenExpiresAt, '2026-08-18T00:00:00.000Z');
  assert.equal(st.tokenExpired, true);
  assert.equal(st.currentOrgId, ORG);
  assert.equal(st.session.orgId, OLD_ORG);
  assert.equal(st.session.rejected.code, 'tenant_run_mismatch');
  assert.equal(st.rejectedRuns.length, 1);
  assert.equal(st.rejectedRuns[0].retryAt, '2026-10-20T11:00:00.000Z', 'rejection at + AUDIT_RUN_REJECTION_TTL_MS');
  assert.equal(st.breaker.phase, 'open');
  assert.equal(st.breaker.failures, 5);
  assert.deepEqual(st.queue, { records: 3, bytes: 24 });
  assert.equal(st.spill.records, 1);
  assert.equal(st.unshippedDropped.total, 1234);
  assert.equal(st.deadLettered.total, 77);
});

test('status prints the local governance + audit section with each new field', async () => {
  const dir = seedEverything();
  const { code, stdout } = await runStatus({
    NOBLECLOAK_STATE_DIR: dir,
    CLAUDE_CODE_SESSION_ID: SESSION,
    ...withMcpFile('http://127.0.0.1:1/v1/mcp'),
  });
  assert.equal(code, 0);
  assert.match(stdout, /Sign-in: SIGNED OUT since 2026-08-18T01:00:00\.000Z — Token refresh failed \(400: invalid_grant\)/);
  assert.match(stdout, /noblecloak-login/);
  assert.match(stdout, /Token expires: 2026-08-18T00:00:00\.000Z \(EXPIRED\)/);
  assert.match(stdout, new RegExp(`Current org \\(hooks token\\): ${ORG}`));
  assert.match(stdout, new RegExp(`This session's audit run org: ${OLD_ORG} — REFUSED for the current org`));
  assert.match(stdout, /Audit runs refused by COO \(tenant_run_mismatch\): 1 session/);
  assert.match(stdout, /retried once after 2026-10-20T11:00:00\.000Z/);
  assert.match(stdout, /start a new Claude Code session/i);
  assert.match(stdout, /Audit breaker: open \(5 consecutive failures/);
  assert.match(stdout, /Audit queue: 3 records, 24 B; spill: 1 records/);
  assert.match(stdout, /Unshipped records dropped \(NOT delivered\): 1234 — last 34 at 2026-10-20T11:00:00\.000Z/);
  assert.match(stdout, /Refused by COO permanently \(dead letters\): 77/);
});

test('status prints the local section even when not connected (healthy defaults)', async () => {
  const dir = makeStateDir(null);
  const { code, stdout } = await runStatus({ NOBLECLOAK_STATE_DIR: dir, CLAUDE_CODE_SESSION_ID: '', ...withMcpFile('http://127.0.0.1:1/v1/mcp') });
  assert.equal(code, 0);
  assert.match(stdout, /Status: Not connected/);
  assert.match(stdout, /Sign-in: not logged in/);
  assert.match(stdout, /Audit breaker: closed/);
  assert.match(stdout, /Audit queue: 0 records, 0 B/);
  assert.match(stdout, /Unshipped records dropped \(NOT delivered\): 0/);
  assert.match(stdout, /dead letters\): 0/);
});

test('dead-letter tail trim is COUNTED (deadLettered.trimmed) and shown by status; the total survives', async () => {
  const dir = makeStateDir(null);
  const e = { NOBLECLOAK_STATE_DIR: dir };
  const n = AUDIT_DEAD_LETTER_RETENTION + 44;
  for (let i = 0; i < n; i += 1) recordDeadLetter({ id: `d${i}:pre`, subject: 's' }, 403, 'tenant_run_mismatch', e);
  compactAuditQueueAndLedger(e); // no queue file → the stale-tail path still bounds and counts
  const lines = readFileSync(join(dir, 'audit-dead.jsonl'), 'utf-8').split('\n').filter(Boolean);
  assert.equal(lines.length, AUDIT_DEAD_LETTER_RETENTION);
  let h = readAuditHealth(e);
  assert.equal(h.deadLettered.trimmed, 44);
  assert.equal(h.deadLettered.total, n, 'total still counts every dead letter');

  // A later dead letter keeps the trim counter (recordDeadLetter merges); a second trim adds to it.
  recordDeadLetter({ id: 'late:pre', subject: 's' }, 403, 'tenant_run_mismatch', e);
  assert.equal(readAuditHealth(e).deadLettered.trimmed, 44);
  writeFileSync(join(dir, 'audit-queue.jsonl'), ''); // the locked path bounds it too
  compactAuditQueueAndLedger(e);
  h = readAuditHealth(e);
  assert.equal(h.deadLettered.trimmed, 45);
  assert.equal(localAuditStatus(e).deadLettered.trimmed, 45);

  const { code, stdout } = await runStatus({ NOBLECLOAK_STATE_DIR: dir, CLAUDE_CODE_SESSION_ID: '', ...withMcpFile('http://127.0.0.1:1/v1/mcp') });
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`dead letters\\): ${n + 1}`));
  assert.match(stdout, new RegExp(`45 of them trimmed from the local forensic tail .*newest ${AUDIT_DEAD_LETTER_RETENTION}`));
});

// ── .mcp.json server key ──────────────────────────────────────────────────

test('gatewayUrl and resolveResourceIndicator read the `noblecloak` server key only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nc-key-'));
  const current = join(dir, 'current.json');
  const other = join(dir, 'other.json');
  writeFileSync(current, JSON.stringify({ mcpServers: { noblecloak: { type: 'http', url: 'https://mcp.example.test/v1/mcp' } } }));
  writeFileSync(other, JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://mcp.example.test/v1/mcp' } } }));
  assert.equal(gatewayUrl({ NOBLECLOAK_MCP_FILE: current }), 'https://mcp.example.test/v1/mcp');
  assert.equal(resolveResourceIndicator({ NOBLECLOAK_MCP_FILE: current }), 'https://mcp.example.test');
  assert.equal(gatewayUrl({ NOBLECLOAK_MCP_FILE: other }), null);
  assert.equal(resolveResourceIndicator({ NOBLECLOAK_MCP_FILE: other }), null);
});

test('status reports the gateway URL from the `noblecloak` key, and "not configured" for any other key', async () => {
  const stateDir = makeStateDir({
    accessToken: makeJwt({ sub: SUB, org_id: ORG }),
    refreshToken: 'r',
    expiresAt: Date.now() - 1000, // expired: skips the network probe, still prints the gateway line
    authenticatedAt: new Date().toISOString(),
    orgId: ORG,
    sub: SUB,
  });
  const ok = await runStatus({ NOBLECLOAK_STATE_DIR: stateDir, ...withMcpFile('https://mcp.example.test/v1/mcp') });
  assert.match(ok.stdout, /MCP gateway: https:\/\/mcp\.example\.test\/v1\/mcp/);
  const dir = mkdtempSync(join(tmpdir(), 'nc-key-'));
  const otherFile = join(dir, '.mcp.json');
  writeFileSync(otherFile, JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://mcp.example.test/v1/mcp' } } }));
  const missing = await runStatus({ NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_MCP_FILE: otherFile });
  assert.match(missing.stdout, /MCP gateway: not configured/);
});
