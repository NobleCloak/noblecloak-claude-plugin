/**
 * Integration tests for scripts/hooks/pre-tool-use.mjs — runs the hook as a
 * child process against a local stub COO/auth server (spike pattern).
 * Covers the brief's D7 matrix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  decisionOf,
  hookInput,
  makeStateDir,
  readAuditRecords,
  runHook,
  startStub,
  stubEnv,
} from './helpers.mjs';

function resolveResponse(mode, extra = {}) {
  return {
    status: 200,
    body: { mode, source: 'default_side_effect', side_effect_level: 'read', ...extra },
  };
}

// COO returns the resolution wrapped in a { data, meta } envelope (the real
// server shape — see GET /mcp/config which the stub already envelopes). The
// policy fields live under .data; the hook must unwrap it.
function resolveEnvelopeResponse(mode, extra = {}) {
  return {
    status: 200,
    body: {
      data: { mode, source: 'default_side_effect', side_effect_level: 'read', ...extra },
      meta: { requestId: 'test-req', computedAt: '2026-06-24T00:00:00.000Z' },
    },
  };
}

// ── decision mapping (enforce) ──────────────────────────────────────────────

test('enforce: always_allow → allow, ask → ask, deny → deny', async (t) => {
  for (const [mode, expected] of [
    ['always_allow', 'allow'],
    ['ask', 'ask'],
    ['deny', 'deny'],
  ]) {
    await t.test(`${mode} → ${expected}`, async () => {
      const stub = await startStub();
      const stateDir = makeStateDir();
      stub.resolveResponses = [resolveResponse(mode)];
      const result = await runHook(
        hookInput({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
        stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
      );
      await stub.close();
      assert.equal(result.code, 0);
      assert.equal(decisionOf(result), expected);
      const [record] = readAuditRecords(stateDir);
      assert.equal(record.decision, expected);
      assert.equal(record.would_decision, expected);
      assert.equal(record.enforce, true);
      assert.equal(record.resolve.mode, mode);
    });
  }
});

test('enforce: server-side headless degradation reason is surfaced', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [
    resolveResponse('deny', {
      headless_degraded: true,
      reason: 'ask-unresolvable-headless',
      undegraded_mode: 'ask',
    }),
  ];
  const result = await runHook(
    hookInput({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
  );
  await stub.close();
  assert.equal(decisionOf(result), 'deny');
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /ask-unresolvable-headless/);
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.resolve.undegraded_mode, 'ask');
});

// ── audit-only never blocks ─────────────────────────────────────────────────

test('audit-only: deny response still allows, would-be decision recorded', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [resolveResponse('deny', { side_effect_level: 'delete' })];
  const result = await runHook(
    hookInput({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    stubEnv(stub, stateDir) // NOBLECLOAK_LOCAL_ENFORCE unset → audit-only
  );
  await stub.close();
  assert.equal(decisionOf(result), 'allow');
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /audit-only/);
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.decision, 'allow');
  assert.equal(record.would_decision, 'deny');
  assert.equal(record.enforce, false);
});

test('resolve: unwraps COO { data, meta } envelope (not invalid-response-mode)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  // Real COO shape: mode/source/side_effect_level under .data, not top-level.
  stub.resolveResponses = [resolveEnvelopeResponse('deny', { side_effect_level: 'delete' })];
  const result = await runHook(
    hookInput({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  // deny must come from the real resolution, NOT a degraded fail-closed fallback.
  assert.equal(decisionOf(result), 'deny');
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, false); // bug: top-level mode undefined → 'invalid-response-mode' degraded
  assert.equal(record.resolve.mode, 'deny'); // unwrapped from .data
  // The pre-record's resolve.source feeds the PostToolUse event's decision.source;
  // it must be the real enum value COO's events endpoint accepts, not undefined.
  assert.equal(record.resolve.source, 'default_side_effect');
});

test('audit-only: ask response allows; explicit false enforces nothing', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [resolveResponse('ask')];
  const result = await runHook(
    hookInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/project/a.txt', old_string: 'x', new_string: 'y' } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'false' })
  );
  await stub.close();
  assert.equal(decisionOf(result), 'allow');
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.would_decision, 'ask');
});

// ── mcp__noblecloak exclusion (no double-enforcement) ─────────────────────────

test('mcp__noblecloak* → immediate allow, no resolve call, no audit record', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const result = await runHook(
    hookInput({ tool_name: 'mcp__noblecloak__coo_list_agents', tool_input: { q: 1 } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  assert.equal(decisionOf(result), 'allow');
  assert.equal(stub.resolveRequests().length, 0);
  assert.equal(readAuditRecords(stateDir).length, 0);
});

test('installed-plugin tool names (mcp__plugin_noblecloak_noblecloak__*) → immediate allow, no resolve, no audit', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const result = await runHook(
    hookInput({ tool_name: 'mcp__plugin_noblecloak_noblecloak__search_records', tool_input: { q: 1 } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  assert.equal(decisionOf(result), 'allow');
  assert.equal(stub.resolveRequests().length, 0);
  assert.equal(readAuditRecords(stateDir).length, 0);
});

test('lookalike server names (mcp__noblecloakfake__*) are NOT gateway-skipped — resolved and audited', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [resolveResponse('always_allow', { side_effect_level: 'write' })];
  await runHook(
    hookInput({ tool_name: 'mcp__noblecloakfake__x', tool_input: { q: 1 } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  assert.equal(stub.resolveRequests().length, 1, 'lookalike must be resolved, not skipped');
  assert.equal(readAuditRecords(stateDir).length, 1, 'lookalike must be audited');
});

test('gateway skip follows the server ids written to .mcp.json, not a name prefix', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const env = stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' });
  writeFileSync(
    env.NOBLECLOAK_MCP_FILE,
    JSON.stringify({ mcpServers: { 'noblecloak-coo': { url: stub.url, headers: {} } } })
  );
  // In the config → skipped (gateway-governed).
  const skipped = await runHook(hookInput({ tool_name: 'mcp__noblecloak-coo__dispatch', tool_input: {} }), env);
  assert.equal(decisionOf(skipped), 'allow');
  assert.equal(stub.resolveRequests().length, 0);
  // noblecloak-prefixed but NOT in the config → governed.
  await runHook(hookInput({ tool_name: 'mcp__noblecloak-unknown__x', tool_input: {} }), env);
  await stub.close();
  assert.equal(stub.resolveRequests().length, 1);
});

test('non-noblecloak mcp__ tools ARE resolved', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [resolveResponse('always_allow', { side_effect_level: 'write' })];
  const result = await runHook(
    hookInput({ tool_name: 'mcp__github__create_issue', tool_input: { title: 't' } }),
    stubEnv(stub, stateDir)
  );
  await stub.close();
  assert.equal(decisionOf(result), 'allow');
  assert.equal(stub.resolveRequests().length, 1);
  assert.equal(stub.resolveRequests()[0].body.tool_ref, 'mcp__github__create_issue');
});

// ── channel table (as sent to the server) ───────────────────────────────────

test('channel: cli + no agent_id → interactive; everything else headless', async (t) => {
  const cases = [
    [{ CLAUDE_CODE_ENTRYPOINT: 'cli' }, {}, 'interactive'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'cli' }, { agent_id: 'agt_1', agent_type: 'general' }, 'headless'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, {}, 'headless'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'mystery-host' }, {}, 'headless'],
    [{ CLAUDE_CODE_ENTRYPOINT: '' }, {}, 'headless'],
  ];
  for (const [envExtra, inputExtra, expected] of cases) {
    await t.test(`${envExtra.CLAUDE_CODE_ENTRYPOINT || '(unset)'} agent_id=${inputExtra.agent_id || 'absent'} → ${expected}`, async () => {
      const stub = await startStub();
      const stateDir = makeStateDir();
      await runHook(hookInput(inputExtra), stubEnv(stub, stateDir, envExtra));
      await stub.close();
      const [req] = stub.resolveRequests();
      assert.equal(req.body.bn_invocation_channel, expected);
      if (inputExtra.agent_id) {
        assert.equal(req.body.agent_id, inputExtra.agent_id);
        assert.equal(req.body.agent_type, inputExtra.agent_type);
      }
    });
  }
});

// ── 401 → refresh → retry-once ──────────────────────────────────────────────

function seedAuth(stateDir, { accessToken = 'stale-token', refreshToken = 'refresh-1' } = {}) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'auth.json'),
    JSON.stringify({
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3600_000,
      tokenType: 'Bearer',
      authenticatedAt: new Date().toISOString(),
    })
  );
}

test('401 → refresh via discovered token endpoint → retry once succeeds', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  seedAuth(stateDir);
  stub.resolveResponses = [
    { status: 401, body: { error: 'unauthorized' } },
    resolveResponse('always_allow'),
  ];
  const env = stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' });
  delete env.NOBLECLOAK_DEV_TOKEN; // use the auth-file path
  const result = await runHook(hookInput({ tool_name: 'Read' }), env);
  await stub.close();

  assert.equal(decisionOf(result), 'allow');
  const resolves = stub.resolveRequests();
  assert.equal(resolves.length, 2);
  assert.equal(resolves[0].headers.authorization, 'Bearer stale-token');
  assert.equal(resolves[1].headers.authorization, 'Bearer refreshed-token');
  // Discovery + token grant happened
  assert.ok(stub.requests.some((r) => r.path === '/.well-known/oauth-authorization-server'));
  const tokenReq = stub.requests.find((r) => r.path === '/auth/oauth/token');
  assert.ok(tokenReq);
  assert.match(tokenReq.rawBody, /grant_type=refresh_token/);
  // Auth state persisted
  const auth = JSON.parse((await import('node:fs')).readFileSync(join(stateDir, 'auth.json'), 'utf-8'));
  assert.equal(auth.accessToken, 'refreshed-token');
});

test('401 twice → retry only once, then fail-mode (enforce, write tool → deny)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  seedAuth(stateDir);
  stub.resolveResponses = [{ status: 401, body: {} }];
  const env = stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' });
  delete env.NOBLECLOAK_DEV_TOKEN;
  const result = await runHook(hookInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/project/a' } }), env);
  await stub.close();
  assert.equal(decisionOf(result), 'deny');
  assert.equal(stub.resolveRequests().length, 2);
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.equal(record.fail_mode, 'fail-closed');
});

test('401 → token endpoint 5xx → degraded refresh-failed, fail-closed for a write tool in enforce', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  seedAuth(stateDir);
  stub.resolveResponses = [{ status: 401, body: {} }];
  stub.tokenStatus = 500;
  const env = stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' });
  delete env.NOBLECLOAK_DEV_TOKEN;
  const result = await runHook(hookInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/a' } }), env);
  await stub.close();
  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'deny');
  assert.equal(stub.resolveRequests().length, 1, 'no retry after a failed refresh');
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.match(record.degraded_reason, /refresh-failed/);
  assert.equal(record.fail_mode, 'fail-closed');
});

test('401 → discovery doc without token_endpoint → refresh-failed with the Stage-4-pending message', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  seedAuth(stateDir);
  stub.resolveResponses = [{ status: 401, body: {} }];
  stub.discoveryDoc = { issuer: 'x', authorization_endpoint: 'y' }; // current production state
  const env = stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' });
  delete env.NOBLECLOAK_DEV_TOKEN;
  const result = await runHook(hookInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/a' } }), env);
  await stub.close();
  assert.equal(decisionOf(result), 'deny');
  const [record] = readAuditRecords(stateDir);
  assert.match(record.degraded_reason, /refresh-failed/);
  assert.match(record.degraded_reason, /Stage 4/);
});

test('401 with dev token (no refresh path) → fail-mode, no retry', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [{ status: 401, body: {} }];
  const result = await runHook(
    hookInput({ tool_name: 'Read' }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  assert.equal(decisionOf(result), 'allow'); // read → fail-open
  assert.equal(stub.resolveRequests().length, 1);
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.equal(record.fail_mode, 'read-fail-open');
});

test('401 → hung discovery: cumulative budget still emits a decision well under the hooks.json timeout', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  seedAuth(stateDir);
  stub.resolveResponses = [{ status: 401, body: {} }];
  stub.hangPaths = ['/.well-known/oauth-authorization-server'];
  const env = stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' }); // default timeouts on purpose
  delete env.NOBLECLOAK_DEV_TOKEN;
  const started = Date.now();
  const result = await runHook(hookInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/a' } }), env);
  const elapsed = Date.now() - started;
  await stub.close();
  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'deny', 'enforce fail-closed must be emitted, not lost to a host hook-timeout');
  assert.ok(elapsed < 4500, `hook took ${elapsed}ms — must stay under the 5s hooks.json timeout`);
  const [record] = readAuditRecords(stateDir);
  assert.match(record.degraded_reason, /refresh-failed/);
});

test('401 → refresh succeeds but the budget is spent before the retry → budget-exhausted (enforce write → deny)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  seedAuth(stateDir);
  // Attempt #1 → 401 drives a real discovery + token refresh (stub serves both
  // by default). The budget-clock seam reports +5s of elapsed wall-clock at the
  // SECOND checkpoint (after the refresh), pushing it past the 4s cumulative
  // deadline so the retry resolve never fires. This is the one deterministic
  // way to reach the 'budget-exhausted' guard — a real refresh always completes
  // before the deadline, so under real time the post-refresh budget is never 0.
  stub.resolveResponses = [{ status: 401, body: {} }];
  const env = stubEnv(stub, stateDir, {
    NOBLECLOAK_LOCAL_ENFORCE: 'true',
    NOBLECLOAK_TEST_BUDGET_NOW_OFFSETS: '0,5000',
  });
  delete env.NOBLECLOAK_DEV_TOKEN; // auth-file path so 401 → refresh actually runs
  const result = await runHook(hookInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/a' } }), env);
  await stub.close();

  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'deny', 'enforce write fail-closed on budget-exhausted');
  // The refresh genuinely happened; the retry resolve did not.
  assert.equal(stub.resolveRequests().length, 1, 'no retry resolve once the budget is spent');
  assert.ok(stub.requests.some((r) => r.path === '/auth/oauth/token'), 'refresh token grant fired');
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.equal(record.degraded_reason, 'budget-exhausted');
  assert.equal(record.fail_mode, 'fail-closed');
});

// ── timeout / unreachable fail-modes per side-effect class per mode ─────────

test('timeout fail-modes (enforce): read fail-open; write/external/delete fail-closed', async (t) => {
  const cases = [
    ['Read', { file_path: '/tmp/x' }, 'allow', 'read-fail-open'],
    ['Glob', { pattern: '*.ts' }, 'allow', 'read-fail-open'],
    ['Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }, 'deny', 'fail-closed'],
    ['WebFetch', { url: 'https://example.com' }, 'deny', 'fail-closed'],
    ['Bash', { command: 'echo hi' }, 'deny', 'fail-closed'],
    ['mcp__github__create_issue', { title: 't' }, 'deny', 'fail-closed'],
  ];
  for (const [toolName, toolInput, expected, failMode] of cases) {
    await t.test(`${toolName} → ${expected} (${failMode})`, async () => {
      const stub = await startStub();
      const stateDir = makeStateDir();
      stub.hang = true;
      const result = await runHook(
        hookInput({ tool_name: toolName, tool_input: toolInput }),
        stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true', NOBLECLOAK_RESOLVE_TIMEOUT_MS: '150' })
      );
      await stub.close();
      assert.equal(result.code, 0);
      assert.equal(decisionOf(result), expected);
      assert.match(result.stderr, /degraded/);
      const [record] = readAuditRecords(stateDir);
      assert.equal(record.degraded, true);
      assert.equal(record.degraded_reason, 'timeout');
      assert.equal(record.fail_mode, failMode);
    });
  }
});

test('timeout fail-modes (audit-only): everything allows, record marked degraded', async (t) => {
  for (const [toolName, toolInput, wouldBe] of [
    ['Bash', { command: 'rm -rf /' }, 'deny'],
    ['Read', { file_path: '/tmp/x' }, 'allow'],
  ]) {
    await t.test(`${toolName} → allow (would-be ${wouldBe})`, async () => {
      const stub = await startStub();
      const stateDir = makeStateDir();
      stub.hang = true;
      const result = await runHook(
        hookInput({ tool_name: toolName, tool_input: toolInput }),
        stubEnv(stub, stateDir, { NOBLECLOAK_RESOLVE_TIMEOUT_MS: '150' })
      );
      await stub.close();
      assert.equal(decisionOf(result), 'allow');
      const [record] = readAuditRecords(stateDir);
      assert.equal(record.degraded, true);
      assert.equal(record.fail_mode, 'audit-only-degraded');
      assert.equal(record.would_decision, wouldBe);
    });
  }
});

test('COO unreachable (connection refused) → fail-mode, never throws', async () => {
  const stateDir = makeStateDir();
  const result = await runHook(hookInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }), {
    NOBLECLOAK_COO_URL: 'http://127.0.0.1:9',
    NOBLECLOAK_STATE_DIR: stateDir,
    NOBLECLOAK_DEV_TOKEN: 'test-dev-token',
    NOBLECLOAK_LOCAL_ENFORCE: 'true',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
  });
  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'deny');
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.match(record.degraded_reason, /unreachable/);
});

test('200 with a non-JSON body → degraded invalid-response-body, side-effect fail-mode', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [{ status: 200, rawBody: '<html>proxy error page</html>' }];
  const result = await runHook(
    hookInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'deny'); // write tool → fail-closed
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.equal(record.degraded_reason, 'invalid-response-body');
  assert.equal(record.fail_mode, 'fail-closed');
});

test('200 with an out-of-vocabulary mode → degraded invalid-response-mode, side-effect fail-mode', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [{ status: 200, body: { mode: 'quarantine', source: 'explicit_role', side_effect_level: 'read' } }];
  const result = await runHook(
    hookInput({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'allow'); // read tool → fail-open
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.equal(record.degraded_reason, 'invalid-response-mode');
  assert.equal(record.fail_mode, 'read-fail-open');
});

test('5xx → fail-mode per side-effect class', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [{ status: 503, body: { error: 'unavailable' } }];
  const result = await runHook(
    hookInput({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  assert.equal(decisionOf(result), 'deny');
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded_reason, 'http-503');
});

// ── digest / safe-summary privacy (no-raw-args-leak) ────────────────────────

test('resolve request carries digest + safe summary and NEVER raw tool_input', async (t) => {
  const cases = [
    {
      name: 'Bash → first token only',
      input: hookInput({ tool_name: 'Bash', tool_input: { command: 'git push --force secret-remote feature/topsecret' } }),
      summary: 'git',
      mustNotContain: ['push', '--force', 'secret-remote', 'topsecret'],
    },
    {
      name: 'Edit → cwd-relative path, no content',
      input: hookInput({
        tool_name: 'Edit',
        cwd: '/tmp/project',
        tool_input: { file_path: '/tmp/project/src/auth.ts', old_string: 'OLD_SECRET_VALUE', new_string: 'NEW_SECRET_VALUE' },
      }),
      summary: 'src/auth.ts',
      mustNotContain: ['OLD_SECRET_VALUE', 'NEW_SECRET_VALUE', '/tmp/project/src/auth.ts'],
    },
    {
      name: 'WebFetch → domain only',
      input: hookInput({ tool_name: 'WebFetch', tool_input: { url: 'https://api.example.com/v1/users?apiKey=supersecret', prompt: 'summarize PRIVATE' } }),
      summary: 'api.example.com',
      mustNotContain: ['supersecret', '/v1/users', 'PRIVATE'],
    },
    {
      name: 'MCP → tool name only',
      input: hookInput({ tool_name: 'mcp__github__create_issue', tool_input: { title: 'CONFIDENTIAL ROADMAP', body: 'do not leak' } }),
      summary: 'mcp__github__create_issue',
      mustNotContain: ['CONFIDENTIAL', 'do not leak'],
    },
    {
      name: 'Read → tool name only (no path leak)',
      input: hookInput({ tool_name: 'Read', tool_input: { file_path: '/Users/me/.ssh/id_rsa' } }),
      summary: 'Read',
      mustNotContain: ['id_rsa', '.ssh'],
    },
  ];
  for (const { name, input, summary, mustNotContain } of cases) {
    await t.test(name, async () => {
      const stub = await startStub();
      const stateDir = makeStateDir();
      await runHook(input, stubEnv(stub, stateDir));
      await stub.close();
      const [req] = stub.resolveRequests();
      assert.equal(req.body.arg_summary, summary);
      assert.match(req.body.arg_digest, /^[0-9a-f]{64}$/);
      assert.equal(req.body.tool_input, undefined, 'raw tool_input must never be sent');
      for (const fragment of mustNotContain) {
        assert.ok(!req.rawBody.includes(fragment), `request must not contain '${fragment}'`);
      }
    });
  }
});

// ── never-throw / malformed stdin ───────────────────────────────────────────

test('malformed stdin (audit-only) → exit 0, allow, loud stderr, degraded audit record', async () => {
  const stateDir = makeStateDir();
  const result = await runHook('this is {{{ not json', {
    NOBLECLOAK_STATE_DIR: stateDir,
    NOBLECLOAK_DEV_TOKEN: 'test-dev-token',
  });
  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'allow');
  assert.match(result.stderr, /malformed/i);
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.equal(record.degraded_reason, 'malformed-input');
  assert.equal(record.decision, 'allow');
  assert.equal(record.would_decision, 'deny'); // unclassifiable → treated as non-read
  assert.equal(record.fail_mode, 'audit-only-degraded');
  assert.equal(record.session_id, null);
  assert.equal(record.tool_use_id, null);
});

test('malformed stdin (enforce) → fail-closed deny, same as the other unclassifiable paths', async () => {
  const stateDir = makeStateDir();
  const result = await runHook('this is {{{ not json', {
    NOBLECLOAK_STATE_DIR: stateDir,
    NOBLECLOAK_DEV_TOKEN: 'test-dev-token',
    NOBLECLOAK_LOCAL_ENFORCE: 'true',
  });
  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'deny');
  assert.match(result.stderr, /malformed/i);
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded_reason, 'malformed-input');
  assert.equal(record.decision, 'deny');
  assert.equal(record.fail_mode, 'fail-closed');
});

test('empty stdin → exit 0, valid JSON (allow in audit-only)', async () => {
  const result = await runHook('', { NOBLECLOAK_STATE_DIR: makeStateDir() });
  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'allow');
});

// ── D5 shape guard ──────────────────────────────────────────────────────────

test('shape drift (missing tool_use_id): loud stderr + fail-mode (enforce write → deny) + degraded audit record', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const input = hookInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x' } });
  delete input.tool_use_id;
  const result = await runHook(input, stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' }));
  await stub.close();
  assert.equal(decisionOf(result), 'deny');
  assert.match(result.stderr, /shape|drift|load-bearing/i);
  assert.equal(stub.resolveRequests().length, 0, 'untrusted input must not be resolved');
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.equal(record.degraded_reason, 'shape-drift');
  assert.equal(record.tool_use_id, null);
  assert.equal(record.session_id, input.session_id); // surviving fields are kept
  assert.equal(record.tool_name, 'Edit');
  assert.equal(record.fail_mode, 'fail-closed');
});

test('shape drift in audit-only: warns but allows, degraded audit record appended', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const input = hookInput({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  delete input.session_id;
  const result = await runHook(input, stubEnv(stub, stateDir));
  await stub.close();
  assert.equal(decisionOf(result), 'allow');
  assert.match(result.stderr, /shape|drift|load-bearing/i);
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded_reason, 'shape-drift');
  assert.equal(record.session_id, null);
  assert.equal(record.decision, 'allow');
  assert.equal(record.would_decision, 'deny'); // Bash → delete-level offline
});

// ── D6 SDK dedup stub ───────────────────────────────────────────────────────

test('NOBLECLOAK_SDK_HOOK_ACTIVE set → no-op allow, no resolve, no audit', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const result = await runHook(
    hookInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_SDK_HOOK_ACTIVE: '1', NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  assert.equal(decisionOf(result), 'allow');
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /SDK/i);
  assert.equal(stub.resolveRequests().length, 0);
  assert.equal(readAuditRecords(stateDir).length, 0);
});

// ── per-call record contract (the brief #5 seam) ────────────────────────────

test('audit record carries the documented v1 shape', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  stub.resolveResponses = [resolveResponse('deny', { source: 'explicit_role', side_effect_level: 'delete' })];
  await runHook(
    hookInput({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, agent_id: 'agt_9', agent_type: 'general' }),
    stubEnv(stub, stateDir)
  );
  await stub.close();
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.v, 1);
  assert.equal(record.hook_event, 'PreToolUse');
  assert.equal(record.session_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(record.tool_use_id, 'toolu_0123456789');
  assert.equal(record.agent_id, 'agt_9');
  assert.equal(record.tool_ref, 'tool:claude-code:bash');
  assert.equal(record.bn_invocation_channel, 'headless'); // agent_id present
  assert.match(record.arg_digest, /^[0-9a-f]{64}$/);
  assert.equal(record.arg_summary, 'rm');
  assert.equal(record.token_source, 'dev');
  assert.equal(record.decision, 'allow');
  assert.equal(record.would_decision, 'deny');
  assert.equal(record.degraded, false);
  assert.ok(typeof record.duration_ms === 'number');
  assert.ok(!JSON.stringify(record).includes('rm -rf x'), 'audit record must not contain raw args');
});

test('audit write is best-effort: un-creatable state dir never affects the decision', async () => {
  const stub = await startStub();
  const base = makeStateDir();
  const blockingFile = join(base, 'a-file');
  writeFileSync(blockingFile, 'x');
  // A child of an existing FILE can never be created → every audit append throws.
  const stateDir = join(blockingFile, 'nested');
  stub.resolveResponses = [resolveResponse('always_allow')];
  const result = await runHook(
    hookInput({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
    stubEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' })
  );
  await stub.close();
  assert.equal(result.code, 0);
  assert.equal(decisionOf(result), 'allow', 'server allow must survive an audit-write failure');
  assert.match(result.stderr, /failed to append audit record/);
});

test('dev token override is loudly marked on stderr', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const result = await runHook(hookInput(), stubEnv(stub, stateDir));
  await stub.close();
  assert.match(result.stderr, /NOBLECLOAK_DEV_TOKEN/);
  assert.equal(stub.resolveRequests()[0].headers.authorization, 'Bearer test-dev-token');
});

test('no token at all → degraded no-token fail-mode (audit-only allows)', async () => {
  const stub = await startStub();
  const stateDir = makeStateDir();
  const env = stubEnv(stub, stateDir);
  delete env.NOBLECLOAK_DEV_TOKEN;
  const result = await runHook(hookInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }), env);
  await stub.close();
  assert.equal(decisionOf(result), 'allow');
  assert.equal(stub.resolveRequests().length, 0);
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded, true);
  assert.equal(record.degraded_reason, 'no-token');
});

// ── local expiry check + signed-out marker (auth/audit hygiene 2026-10-20) ──
//
// The 2026-08 → 2026-10 incident: an expired token was POSTed to resolve on
// every tool call (one COO error-level 401 log line each), each followed by a
// rejected refresh. Now a known-expired token is never sent, a rejected grant
// writes .local/signed-out.json, and while it exists the hook makes no COO call.

function seedExpiringAuth(stateDir, overrides = {}) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'auth.json'),
    JSON.stringify({
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 60_000,
      tokenType: 'Bearer',
      authenticatedAt: new Date().toISOString(),
      ...overrides,
    })
  );
}

function authFileEnv(stub, stateDir, extra = {}) {
  const env = stubEnv(stub, stateDir, extra);
  delete env.NOBLECLOAK_DEV_TOKEN; // the auth-file path is the one under test
  return env;
}

const tokenGrants = (stub) => stub.requests.filter((r) => r.path === '/auth/oauth/token');
const markerPath = (stateDir) => join(stateDir, 'signed-out.json');

test('expired token + refresh succeeds → resolve sends ONLY the refreshed token (expired one never sent)', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const stateDir = makeStateDir();
  seedExpiringAuth(stateDir);
  const result = await runHook(hookInput({ tool_name: 'Read' }), authFileEnv(stub, stateDir));
  await stub.close();
  assert.equal(decisionOf(result), 'allow');
  assert.equal(tokenGrants(stub).length, 1, 'one refresh before the call');
  const resolves = stub.resolveRequests();
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].headers.authorization, 'Bearer refreshed-token');
  assert.ok(!existsSync(markerPath(stateDir)), 'a successful refresh writes no marker');
});

test('expired token + rejected refresh → marker written, ZERO resolve calls, visible systemMessage, signed-out fail-mode', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const stateDir = makeStateDir();
  seedExpiringAuth(stateDir);
  const env = authFileEnv(stub, stateDir, { NOBLECLOAK_LOCAL_ENFORCE: 'true' });
  const result = await runHook(hookInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/a' } }), env);

  assert.equal(stub.resolveRequests().length, 0, 'the expired token is never sent to COO');
  assert.equal(tokenGrants(stub).length, 1);
  assert.equal(decisionOf(result), 'deny', 'enforce + write tool → fail-closed (unchanged no-token fail-mode)');
  const marker = JSON.parse(readFileSync(markerPath(stateDir), 'utf-8'));
  assert.match(marker.reason, /invalid_grant/);
  assert.ok(marker.since);
  assert.match(result.output.systemMessage, /signed out[\s\S]*\/noblecloak-login/);
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded_reason, 'signed-out');

  // Second call in the same session: no network AT ALL, and the notice is not repeated.
  const before = stub.requests.length;
  const second = await runHook(hookInput({ tool_name: 'Read', tool_use_id: 'toolu_second' }), env);
  await stub.close();
  assert.equal(stub.requests.length, before, 'zero requests (resolve or token) while marked');
  assert.equal(decisionOf(second), 'allow', 'read tool → fail-open in enforce');
  assert.equal(second.output.systemMessage, undefined, 'warned once per session');
});

test('signed-out notice is shown once PER SESSION: a different session sees it too', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const stateDir = makeStateDir();
  seedExpiringAuth(stateDir);
  writeFileSync(markerPath(stateDir), JSON.stringify({ since: '2026-08-18T00:00:00.000Z', reason: 'invalid_grant', checkedAt: Date.now() }));
  // The marker is normally written via writeSignedOut, which also queues the notice.
  const { postNotice, signedOutMessage } = await import('../scripts/lib/governance.mjs');
  postNotice('signed-out', signedOutMessage({ since: '2026-08-18T00:00:00.000Z' }), { NOBLECLOAK_STATE_DIR: stateDir });
  const env = authFileEnv(stub, stateDir);
  const a1 = await runHook(hookInput({ session_id: 'session-a' }), env);
  const a2 = await runHook(hookInput({ session_id: 'session-a', tool_use_id: 'toolu_2' }), env);
  const b1 = await runHook(hookInput({ session_id: 'session-b', tool_use_id: 'toolu_3' }), env);
  await stub.close();
  assert.match(a1.output.systemMessage, /since 2026-08-18/);
  assert.equal(a2.output.systemMessage, undefined);
  assert.match(b1.output.systemMessage, /signed out/);
  assert.equal(stub.requests.length, 0, 'no COO or token calls while marked and the re-check is not due');
});

test('signed-out re-check interval: not due → no refresh; due → one refresh, success clears the marker and resumes COO calls', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const stateDir = makeStateDir();
  seedExpiringAuth(stateDir);
  // Last checked 1 minute ago; interval 15 minutes (default) → not due.
  writeFileSync(markerPath(stateDir), JSON.stringify({ since: 'x', reason: 'invalid_grant', checkedAt: Date.now() - 60_000 }));
  const env = authFileEnv(stub, stateDir);
  await runHook(hookInput(), env);
  assert.equal(stub.requests.length, 0, 'within the re-check interval: no refresh attempt, no resolve');

  // Same marker age, interval shortened below it → due.
  const due = await runHook(hookInput({ tool_use_id: 'toolu_due' }), { ...env, NOBLECLOAK_SIGNED_OUT_RECHECK_MS: '30000' });
  await stub.close();
  assert.equal(tokenGrants(stub).length, 1, 'exactly one re-check grant');
  assert.equal(stub.resolveRequests().length, 1, 'resolve resumes after the grant is accepted');
  assert.equal(stub.resolveRequests()[0].headers.authorization, 'Bearer refreshed-token');
  assert.ok(!existsSync(markerPath(stateDir)), 'a successful refresh deletes the marker');
  assert.equal(decisionOf(due), 'allow');
});

test('signed-out re-check that is rejected again keeps the marker, keeps `since`, and advances checkedAt', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const stateDir = makeStateDir();
  seedExpiringAuth(stateDir);
  const oldCheck = Date.now() - 3_600_000;
  writeFileSync(markerPath(stateDir), JSON.stringify({ since: '2026-08-18T00:00:00.000Z', reason: 'old', checkedAt: oldCheck }));
  await runHook(hookInput(), authFileEnv(stub, stateDir));
  await stub.close();
  assert.equal(tokenGrants(stub).length, 1);
  assert.equal(stub.resolveRequests().length, 0);
  const marker = JSON.parse(readFileSync(markerPath(stateDir), 'utf-8'));
  assert.equal(marker.since, '2026-08-18T00:00:00.000Z');
  assert.ok(marker.checkedAt > oldCheck);
});

test('expired token + TRANSIENT refresh failure (503) → no resolve, no marker, degraded token-expired', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.tokenStatus = 503;
  const stateDir = makeStateDir();
  seedExpiringAuth(stateDir);
  const result = await runHook(hookInput({ tool_name: 'Read' }), authFileEnv(stub, stateDir));
  await stub.close();
  assert.equal(stub.resolveRequests().length, 0, 'the expired token is not sent even when the refresh is only transiently down');
  assert.ok(!existsSync(markerPath(stateDir)), 'transient failures never sign the plugin out');
  assert.equal(decisionOf(result), 'allow');
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded_reason, 'token-expired');
});

test('expired token and NO refresh token → marker, no network at all', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const stateDir = makeStateDir();
  seedExpiringAuth(stateDir, { refreshToken: null });
  const result = await runHook(hookInput(), authFileEnv(stub, stateDir));
  await stub.close();
  assert.equal(stub.requests.length, 0);
  assert.ok(existsSync(markerPath(stateDir)));
  assert.match(result.output.systemMessage, /noblecloak-login/);
});

test('a token inside the clock-skew allowance counts as expired (refreshed, not sent)', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const stateDir = makeStateDir();
  seedExpiringAuth(stateDir, { expiresAt: Date.now() + 5_000 }); // within the 30s skew
  await runHook(hookInput(), authFileEnv(stub, stateDir));
  await stub.close();
  assert.equal(tokenGrants(stub).length, 1);
  assert.equal(stub.resolveRequests()[0].headers.authorization, 'Bearer refreshed-token');
});

test('401 → refresh REJECTED → marker written, degraded signed-out, next call makes no COO call', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  stub.resolveResponses = [{ status: 401, body: {} }];
  stub.tokenStatus = 400;
  stub.tokenErrorBody = { error: 'invalid_grant' };
  const stateDir = makeStateDir();
  seedExpiringAuth(stateDir, { accessToken: 'revoked-token', expiresAt: Date.now() + 3_600_000 });
  const env = authFileEnv(stub, stateDir);
  await runHook(hookInput(), env);
  assert.equal(stub.resolveRequests().length, 1);
  assert.ok(existsSync(markerPath(stateDir)), 'a rejected grant on the 401 path signs the plugin out');
  const [record] = readAuditRecords(stateDir);
  assert.equal(record.degraded_reason, 'signed-out');
  await runHook(hookInput({ tool_use_id: 'toolu_next' }), env);
  await stub.close();
  assert.equal(stub.resolveRequests().length, 1, 'no further resolve while signed out');
});

test('the dev-token override ignores the marker (it describes auth.json, not the override)', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const stateDir = makeStateDir();
  writeFileSync(markerPath(stateDir), JSON.stringify({ since: 'x', reason: 'y', checkedAt: Date.now() }));
  await runHook(hookInput(), stubEnv(stub, stateDir));
  await stub.close();
  assert.equal(stub.resolveRequests().length, 1);
});
