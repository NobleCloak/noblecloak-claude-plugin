/**
 * Unit tests for scripts/lib/governance.mjs — pure functions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  argDigest,
  argSummary,
  canonicalize,
  cooBaseUrl,
  detectChannel,
  detectSurface,
  pluginVersion,
  failModeDecision,
  getBearerToken,
  isNobleCloakMcpTool,
  isEnforceMode,
  issuerBaseUrl,
  loadAuthState,
  loadMcpConfig,
  resolveResourceIndicator,
  mapDecisionToMode,
  mapModeToDecision,
  offlineSideEffectLevel,
  remainingBudgetMs,
  resolveTimeoutMs,
  saveAuthState,
  toolRefFor,
  CHANNEL_BY_ENTRYPOINT,
  SURFACE_BY_ENTRYPOINT,
  DEFAULT_RESOLVE_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  LOCAL_TOOL_SIDE_EFFECTS,
  appendAuditRecord,
  buildSubagentEnvelope,
  buildToolCallEnvelopes,
  compactAuditQueueAndLedger,
  decisionBlockFromPreRecord,
  deriveCeId,
  emitAuditEvent,
  EMIT_SPILLED,
  findPreRecord,
  drainUnshippedPreEnvelopes,
  loadShippedSet,
  markPreShipped,
  readBreaker,
  recordBreakerFailure,
  readPreRecords,
  outcomeFromPostInput,
  sanitizeError,
  spillAuditEvent,
  AUDIT_SHIPPED_RETENTION,
  AUDIT_SPILL_RETENTION,
  AUDIT_UNDRAINABLE_RETENTION,
  CE_SOURCE_LOCAL_EXECUTION,
  CE_TYPE_SUBAGENT_STARTED,
  CE_TYPE_SUBAGENT_STOPPED,
  CE_TYPE_TOOL_CALL_AUTHORIZED,
  CE_TYPE_TOOL_CALL_DENIED,
  MAX_ERROR_MESSAGE_LEN,
  acquireDrainLock,
  releaseDrainLock,
  recordWorkerDegraded,
  workerDeadlineMs,
} from '../scripts/lib/governance.mjs';
import { makeStateDir, REPO_ROOT } from './helpers.mjs';
import { utimesSync } from 'node:fs';

// ── tool_ref mapping ────────────────────────────────────────────────────────

test('toolRefFor maps built-ins to tool:claude-code:<lowercase>', () => {
  assert.equal(toolRefFor('Bash'), 'tool:claude-code:bash');
  assert.equal(toolRefFor('Edit'), 'tool:claude-code:edit');
  assert.equal(toolRefFor('Write'), 'tool:claude-code:write');
  assert.equal(toolRefFor('Read'), 'tool:claude-code:read');
  assert.equal(toolRefFor('Glob'), 'tool:claude-code:glob');
  assert.equal(toolRefFor('Grep'), 'tool:claude-code:grep');
  assert.equal(toolRefFor('WebFetch'), 'tool:claude-code:webfetch');
  assert.equal(toolRefFor('Agent'), 'tool:claude-code:agent');
});

test('toolRefFor passes mcp__ refs through verbatim', () => {
  assert.equal(toolRefFor('mcp__github__create_issue'), 'mcp__github__create_issue');
});

test('toolRefFor rejects non-string/empty tool names', () => {
  assert.equal(toolRefFor(undefined), null);
  assert.equal(toolRefFor(''), null);
  assert.equal(toolRefFor(42), null);
});

test('isNobleCloakMcpTool (no .mcp.json): exact fallback server ids only', () => {
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') }; // file absent
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak__list_agents', env), true);
  // The legacy second fallback id is gone: .mcp.json is authoritative, the fallback is one id.
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak-coo__dispatch', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__github__create_issue', env), false);
  assert.equal(isNobleCloakMcpTool('Bash', env), false);
});

test('isNobleCloakMcpTool: installed-plugin form mcp__plugin_noblecloak_<server>__ matches the same ids', () => {
  const absent = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  assert.equal(isNobleCloakMcpTool('mcp__plugin_noblecloak_noblecloak__search_records', absent), true);
  assert.equal(isNobleCloakMcpTool('mcp__plugin_noblecloak_github__create_issue', absent), false);
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  writeFileSync(env.NOBLECLOAK_MCP_FILE, JSON.stringify({ mcpServers: { noblecloak: { type: 'http', url: 'https://x.test/mcp' } } }));
  assert.equal(isNobleCloakMcpTool('mcp__plugin_noblecloak_noblecloak__search_records', env), true);
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak__search_records', env), true);
});

test('the plugin id used for the mcp__plugin_<id>_ prefix is the name in plugin.json', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  assert.equal(isNobleCloakMcpTool(`mcp__plugin_${manifest.name}_noblecloak__x`, env), true);
});

test('isNobleCloakMcpTool: plugin-form lookalikes are NOT gateway-skipped', () => {
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  writeFileSync(env.NOBLECLOAK_MCP_FILE, JSON.stringify({ mcpServers: { noblecloak: { type: 'http', url: 'https://x.test/mcp' } } }));
  // another plugin's server that happens to be called noblecloak
  assert.equal(isNobleCloakMcpTool('mcp__plugin_other_noblecloak__x', env), false);
  // our plugin, a server that is not in .mcp.json
  assert.equal(isNobleCloakMcpTool('mcp__plugin_noblecloak_noblecloakfake__x', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__plugin_noblecloak_unknown__x', env), false);
  // prefix with nothing after it, and no action segment
  assert.equal(isNobleCloakMcpTool('mcp__plugin_noblecloak___x', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__plugin_noblecloak_noblecloak', env), false);
  // the raw plugin-form segment is not itself a server id
  assert.equal(isNobleCloakMcpTool('mcp__plugin_noblecloak__x', env), false);
});

test('isNobleCloakMcpTool never over-matches lookalike server names (governance/audit bypass guard)', () => {
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  assert.equal(isNobleCloakMcpTool('mcp__noblecloakfake__x', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak2__x', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak-unknown__x', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak-evil-proxy__run', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak', env), false); // no action segment
});

test('isNobleCloakMcpTool: present-but-EMPTY .mcp.json is authoritative — no static fallback (shipped default / post-logout state)', () => {
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  // An empty server map (e.g. a hand-edited config): zero gateway-governed
  // servers → NOTHING gets the gateway-skip.
  writeFileSync(env.NOBLECLOAK_MCP_FILE, JSON.stringify({ mcpServers: {} }));
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak__list_agents', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak-coo__dispatch', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__noblecloakfake__x', env), false);
});

test('isNobleCloakMcpTool: a written .mcp.json is the source of truth for server ids', () => {
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  writeFileSync(
    env.NOBLECLOAK_MCP_FILE,
    JSON.stringify({ mcpServers: { 'noblecloak-custom': { type: 'http', url: 'https://api.example.com/mcp' } } })
  );
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak-custom__do_thing', env), true);
  // Not in the config → governed (resolved + audited), even fallback ids.
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak__list_agents', env), false);
  assert.equal(isNobleCloakMcpTool('mcp__noblecloak-customx__do_thing', env), false);
});

// ── static side-effect mirror ───────────────────────────────────────────────

test('static mirror matches the decided 8-tool classification (coo local-tool-catalog.ts)', () => {
  assert.deepEqual(LOCAL_TOOL_SIDE_EFFECTS, {
    'tool:claude-code:bash': 'delete',
    'tool:claude-code:edit': 'write',
    'tool:claude-code:write': 'write',
    'tool:claude-code:read': 'read',
    'tool:claude-code:glob': 'read',
    'tool:claude-code:grep': 'read',
    'tool:claude-code:webfetch': 'external',
    'tool:claude-code:agent': 'read',
  });
});

test('offlineSideEffectLevel: mcp__ → write, unknown → write', () => {
  assert.equal(offlineSideEffectLevel('mcp__github__create_issue'), 'write');
  assert.equal(offlineSideEffectLevel('tool:claude-code:somenewtool'), 'write');
  assert.equal(offlineSideEffectLevel(null), 'write');
});

// ── channel table ───────────────────────────────────────────────────────────

test('channel table: interactive only for cli entrypoint with no agent_id', () => {
  assert.equal(detectChannel('cli', undefined), 'interactive');
});

test('channel table: subagents are always headless, even under cli', () => {
  assert.equal(detectChannel('cli', 'agent-123'), 'headless');
});

test('channel table: sdk-cli (claude -p) is headless', () => {
  assert.equal(detectChannel('sdk-cli', undefined), 'headless');
});

test('channel table: unknown/missing entrypoint is headless (fail-safe)', () => {
  assert.equal(detectChannel(undefined, undefined), 'headless');
  assert.equal(detectChannel('', undefined), 'headless');
  assert.equal(detectChannel('some-future-host', undefined), 'headless');
});

test('channel table is a checked lookup table, not an if/else guess', () => {
  assert.deepEqual(CHANNEL_BY_ENTRYPOINT, { cli: 'interactive', 'sdk-cli': 'headless' });
});

// ── surface detection (D5a — session tool-call log brief 2026-07-09) ─────────

test('detectSurface: cli entrypoint → claude-code', () => {
  assert.equal(detectSurface({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'claude-code');
});

test('detectSurface: sdk-cli entrypoint → claude-code', () => {
  assert.equal(detectSurface({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), 'claude-code');
});

test('detectSurface: unknown/future entrypoint → unknown (safe default)', () => {
  assert.equal(detectSurface({ CLAUDE_CODE_ENTRYPOINT: 'mystery-host' }), 'unknown');
});

test('detectSurface: missing entrypoint env var → unknown (no throw)', () => {
  assert.equal(detectSurface({}), 'unknown');
});

test('detectSurface: undefined env defaults to process.env, never throws', () => {
  assert.doesNotThrow(() => detectSurface(undefined));
});

test('detectSurface: prototype-member entrypoint (toString) → unknown (prototype-safe, not an inherited member)', () => {
  assert.equal(detectSurface({ CLAUDE_CODE_ENTRYPOINT: 'toString' }), 'unknown');
  assert.equal(detectSurface({ CLAUDE_CODE_ENTRYPOINT: 'constructor' }), 'unknown');
  assert.equal(detectSurface({ CLAUDE_CODE_ENTRYPOINT: '__proto__' }), 'unknown');
});

test('surface table is a checked lookup table (locks the shape)', () => {
  assert.deepEqual(SURFACE_BY_ENTRYPOINT, { cli: 'claude-code', 'sdk-cli': 'claude-code' });
});

// ── plugin version seam (D5 — surface.version sourced from the manifest) ─────

test('pluginVersion: returns the checked-in .claude-plugin/plugin.json version', () => {
  // Read the manifest directly so the assertion tracks the file, not a hardcode.
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
  assert.equal(pluginVersion(), manifest.version);
  assert.equal(typeof pluginVersion(), 'string');
});

test('pluginVersion: missing manifest → undefined (best-effort, never throws)', () => {
  const root = makeStateDir(); // no .claude-plugin/plugin.json inside
  assert.equal(pluginVersion(root), undefined);
});

test('pluginVersion: malformed manifest JSON → undefined (graceful degrade)', () => {
  const root = makeStateDir();
  const dir = join(root, '.claude-plugin');
  mkdirSync(dir);
  writeFileSync(join(dir, 'plugin.json'), '{ not valid json');
  assert.equal(pluginVersion(root), undefined);
});

test('pluginVersion: non-string version field → undefined (type guard)', () => {
  const root = makeStateDir();
  const dir = join(root, '.claude-plugin');
  mkdirSync(dir);
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ version: 123 }));
  assert.equal(pluginVersion(root), undefined);
});

// ── decision mapping + fail modes ───────────────────────────────────────────

test('mode→decision isomorphism (ADR-0033 §6)', () => {
  assert.equal(mapModeToDecision('always_allow'), 'allow');
  assert.equal(mapModeToDecision('ask'), 'ask');
  assert.equal(mapModeToDecision('deny'), 'deny');
  assert.equal(mapModeToDecision('something-else'), null);
  assert.equal(mapModeToDecision(undefined), null);
});

test('decision→mode isomorphism (inverse of mapModeToDecision) — outbound audit vocab', () => {
  // The audit ingest (COO /v1/coo/local/events) validates decision fields against
  // the POLICY-MODE vocabulary (always_allow|ask|deny), not the permissionDecision
  // vocabulary (allow|ask|deny). The permissionDecision 'allow' must map back to the
  // policy-mode 'always_allow'; 'ask'/'deny' are spelled identically in both.
  assert.equal(mapDecisionToMode('allow'), 'always_allow');
  assert.equal(mapDecisionToMode('ask'), 'ask');
  assert.equal(mapDecisionToMode('deny'), 'deny');
  assert.equal(mapDecisionToMode('something-else'), null);
  assert.equal(mapDecisionToMode(undefined), null);
});

test('fail-mode: enforce → read fail-open, write/external/delete/admin fail-closed', () => {
  assert.deepEqual(failModeDecision('read', true), { decision: 'allow', failMode: 'read-fail-open' });
  for (const level of ['write', 'external', 'delete', 'admin']) {
    assert.deepEqual(failModeDecision(level, true), { decision: 'deny', failMode: 'fail-closed' });
  }
});

test('fail-mode: audit-only always allows', () => {
  for (const level of ['read', 'write', 'external', 'delete', 'admin']) {
    assert.deepEqual(failModeDecision(level, false), { decision: 'allow', failMode: 'audit-only-degraded' });
  }
});

test('isEnforceMode defaults false and accepts true/1', () => {
  assert.equal(isEnforceMode({}), false);
  assert.equal(isEnforceMode({ NOBLECLOAK_LOCAL_ENFORCE: 'false' }), false);
  assert.equal(isEnforceMode({ NOBLECLOAK_LOCAL_ENFORCE: 'true' }), true);
  assert.equal(isEnforceMode({ NOBLECLOAK_LOCAL_ENFORCE: '1' }), true);
});

// ── canonicalization + digest ───────────────────────────────────────────────

test('canonicalize sorts keys recursively for a stable digest', () => {
  assert.equal(canonicalize({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(argDigest({ b: 2, a: 1 }), argDigest({ a: 1, b: 2 }));
});

test('argDigest golden case — SHA-256 hex of canonical JSON', () => {
  const input = { command: 'git status --porcelain', description: 'Show status' };
  const expected = createHash('sha256')
    .update('{"command":"git status --porcelain","description":"Show status"}', 'utf-8')
    .digest('hex');
  assert.equal(argDigest(input), expected);
});

test('argDigest handles missing input', () => {
  assert.equal(argDigest(undefined), createHash('sha256').update('null', 'utf-8').digest('hex'));
});

// ── safe summaries (ADR-0033 §5 golden cases) ───────────────────────────────

test('Bash summary is the first token only', () => {
  assert.equal(argSummary('Bash', { command: 'git push --force origin main' }, '/w'), 'git');
  assert.equal(argSummary('Bash', { command: '  rm -rf /tmp/x  ' }, '/w'), 'rm');
  assert.equal(argSummary('Bash', {}, '/w'), 'bash');
});

test('Edit/Write summary is the cwd-relative path', () => {
  assert.equal(argSummary('Edit', { file_path: '/work/src/app.ts', old_string: 's3cret' }, '/work'), 'src/app.ts');
  assert.equal(argSummary('Write', { file_path: '/work/README.md', content: 'private' }, '/work'), 'README.md');
});

test('Edit/Write summary degrades to basename when the path escapes cwd', () => {
  assert.equal(argSummary('Edit', { file_path: '/Users/someone/.ssh/config' }, '/work'), 'config');
});

test('WebFetch summary is the domain only', () => {
  assert.equal(
    argSummary('WebFetch', { url: 'https://internal.example.com/secret/path?token=abc' }, '/w'),
    'internal.example.com'
  );
  assert.equal(argSummary('WebFetch', { url: 'not a url' }, '/w'), 'invalid-url');
});

test('MCP summary is the tool name only', () => {
  assert.equal(
    argSummary('mcp__github__create_issue', { title: 'Private title', body: 'secret' }, '/w'),
    'mcp__github__create_issue'
  );
});

test('undecided tools (Read/Glob/Grep/Agent) summarize as tool name only — fail-safe', () => {
  assert.equal(argSummary('Read', { file_path: '/etc/passwd' }, '/w'), 'Read');
  assert.equal(argSummary('Grep', { pattern: 'password=' }, '/w'), 'Grep');
  assert.equal(argSummary('Agent', { prompt: 'do things' }, '/w'), 'Agent');
});

// ── config parsing edges ────────────────────────────────────────────────────

test('resolveTimeoutMs falls back to the default on garbage/zero/negative values', () => {
  assert.equal(resolveTimeoutMs({ NOBLECLOAK_RESOLVE_TIMEOUT_MS: 'abc' }), DEFAULT_RESOLVE_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ NOBLECLOAK_RESOLVE_TIMEOUT_MS: '0' }), DEFAULT_RESOLVE_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ NOBLECLOAK_RESOLVE_TIMEOUT_MS: '-5' }), DEFAULT_RESOLVE_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({}), DEFAULT_RESOLVE_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ NOBLECLOAK_RESOLVE_TIMEOUT_MS: '250' }), 250);
});

test('remainingBudgetMs: no deadline → per-attempt timeout unchanged', () => {
  assert.equal(remainingBudgetMs(undefined, 1500), 1500);
  assert.equal(remainingBudgetMs(null, 1500), 1500);
});

test('remainingBudgetMs: clamps to the remaining time and never goes negative', () => {
  assert.equal(remainingBudgetMs(Date.now() - 1_000, 1500), 0); // deadline in the past
  const clamped = remainingBudgetMs(Date.now() + 500, 1500);
  assert.ok(clamped > 0 && clamped <= 500, `expected 0 < clamped <= 500, got ${clamped}`);
  assert.equal(remainingBudgetMs(Date.now() + 60_000, 1500), 1500); // plenty left → unchanged
});

test('base URLs strip trailing slashes (no //v1/coo/local/resolve)', () => {
  assert.equal(cooBaseUrl({ NOBLECLOAK_COO_URL: 'http://x/' }), 'http://x');
  assert.equal(cooBaseUrl({ NOBLECLOAK_COO_URL: 'http://x///' }), 'http://x');
  assert.equal(issuerBaseUrl({ NOBLECLOAK_ISSUER: 'https://issuer.example.com/' }), 'https://issuer.example.com');
});

// ── auth state edges ────────────────────────────────────────────────────────

test('corrupted auth.json degrades to null / no-token instead of throwing', () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  writeFileSync(join(dir, 'auth.json'), '{ not json !!!');
  assert.equal(loadAuthState(env), null);
  assert.equal(getBearerToken(env), null);
});

test('NOBLECLOAK_DEV_TOKEN takes precedence over a populated auth.json', () => {
  const dir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: dir };
  saveAuthState({ issuer: issuerBaseUrl(env), accessToken: 'file-token', refreshToken: 'file-refresh', expiresAt: Date.now() + 3600_000 }, env);
  const fromFile = getBearerToken(env);
  assert.deepEqual(fromFile, { token: 'file-token', source: 'auth-file', refreshToken: 'file-refresh' });
  const fromDev = getBearerToken({ ...env, NOBLECLOAK_DEV_TOKEN: 'dev-token' });
  assert.deepEqual(fromDev, { token: 'dev-token', source: 'dev', refreshToken: null });
});

// ── .mcp.json reader (loadMcpConfig) ─────────────────────────────────────────

test('loadMcpConfig reads the committed tokenless .mcp.json shape', () => {
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  writeFileSync(
    env.NOBLECLOAK_MCP_FILE,
    JSON.stringify({ mcpServers: { noblecloak: { type: 'http', url: 'https://api.example.com/mcp' } } })
  );
  const config = loadMcpConfig(env);
  assert.deepEqual(Object.keys(config.mcpServers), ['noblecloak']);
  assert.equal(config.mcpServers.noblecloak.url, 'https://api.example.com/mcp');
  assert.equal(config.mcpServers.noblecloak.headers, undefined, 'committed file carries no token header');
});

test('loadMcpConfig: absent or corrupted file → null', () => {
  const dir = makeStateDir();
  assert.equal(loadMcpConfig({ NOBLECLOAK_MCP_FILE: join(dir, 'missing.json') }), null);
  const corrupted = join(dir, 'corrupt.json');
  writeFileSync(corrupted, '{ nope');
  assert.equal(loadMcpConfig({ NOBLECLOAK_MCP_FILE: corrupted }), null);
});

// ── hooks.json wiring (D1) ─────────────────────────────────────────────────

test('hooks.json keeps the SessionStart refresh hook and adds the PreToolUse matcher', () => {
  const hooks = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
  const sessionStart = hooks.hooks.SessionStart?.[0]?.hooks?.[0]?.command;
  assert.match(sessionStart, /refresh\.mjs/);

  const pre = hooks.hooks.PreToolUse?.[0];
  assert.ok(pre, 'PreToolUse block present');
  assert.match(pre.hooks[0].command, /pre-tool-use\.mjs/);

  const matcher = new RegExp(pre.matcher);
  for (const name of ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'Agent', 'mcp__github__x', 'mcp__noblecloak__y']) {
    assert.match(name, matcher, `${name} should match (mcp__noblecloak excluded in script, not matcher)`);
  }
  for (const name of ['Task', 'TodoWrite', 'NotebookEdit', 'BashOutput', 'WebSearch']) {
    assert.doesNotMatch(name, matcher, `${name} should NOT match`);
  }
});

test('cumulative network budget stays under the hooks.json PreToolUse timeout', () => {
  // If the host kills the hook before it emits, no decision JSON is written
  // and enforce-mode fail-closed silently degrades to the host's hook-timeout
  // default. The internal budget (shared across resolve #1, OAuth discovery,
  // token refresh, resolve #2) must leave headroom for node startup + emit.
  const hooks = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
  const hookTimeoutMs = hooks.hooks.PreToolUse[0].hooks[0].timeout * 1000;
  const STARTUP_AND_EMIT_HEADROOM_MS = 750;
  assert.ok(
    DEFAULT_TOTAL_BUDGET_MS + STARTUP_AND_EMIT_HEADROOM_MS <= hookTimeoutMs,
    `DEFAULT_TOTAL_BUDGET_MS (${DEFAULT_TOTAL_BUDGET_MS}) + ${STARTUP_AND_EMIT_HEADROOM_MS}ms headroom must fit in the hooks.json timeout (${hookTimeoutMs}ms)`
  );
  // The per-attempt default must itself fit inside the budget.
  assert.ok(DEFAULT_RESOLVE_TIMEOUT_MS < DEFAULT_TOTAL_BUDGET_MS);
});

// ── audit-event emission helpers (brief #5) ────────────────────────────────

test('deriveCeId composes <key>:<phase> and is deterministic', () => {
  assert.equal(deriveCeId('toolu_1', 'pre'), 'toolu_1:pre');
  assert.equal(deriveCeId('toolu_1', 'post'), 'toolu_1:post');
  assert.equal(deriveCeId('agent_x', 'started'), 'agent_x:started');
  assert.equal(deriveCeId('toolu_1', 'pre'), deriveCeId('toolu_1', 'pre'));
});

test('sanitizeError truncates beyond the cap and passes short strings through', () => {
  assert.equal(sanitizeError('boom'), 'boom');
  assert.equal(sanitizeError(undefined), undefined);
  assert.equal(sanitizeError(42), undefined);
  const long = 'x'.repeat(MAX_ERROR_MESSAGE_LEN + 50);
  const out = sanitizeError(long);
  assert.equal(out.length, MAX_ERROR_MESSAGE_LEN + 1); // truncated + ellipsis
  assert.ok(out.endsWith('…'));
});

test('outcomeFromPostInput: success carries ok=true and never error/is_interrupt', () => {
  const outcome = outcomeFromPostInput({ hook_event_name: 'PostToolUse', duration_ms: 7, tool_response: { stdout: 'x' } });
  assert.deepEqual(outcome, { ok: true, duration_ms: 7 });
  assert.equal('error' in outcome, false);
});

test('outcomeFromPostInput: failure carries ok=false, sanitized error, is_interrupt', () => {
  const outcome = outcomeFromPostInput({
    hook_event_name: 'PostToolUseFailure',
    error: 'exit 1',
    is_interrupt: true,
    duration_ms: 5,
  });
  assert.deepEqual(outcome, { ok: false, error: 'exit 1', is_interrupt: true, duration_ms: 5 });
});

test('decisionBlockFromPreRecord: null record degrades with explicit metadata', () => {
  const block = decisionBlockFromPreRecord(null);
  assert.equal(block.source, 'unknown-no-pre-record');
  assert.equal(block.enforce_active, false);
  assert.equal('would_have_been' in block, false);
});

test('decisionBlockFromPreRecord: audit-only record records would_have_been', () => {
  const block = decisionBlockFromPreRecord({
    enforce: false,
    would_decision: 'deny',
    resolve: { mode: 'deny', source: 'policy', side_effect_level: 'delete' },
  });
  assert.equal(block.mode, 'deny');
  assert.equal(block.source, 'policy');
  assert.equal(block.side_effect_level, 'delete');
  assert.equal(block.enforce_active, false);
  assert.equal(block.would_have_been, 'deny');
});

test('decisionBlockFromPreRecord: degraded record records the offline side-effect level, not unknown', () => {
  // When the resolve degrades there is no server-side side_effect_level, but the
  // hook DID classify the tool offline to choose its fail-mode. Record THAT, so
  // the degraded audit event still explains why it failed open/closed — a
  // degraded event reporting side_effect_level 'unknown' loses that context.
  const block = decisionBlockFromPreRecord({
    enforce: false,
    degraded: true,
    degraded_reason: 'timeout',
    would_decision: 'deny',
    tool_ref: 'tool:claude-code:bash',
    // no `resolve` block — the resolve degraded
  });
  assert.equal(block.mode, 'degraded');
  assert.equal(block.source, 'timeout');
  assert.equal(block.side_effect_level, offlineSideEffectLevel('tool:claude-code:bash'));
  assert.equal(block.side_effect_level, 'delete'); // bash → delete (conservative)
  assert.notEqual(block.side_effect_level, 'unknown');
  assert.equal(block.would_have_been, 'deny');
});

test('decisionBlockFromPreRecord: null record keeps side_effect_level unknown (no tool_ref to classify)', () => {
  const block = decisionBlockFromPreRecord(null);
  assert.equal(block.side_effect_level, 'unknown');
});

test('decisionBlockFromPreRecord: audit-only allow maps would_have_been to policy-mode always_allow', () => {
  const block = decisionBlockFromPreRecord({
    enforce: false,
    would_decision: 'allow',
    resolve: { mode: 'always_allow', source: 'policy', side_effect_level: 'read' },
  });
  // COO ingest rejects the permissionDecision term 'allow'; would_have_been must
  // be the policy-mode term.
  assert.equal(block.would_have_been, 'always_allow');
});

test('decisionBlockFromPreRecord: audit-only ask stays ask (identity across vocabularies)', () => {
  const block = decisionBlockFromPreRecord({
    enforce: false,
    would_decision: 'ask',
    resolve: { mode: 'ask', source: 'policy', side_effect_level: 'external' },
  });
  assert.equal(block.would_have_been, 'ask');
});

test('decisionBlockFromPreRecord: enforce record omits would_have_been', () => {
  const block = decisionBlockFromPreRecord({
    enforce: true,
    would_decision: 'allow',
    resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' },
  });
  assert.equal(block.enforce_active, true);
  assert.equal('would_have_been' in block, false);
});

test('decisionBlockFromPreRecord: gatewayGoverned forces enforce_active:false even with pre:null', () => {
  assert.equal(decisionBlockFromPreRecord(null, { gatewayGoverned: true }).enforce_active, false);
});

test('decisionBlockFromPreRecord: gatewayGoverned forces enforce_active:false against a STALE pre with enforce:true', () => {
  // Defensive: a gateway-governed tool must NEVER report local enforcement, even
  // if a stale/mismatched Pre record for the same tool_use_id claims enforce:true.
  // enforce_active:false must not depend solely on `pre` being absent.
  const block = decisionBlockFromPreRecord(
    { enforce: true, resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' } },
    { gatewayGoverned: true }
  );
  assert.equal(block.enforce_active, false);
});

test('decisionBlockFromPreRecord: gatewayGoverned:false (default) behaves exactly as before', () => {
  const block = decisionBlockFromPreRecord(
    { enforce: true, would_decision: 'allow', resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' } },
    { gatewayGoverned: false }
  );
  assert.equal(block.enforce_active, true);
  assert.equal('would_have_been' in block, false);
});

test('findPreRecord: returns the LAST matching PreToolUse record (retry supersedes)', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'A', tag: 'first' }, env);
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'B', tag: 'other' }, env);
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'A', tag: 'second' }, env);
  assert.equal(findPreRecord('A', env).tag, 'second');
  assert.equal(findPreRecord('B', env).tag, 'other');
  assert.equal(findPreRecord('missing', env), null);
});

test('findPreRecord: missing queue file → null (no crash)', () => {
  const stateDir = makeStateDir();
  assert.equal(findPreRecord('A', { NOBLECLOAK_STATE_DIR: stateDir }), null);
});

test('buildToolCallEnvelopes: two CloudEvents 1.0 envelopes, pre has no outcome', () => {
  const input = {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-uuid',
    tool_use_id: 'toolu_9',
    tool_name: 'Bash',
    duration_ms: 3,
  };
  const pre = {
    tool_ref: 'tool:claude-code:bash',
    bn_invocation_channel: 'interactive',
    arg_digest: 'd'.repeat(64),
    arg_summary: 'echo',
    enforce: false,
    would_decision: 'allow',
    resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' },
  };
  const [preEnv, postEnv] = buildToolCallEnvelopes(input, pre);
  assert.equal(preEnv.specversion, '1.0');
  assert.equal(preEnv.source, CE_SOURCE_LOCAL_EXECUTION);
  assert.equal(preEnv.type, CE_TYPE_TOOL_CALL_AUTHORIZED);
  assert.equal(preEnv.subject, 'sess-uuid');
  assert.equal(preEnv.id, 'toolu_9:pre');
  assert.equal(preEnv.data.arg_summary, 'echo');
  assert.equal('outcome' in preEnv.data, false);
  assert.equal(postEnv.id, 'toolu_9:post');
  assert.equal(postEnv.data.outcome.ok, true);
});

test('buildToolCallEnvelopes: deny would-decision → denied ce_type', () => {
  const [preEnv] = buildToolCallEnvelopes(
    { hook_event_name: 'PostToolUseFailure', session_id: 's', tool_use_id: 't', tool_name: 'Bash' },
    { would_decision: 'deny', enforce: true, resolve: { mode: 'deny', source: 'policy', side_effect_level: 'delete' } }
  );
  assert.equal(preEnv.type, CE_TYPE_TOOL_CALL_DENIED);
});

// ── surface attribution on every tool-call event (D5) ───────────────────────

/** Run `fn` with CLAUDE_CODE_ENTRYPOINT forced (restores it after). */
function withEntrypoint(value, fn) {
  const prev = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (value === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = prev;
  }
}

test('buildToolCallEnvelopes: every tool-call envelope carries a well-formed surface block', () => {
  withEntrypoint('cli', () => {
    const input = { hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 't', tool_name: 'Bash', duration_ms: 1 };
    const pre = {
      tool_ref: 'tool:claude-code:bash',
      enforce: false,
      would_decision: 'allow',
      resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' },
    };
    const [preEnv, postEnv] = buildToolCallEnvelopes(input, pre);
    for (const env of [preEnv, postEnv]) {
      assert.equal(typeof env.data.surface, 'object');
      assert.equal(env.data.surface.reported, 'claude-code');
      // surface is purely self-reported host attribution — no client_id slot.
      assert.equal('client_id' in env.data.surface, false);
      // version is present because the real .claude-plugin/plugin.json is readable in-repo.
      assert.equal('version' in env.data.surface, true);
      assert.equal(env.data.surface.version, pluginVersion());
    }
  });
});

test('buildToolCallEnvelopes: surface.reported is unknown for an unrecognized surface, still well-formed', () => {
  withEntrypoint('mystery-host', () => {
    const [, postEnv] = buildToolCallEnvelopes(
      { hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 't', tool_name: 'Bash' },
      null
    );
    assert.equal(postEnv.data.surface.reported, 'unknown');
    assert.equal('client_id' in postEnv.data.surface, false);
  });
});

test('buildToolCallEnvelopes: surface carries NO client_id (self-reported block; verified attribution is a future COO server-stamped field)', () => {
  const [preEnv, postEnv] = buildToolCallEnvelopes(
    { hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 't', tool_name: 'Bash' },
    null
  );
  assert.equal('client_id' in preEnv.data.surface, false);
  assert.equal('client_id' in postEnv.data.surface, false);
});

// ── gateway-governed corroboration: post-only envelope (D1/D3/D4) ───────────

test('buildToolCallEnvelopes: gatewayGoverned:true returns exactly ONE envelope (the :post)', () => {
  const result = buildToolCallEnvelopes(
    { hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'toolu_g', tool_name: 'mcp__noblecloak__coo_list_agents', duration_ms: 4 },
    null,
    { gatewayGoverned: true }
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'toolu_g:post');
  assert.equal('outcome' in result[0].data, true);
});

test('buildToolCallEnvelopes: gatewayGoverned:true envelope has enforce_active:false and bn_corroborated_by', () => {
  const [postEnv] = buildToolCallEnvelopes(
    { hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'toolu_g', tool_name: 'mcp__noblecloak__x' },
    null,
    { gatewayGoverned: true }
  );
  assert.equal(postEnv.data.decision.enforce_active, false);
  assert.equal(postEnv.data.bn_corroborated_by, 'action_ledger');
});

test('buildToolCallEnvelopes: gatewayGoverned:true forces enforce_active:false even against a STALE enforce:true pre', () => {
  const [postEnv] = buildToolCallEnvelopes(
    { hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'toolu_g', tool_name: 'mcp__noblecloak__x' },
    { enforce: true, resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' } },
    { gatewayGoverned: true }
  );
  assert.equal(postEnv.data.decision.enforce_active, false);
});

test('buildToolCallEnvelopes: gatewayGoverned:true forces the AUTHORIZED ce_type (never derived from a would_decision)', () => {
  const [postEnv] = buildToolCallEnvelopes(
    { hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'toolu_g', tool_name: 'mcp__noblecloak__x' },
    null,
    { gatewayGoverned: true }
  );
  assert.equal(postEnv.type, CE_TYPE_TOOL_CALL_AUTHORIZED);
});

test('buildToolCallEnvelopes: gatewayGoverned:true against a STALE would_decision:deny pre still ships AUTHORIZED (never typed denied)', () => {
  const [postEnv] = buildToolCallEnvelopes(
    { hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'toolu_g', tool_name: 'mcp__noblecloak__x' },
    // A colliding/stale Pre record on the same tool_use_id carrying would_decision:'deny'.
    { tool_use_id: 'toolu_g', would_decision: 'deny', enforce: false, resolve: { mode: 'deny', source: 's', side_effect_level: 'write' } },
    { gatewayGoverned: true }
  );
  assert.equal(postEnv.type, CE_TYPE_TOOL_CALL_AUTHORIZED);
  assert.notEqual(postEnv.type, CE_TYPE_TOOL_CALL_DENIED);
  assert.equal(postEnv.data.decision.enforce_active, false);
  assert.equal(postEnv.data.bn_corroborated_by, 'action_ledger');
});

test('buildToolCallEnvelopes: gatewayGoverned:true PostToolUseFailure stays AUTHORIZED with outcome.ok:false (runtime failure ≠ denial)', () => {
  const [postEnv] = buildToolCallEnvelopes(
    { hook_event_name: 'PostToolUseFailure', session_id: 's', tool_use_id: 'toolu_g', tool_name: 'mcp__noblecloak__x', error: 'boom' },
    null,
    { gatewayGoverned: true }
  );
  assert.equal(postEnv.type, CE_TYPE_TOOL_CALL_AUTHORIZED);
  assert.equal(postEnv.data.outcome.ok, false);
});

test('buildToolCallEnvelopes: gatewayGoverned:false (default, omitted opts) still returns the [pre, post] pair', () => {
  const input = {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-uuid',
    tool_use_id: 'toolu_9',
    tool_name: 'Bash',
    duration_ms: 3,
  };
  const pre = {
    tool_ref: 'tool:claude-code:bash',
    bn_invocation_channel: 'interactive',
    enforce: false,
    would_decision: 'allow',
    resolve: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' },
  };
  const [preEnv, postEnv] = buildToolCallEnvelopes(input, pre);
  assert.equal(preEnv.id, 'toolu_9:pre');
  assert.equal(postEnv.id, 'toolu_9:post');
  assert.equal('bn_corroborated_by' in preEnv.data, false);
  assert.equal('bn_corroborated_by' in postEnv.data, false);
});

test('buildToolCallEnvelopes: opts.ts threads through to both envelopes (regression: ts moved into opts)', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const [preEnv, postEnv] = buildToolCallEnvelopes(
    { hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 't', tool_name: 'Bash' },
    null,
    { gatewayGoverned: false, ts }
  );
  assert.equal(preEnv.time, ts);
  assert.equal(postEnv.time, ts);
});

test('buildSubagentEnvelope: started and stopped shapes', () => {
  const started = buildSubagentEnvelope({
    hook_event_name: 'SubagentStart',
    session_id: 's',
    agent_id: 'a1',
    agent_type: 'general-purpose',
    cwd: '/w',
  });
  assert.equal(started.type, CE_TYPE_SUBAGENT_STARTED);
  assert.equal(started.id, 'a1:started');
  assert.equal(started.data.agent_type, 'general-purpose');
  assert.equal('agent_transcript_path' in started.data, false);

  const stopped = buildSubagentEnvelope({
    hook_event_name: 'SubagentStop',
    session_id: 's',
    agent_id: 'a1',
    agent_transcript_path: '/t.jsonl',
  });
  assert.equal(stopped.type, CE_TYPE_SUBAGENT_STOPPED);
  assert.equal(stopped.id, 'a1:stopped');
  assert.equal(stopped.data.agent_transcript_path, '/t.jsonl');
});

// ── shipped ledger + drain (fabricated-success defense) ─────────────────────

test('markPreShipped/loadShippedSet round-trip; absent ledger → empty set', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  assert.equal(loadShippedSet(env).size, 0);
  markPreShipped('toolu_A', env);
  markPreShipped('toolu_B', env);
  markPreShipped('toolu_A', env); // dup append — Set dedups on read
  const set = loadShippedSet(env);
  assert.equal(set.has('toolu_A'), true);
  assert.equal(set.has('toolu_B'), true);
  assert.equal(set.size, 2);
});

test('readPreRecords: most-recent-wins per tool_use_id; non-Pre rows ignored', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'A', session_id: 's', tag: 'first' }, env);
  appendAuditRecord({ hook_event: 'PostToolUse', tool_use_id: 'A', session_id: 's' }, env); // ignored
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'A', session_id: 's', tag: 'second' }, env);
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'B', session_id: 's' }, env);
  const recs = readPreRecords(env);
  assert.equal(recs.length, 2);
  assert.equal(recs.find((r) => r.tool_use_id === 'A').tag, 'second');
});

test('drainUnshippedPreEnvelopes: ships only :pre for unshipped, session-bearing records', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  appendAuditRecord(
    { hook_event: 'PreToolUse', tool_use_id: 'A', session_id: 'sess', tool_ref: 'tool:claude-code:bash', would_decision: 'allow', resolve: { mode: 'always_allow', source: 'd', side_effect_level: 'read' } },
    env
  );
  appendAuditRecord(
    { hook_event: 'PreToolUse', tool_use_id: 'B', session_id: 'sess', tool_ref: 'tool:claude-code:bash', would_decision: 'deny', enforce: true, resolve: { mode: 'deny', source: 'policy', side_effect_level: 'delete' } },
    env
  );
  // A degraded early-exit record with no session_id cannot attach to a run.
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'C', session_id: null }, env);

  // B already shipped → only A drains.
  markPreShipped('B', env);
  const drained = drainUnshippedPreEnvelopes(env, '2026-06-09T00:00:00.000Z');
  assert.deepEqual(drained.map((d) => d.toolUseId).sort(), ['A']);
  const env0 = drained[0].envelope;
  assert.equal(env0.id, 'A:pre');
  assert.equal(env0.subject, 'sess');
  assert.equal(env0.type, CE_TYPE_TOOL_CALL_AUTHORIZED);
  assert.equal('outcome' in env0.data, false);
});

test('drainUnshippedPreEnvelopes: drained :pre envelope carries a surface block (parity with toolCallData, D5)', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  appendAuditRecord(
    { hook_event: 'PreToolUse', tool_use_id: 'A', session_id: 'sess', tool_ref: 'tool:claude-code:bash', would_decision: 'allow', resolve: { mode: 'always_allow', source: 'd', side_effect_level: 'read' } },
    env
  );
  const [drained] = drainUnshippedPreEnvelopes(env, '2026-07-09T00:00:00.000Z');
  assert.equal(typeof drained.envelope.data.surface, 'object');
  assert.equal('client_id' in drained.envelope.data.surface, false);
  assert.equal(typeof drained.envelope.data.surface.reported, 'string');
});

test('drainUnshippedPreEnvelopes: empty when everything is shipped or queue absent', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  assert.deepEqual(drainUnshippedPreEnvelopes(env), []);
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'A', session_id: 's' }, env);
  markPreShipped('A', env);
  assert.deepEqual(drainUnshippedPreEnvelopes(env), []);
});

// ── emitAuditEvent return status + guarded spill (findings #2, #3, #5) ──────

test('emitAuditEvent: no bearer token → spills and returns EMIT_SPILLED, no fetch', async () => {
  const stateDir = makeStateDir();
  // No NOBLECLOAK_DEV_TOKEN and no auth.json → getBearerToken returns null. The
  // function must spill WITHOUT attempting a POST (logged-out audit path).
  const env = { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_COO_URL: 'http://127.0.0.1:0' };
  const envelope = { id: 'toolu_X:pre', type: CE_TYPE_TOOL_CALL_AUTHORIZED };
  const status = await emitAuditEvent(envelope, env);
  assert.equal(status, EMIT_SPILLED, 'returns EMIT_SPILLED on the no-token branch');
  const spill = readFileSync(join(stateDir, 'audit-spill.jsonl'), 'utf-8').trim();
  assert.equal(JSON.parse(spill).id, 'toolu_X:pre', 'envelope was spilled');
});

test('emitAuditEvent: the logged-out path NEVER touches the breaker (load-bearing invariant)', async () => {
  // A logged-out session is NOT an outage: if the no-token path tripped the
  // breaker, the breaker would still be open the moment auth returns and would
  // fast-fail real deliveries until the cooldown elapsed — silently delaying
  // audit events at exactly the moment they should resume. Seed a near-trip
  // breaker (one failure short of the threshold, still closed) and prove that
  // several no-token emits never increment the failure run or open it.
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_COO_URL: 'http://127.0.0.1:0', NOBLECLOAK_AUDIT_BREAKER_THRESHOLD: '3' };
  recordBreakerFailure(env); // 1 of 3 — still closed
  recordBreakerFailure(env); // 2 of 3 — one short of tripping, still closed
  assert.equal(readBreaker(env).phase, 'closed', 'precondition: breaker is closed (near-trip)');
  assert.equal(readBreaker(env).failures, 2);

  for (let i = 0; i < 5; i += 1) {
    const status = await emitAuditEvent({ id: `toolu_nt${i}:pre` }, env);
    assert.equal(status, EMIT_SPILLED);
  }

  const after = readBreaker(env);
  assert.equal(after.phase, 'closed', 'no-token emits never opened the breaker');
  assert.equal(after.failures, 2, 'no-token emits never incremented the failure run');
  assert.equal(after.openedAt, null, 'breaker was never armed');
});

test('emitAuditEvent: honors the never-throws contract even when the spill write fails', async () => {
  const stateDir = makeStateDir();
  // Make the spill target unwritable so appendFileSync throws (ENOSPC/EACCES
  // analogue). emitAuditEvent must still NOT throw — finding #2.
  chmodSync(stateDir, 0o500);
  try {
    const env = { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_COO_URL: 'http://127.0.0.1:0' };
    const messages = [];
    const status = await emitAuditEvent({ id: 'x:pre' }, env, (m) => messages.push(m));
    assert.equal(status, EMIT_SPILLED);
    assert.ok(messages.some((m) => /spill write failed/.test(m)), 'a spill-write failure is logged, not thrown');
  } finally {
    chmodSync(stateDir, 0o700); // restore so the temp dir can be cleaned up
  }
});

// ── bounded retention: compactAuditQueueAndLedger (finding #1) ──────────────

test('compactAuditQueueAndLedger: keeps all unshipped+drainable Pre records', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  for (const id of ['A', 'B', 'C']) {
    appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: id, session_id: 's' }, env);
  }
  // None shipped — compaction must keep every drainable record (nothing to gain).
  const { compacted } = compactAuditQueueAndLedger(env);
  assert.equal(compacted, false, 'no-op when nothing is prunable');
  assert.deepEqual(readPreRecords(env).map((r) => r.tool_use_id).sort(), ['A', 'B', 'C']);
});

test('compactAuditQueueAndLedger: prunes shipped Pre records beyond the retention tail', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  const N = AUDIT_SHIPPED_RETENTION + 30;
  for (let i = 0; i < N; i += 1) {
    appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: `s${i}`, session_id: 'sess' }, env);
    markPreShipped(`s${i}`, env);
  }
  // One unshipped, drainable record must always survive.
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'live', session_id: 'sess' }, env);

  const { compacted } = compactAuditQueueAndLedger(env);
  assert.equal(compacted, true);
  const ids = readPreRecords(env).map((r) => r.tool_use_id);
  assert.ok(ids.includes('live'), 'the unshipped record is never pruned');
  // The shipped tail is bounded.
  const shippedSurvivors = ids.filter((id) => id !== 'live');
  assert.ok(shippedSurvivors.length <= AUDIT_SHIPPED_RETENTION, `shipped tail bounded to ${AUDIT_SHIPPED_RETENTION}`);
  // The ledger never outgrows the compacted queue.
  assert.ok(loadShippedSet(env).size <= readPreRecords(env).length, 'ledger does not outgrow the queue');
});

test('compactAuditQueueAndLedger: caps undrainable (session-less) degraded records', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  const N = AUDIT_UNDRAINABLE_RETENTION + 20;
  for (let i = 0; i < N; i += 1) {
    appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: `d${i}`, session_id: null }, env);
  }
  // Force a prunable state with at least one drainable survivor so compaction runs.
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'live', session_id: 's' }, env);
  const { compacted } = compactAuditQueueAndLedger(env);
  assert.equal(compacted, true);
  const records = readPreRecords(env);
  const undrainable = records.filter((r) => typeof r.session_id !== 'string');
  assert.ok(undrainable.length <= AUDIT_UNDRAINABLE_RETENTION, 'undrainable degraded records are capped');
  assert.ok(records.some((r) => r.tool_use_id === 'live'), 'drainable survivor kept');
});

test('compactAuditQueueAndLedger: absent queue → no-op', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  assert.deepEqual(compactAuditQueueAndLedger(env), { compacted: false });
});

test('compactAuditQueueAndLedger: never injects an unshipped id into the ledger (drain stays live) — finding #2', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  // >AUDIT_SHIPPED_RETENTION shipped records to force compaction…
  const N = AUDIT_SHIPPED_RETENTION + 5;
  for (let i = 0; i < N; i += 1) {
    appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: `s${i}`, session_id: 'sess' }, env);
    markPreShipped(`s${i}`, env);
  }
  // …plus one never-shipped, drainable record.
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'LIVE', session_id: 'sess' }, env);

  assert.equal(loadShippedSet(env).has('LIVE'), false, 'precondition: LIVE is not shipped');
  const beforeDrain = drainUnshippedPreEnvelopes(env).map((e) => e.toolUseId);
  assert.ok(beforeDrain.includes('LIVE'), 'precondition: LIVE drains before compaction');

  const { compacted } = compactAuditQueueAndLedger(env);
  assert.equal(compacted, true);

  // The regression: compaction must NOT mark the unshipped, surviving Pre as
  // shipped. If it does, loadShippedSet flips to true and the drain skips it
  // forever — the fabricated-success defense silently breaks.
  assert.equal(loadShippedSet(env).has('LIVE'), false, 'unshipped id never enters the ledger');
  const afterDrain = drainUnshippedPreEnvelopes(env).map((e) => e.toolUseId);
  assert.ok(afterDrain.includes('LIVE'), 'LIVE is still drainable after compaction');
});

test('compactAuditQueueAndLedger: a recently-shipped Pre survives and stays joinable; oldest is pruned (direction) — finding #5', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  // N = retention + k shipped records, in order s0 (oldest) … s{N-1} (newest).
  const k = 10;
  const N = AUDIT_SHIPPED_RETENTION + k;
  for (let i = 0; i < N; i += 1) {
    appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: `s${i}`, session_id: 'sess' }, env);
    markPreShipped(`s${i}`, env);
  }
  // One unshipped drainable record so compaction has something to gain.
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'live', session_id: 'sess' }, env);

  const { compacted } = compactAuditQueueAndLedger(env);
  assert.equal(compacted, true);

  // The join buffer keeps the TAIL: the most-recently-shipped record survives
  // and a late Post can still find its Pre…
  const newest = `s${N - 1}`;
  assert.ok(findPreRecord(newest, env), 'most-recently-shipped Pre is retained (joinable)');
  // …and the OLDEST shipped record is the one that gets pruned (direction).
  assert.equal(findPreRecord('s0', env), null, 'oldest shipped Pre is pruned');
});

test('boundAuditSpill (via compaction): caps audit-spill.jsonl to a recent tail — finding #3', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  // Over-fill the spill well past the cap.
  const N = AUDIT_SPILL_RETENTION + 50;
  for (let i = 0; i < N; i += 1) {
    spillAuditEvent({ id: `e${i}:pre` }, env);
  }
  // A drainable record so compaction proper runs too (spill bounding runs
  // regardless, but this proves it happens within the same compaction pass).
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'live', session_id: 's' }, env);
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'shipped', session_id: 's' }, env);
  markPreShipped('shipped', env);
  for (let i = 0; i < AUDIT_SHIPPED_RETENTION + 1; i += 1) {
    appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: `x${i}`, session_id: 's' }, env);
    markPreShipped(`x${i}`, env);
  }

  compactAuditQueueAndLedger(env);

  const spillFile = join(stateDir, 'audit-spill.jsonl');
  assert.ok(existsSync(spillFile));
  const spillRecords = readFileSync(spillFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const dataRecords = spillRecords.filter((r) => !r.bn_degraded);
  assert.ok(dataRecords.length <= AUDIT_SPILL_RETENTION, `spill data bounded to ${AUDIT_SPILL_RETENTION}`);
  // The trim now surfaces a countable degraded marker (brief 2026-06-15 D4) — so
  // the drop is visible, not silent.
  assert.ok(
    spillRecords.some((r) => r.bn_degraded && r.degraded_reason === 'spill-cap-trimmed'),
    'a spill-cap-trimmed degraded marker is surfaced'
  );
  // The retained window is the most-recent tail — the newest record survives,
  // the oldest is dropped.
  const ids = dataRecords.map((r) => r.id);
  assert.ok(ids.includes(`e${N - 1}:pre`), 'newest spill record retained');
  assert.ok(!ids.includes('e0:pre'), 'oldest spill record dropped');
});

test('compactAuditQueueAndLedger: aborts (no clobber) when the queue grows after the snapshot — finding #1/#4', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  // Force a prunable state: > retention shipped records plus one unshipped.
  for (let i = 0; i < AUDIT_SHIPPED_RETENTION + 5; i += 1) {
    appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: `s${i}`, session_id: 'sess' }, env);
    markPreShipped(`s${i}`, env);
  }
  appendAuditRecord({ hook_event: 'PreToolUse', tool_use_id: 'live', session_id: 'sess' }, env);

  // Hold the compaction lock so the real compaction is forced down the
  // skip-when-locked path, simulating a concurrent worker.
  const lockPath = join(stateDir, 'audit-compact.lock');
  writeFileSync(lockPath, 'someone-else');
  const { compacted } = compactAuditQueueAndLedger(env);
  assert.equal(compacted, false, 'a held lock makes compaction a best-effort no-op');
  // The unshipped record is untouched (never clobbered).
  assert.ok(readPreRecords(env).some((r) => r.tool_use_id === 'live'));
});

test('hooks.json wires all four post-side events to the dispatcher (no timeout)', () => {
  const hooks = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop']) {
    const block = hooks.hooks[event]?.[0];
    assert.ok(block, `${event} block present`);
    const cmd = block.hooks[0];
    assert.match(cmd.command, /post-events\.mjs/, `${event} → post-events dispatcher`);
    assert.equal(cmd.timeout, undefined, `${event} post hook is non-blocking — no timeout`);
  }
  // Tool post-events share the PreToolUse matcher; subagent events match all.
  assert.equal(hooks.hooks.PostToolUse[0].matcher, hooks.hooks.PreToolUse[0].matcher);
  assert.equal(hooks.hooks.PostToolUseFailure[0].matcher, hooks.hooks.PreToolUse[0].matcher);
  assert.equal(hooks.hooks.SubagentStart[0].matcher, '*');
  assert.equal(hooks.hooks.SubagentStop[0].matcher, '*');
});

// ── drain-lock stale window vs. the worker watchdog deadline ─────────────────
//
// The drain-lock stale window is DERIVED from workerDeadlineMs() (not a hardcoded
// constant) so the invariant "stale window >= watchdog deadline" survives an env
// override. If it were hardcoded at 10s, raising NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS
// would let a second worker steal a still-live drain holder's lock as "stale"
// before the holder can even be killed — re-introducing the concurrent re-ship the
// single-flight lock exists to prevent (the meltdown driver).

test('drain lock: a raised worker deadline keeps a live holder lock UNSTEALABLE (no concurrent drain)', () => {
  const stateDir = makeStateDir();
  // Operator raises the watchdog deadline far above the old hardcoded 10s window.
  const env = { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS: '60000' };

  const held = acquireDrainLock(env);
  assert.ok(held, 'first worker takes the drain lock');

  // Backdate the lockfile mtime to ~30s old — well past the OLD hardcoded 10s
  // window, but still under the now-60s watchdog deadline, so the holder is still
  // provably alive and the lock must NOT be steal-eligible.
  const lockPath = join(stateDir, 'audit-drain.lock');
  const ageSec = (Date.now() - 30_000) / 1000;
  utimesSync(lockPath, ageSec, ageSec);

  const second = acquireDrainLock(env);
  assert.equal(second, null, 'a 30s-old lock is NOT stale under a 60s deadline — second worker cannot drain concurrently');
  assert.ok(existsSync(lockPath), 'the live holder lock was not stolen');

  releaseDrainLock(held);
  assert.equal(existsSync(lockPath), false, 'holder released its own lock');
});

test('drain lock: the stale window tracks the deadline so a genuinely-dead holder IS reclaimed', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir, NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS: '5000' };
  // The floor (10s) clamps below; with a 5s deadline the effective window is 10s.
  assert.equal(workerDeadlineMs(env), 5000, 'deadline accessor honors the override');

  acquireDrainLock(env); // leak it (simulate a crashed holder)
  const lockPath = join(stateDir, 'audit-drain.lock');
  const ageSec = (Date.now() - 120_000) / 1000; // 2 min old → past any window
  utimesSync(lockPath, ageSec, ageSec);

  // A genuinely-stale lock is stolen (removed) but tryAcquireLock returns null on
  // the steal round — the NEXT acquire then succeeds.
  assert.equal(acquireDrainLock(env), null, 'the steal round itself does not re-acquire');
  assert.equal(existsSync(lockPath), false, 'the dead holder lock was reclaimed');
  const next = acquireDrainLock(env);
  assert.ok(next, 'a follow-up acquire succeeds once the stale lock is gone');
  releaseDrainLock(next);
});

// ── recordWorkerDegraded (brief 2026-06-15 D3) ──────────────────────────────

test('recordWorkerDegraded: spills a countable worker-side degraded marker', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  recordWorkerDegraded('worker-deadline', env);

  const records = readFileSync(join(stateDir, 'audit-spill.jsonl'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(records.length, 1, 'exactly one marker');
  const m = records[0];
  assert.equal(m.bn_degraded, true);
  assert.equal(m.degraded_side, 'worker');
  assert.equal(m.degraded_reason, 'worker-deadline');
  assert.equal(typeof m.time, 'string');
});

test('recordWorkerDegraded: NEVER throws even when the state dir is unwritable (degraded-FS contract)', () => {
  const stateDir = makeStateDir();
  const env = { NOBLECLOAK_STATE_DIR: stateDir };
  // Make the state dir read-only so the spill append fails — exactly the degraded
  // condition this helper fires under. It must swallow the failure, not throw
  // (a throw would surface as an uncaught exception in the watchdog timer).
  chmodSync(stateDir, 0o500);
  try {
    assert.doesNotThrow(() => recordWorkerDegraded('x', env), 'no-throw contract holds on an unwritable FS');
  } finally {
    chmodSync(stateDir, 0o700); // restore so the temp dir can be cleaned up
  }
});

// ── resolveResourceIndicator (RFC 8707) ─────────────────────────────────
//
// The plugin's /authorize call omitted the `resource` parameter entirely, so
// core's AS silently defaulted the bound audience
// (`audience: code.resource ?? deps.resourceId`). The minted token therefore
// LOOKED correctly bound (`aud: https://mcp.<host>`, no `resource` claim) while
// the request was non-conformant — invisible to every resource-server-side log.
// Under AS_ENFORCE_RESOURCE_INDICATOR=true that request is rejected outright
// with `invalid_target`, which would break /noblecloak-login.
//
// The indicator is DERIVED from .mcp.json's server URL (origin, no path) rather
// than hardcoded, so dev/beta/prod each resolve their own without a literal
// that can drift from core's MCP_RESOURCE_ID allowlist.

test('resolveResourceIndicator derives the MCP server ORIGIN from .mcp.json (drops the /v1/mcp path)', () => {
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  writeFileSync(
    env.NOBLECLOAK_MCP_FILE,
    JSON.stringify({
      mcpServers: { noblecloak: { type: 'http', url: 'https://mcp.noblecloak.com/v1/mcp' } },
    })
  );
  assert.equal(resolveResourceIndicator(env), 'https://mcp.noblecloak.com');
});

test('resolveResourceIndicator honours an explicit NOBLECLOAK_MCP_RESOURCE override', () => {
  const env = {
    NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json'),
    NOBLECLOAK_MCP_RESOURCE: 'https://mcp.example.test',
  };
  writeFileSync(
    env.NOBLECLOAK_MCP_FILE,
    JSON.stringify({
      mcpServers: { noblecloak: { type: 'http', url: 'https://mcp.example.test/v1/mcp' } },
    })
  );
  assert.equal(resolveResourceIndicator(env), 'https://mcp.example.test');
});

test('resolveResourceIndicator returns null when .mcp.json is absent or has no noblecloak server', () => {
  const missing = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  assert.equal(resolveResourceIndicator(missing), null);

  const empty = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  writeFileSync(empty.NOBLECLOAK_MCP_FILE, JSON.stringify({ mcpServers: {} }));
  assert.equal(resolveResourceIndicator(empty), null);
});

test('resolveResourceIndicator returns null for a malformed server url rather than throwing', () => {
  // Never crash /noblecloak-login over a bad config: omitting the param restores
  // exactly today's (pre-enforcement) behaviour instead of failing the login.
  const env = { NOBLECLOAK_MCP_FILE: join(makeStateDir(), 'mcp.json') };
  writeFileSync(
    env.NOBLECLOAK_MCP_FILE,
    JSON.stringify({ mcpServers: { noblecloak: { type: 'http', url: 'not-a-url' } } })
  );
  assert.equal(resolveResourceIndicator(env), null);
});
