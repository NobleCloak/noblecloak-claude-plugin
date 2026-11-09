/**
 * Test helpers — local stub HTTP server (spike pattern) + hook child-process
 * runner. node: built-ins only.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(__dirname);
export const HOOK_PATH = join(REPO_ROOT, 'scripts', 'hooks', 'pre-tool-use.mjs');
export const POST_EVENTS_PATH = join(REPO_ROOT, 'scripts', 'hooks', 'post-events.mjs');
export const POST_EVENTS_WORKER_PATH = join(REPO_ROOT, 'scripts', 'hooks', 'post-events-worker.mjs');
export const REFRESH_PATH = join(REPO_ROOT, 'scripts', 'refresh.mjs');
export const PROPOSE_TOOL_PATH = join(REPO_ROOT, 'scripts', 'propose-tool.mjs');

/**
 * Stub COO + auth + Config API server. Records every request; behavior is
 * configurable via `stub.resolveResponses` (array of { status, body } or
 * { status, rawBody } consumed per call; last one repeats), `stub.hang`
 * (never respond to anything), `stub.hangPaths` (never respond to specific
 * paths), `stub.tokenStatus`, `stub.tokenErrorBody` (JSON body for non-200
 * token responses), `stub.tokenRawBody` (raw — possibly non-JSON — token
 * response body), `stub.discoveryDoc`, and `stub.discoveryRawBody`.
 */
export async function startStub() {
  const stub = {
    requests: [],
    resolveResponses: [{ status: 200, body: { mode: 'always_allow', source: 'default_side_effect', side_effect_level: 'read' } }],
    tokenResponse: { access_token: 'refreshed-token', refresh_token: 'refreshed-refresh', expires_in: 3600 },
    tokenStatus: 200,
    tokenErrorBody: null, // JSON error body for non-200 token responses
    tokenRawBody: null, // raw (possibly non-JSON) token response body
    discoveryDoc: null, // override the default discovery doc
    discoveryRawBody: null, // raw (possibly non-JSON) discovery body
    // DCR (POST /auth/oauth/register) — RFC 7591 returns 201 Created.
    registerStatus: 201,
    registerResponse: { client_id: 'dcr-generated-id', redirect_uris: ['http://localhost:19284/callback'], token_endpoint_auth_method: 'none' },
    registerErrorBody: null,
    eventStatus: 200, // status for POST /v1/coo/local/events
    eventBody: { ok: true }, // JSON body for POST /v1/coo/local/events
    eventErrorBody: null, // JSON body for a non-2xx events response (default { error: 'ingest-failed' })
    // POST /v1/approvals (govern module API) — { status, body, contentType }.
    approvalsResponse: { status: 201, body: { data: { id: 'apr_test_1', state: 'pending', created: true }, meta: {} } },
    capabilitiesResponse: null, // GET /v1/capabilities — { status, body }; null = 404
    hang: false,
    hangPaths: [],
    resolveCallCount: 0,
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      let body = null;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        body = rawBody;
      }
      stub.requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
        rawBody,
      });

      // never respond — exercise client timeouts (globally or per path)
      if (stub.hang || stub.hangPaths.includes(req.url)) return;

      if (req.method === 'GET' && req.url === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (stub.discoveryRawBody !== null) {
          res.end(stub.discoveryRawBody);
          return;
        }
        res.end(
          JSON.stringify(
            stub.discoveryDoc ?? {
              issuer: stub.url,
              authorization_endpoint: `${stub.url}/auth/oauth/authorize`,
              token_endpoint: `${stub.url}/auth/oauth/token`,
            }
          )
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/auth/oauth/token') {
        res.writeHead(stub.tokenStatus, { 'Content-Type': 'application/json' });
        if (stub.tokenRawBody !== null) {
          res.end(stub.tokenRawBody);
          return;
        }
        res.end(
          JSON.stringify(
            stub.tokenStatus === 200 ? stub.tokenResponse : (stub.tokenErrorBody ?? { error: 'server_error' })
          )
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/coo/local/resolve') {
        const idx = Math.min(stub.resolveCallCount, stub.resolveResponses.length - 1);
        stub.resolveCallCount += 1;
        const { status, body: resBody, rawBody: resRaw } = stub.resolveResponses[idx];
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(resRaw !== undefined ? resRaw : JSON.stringify(resBody ?? {}));
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/coo/local/events') {
        res.writeHead(stub.eventStatus, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(stub.eventStatus < 300 ? stub.eventBody : (stub.eventErrorBody ?? { error: 'ingest-failed' }))
        );
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/capabilities' && stub.capabilitiesResponse) {
        res.writeHead(stub.capabilitiesResponse.status, { 'Content-Type': 'application/json' });
        res.end(stub.capabilitiesResponse.rawBody ?? JSON.stringify(stub.capabilitiesResponse.body ?? {}));
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/approvals') {
        const { status, body: apBody, contentType } = stub.approvalsResponse;
        res.writeHead(status, { 'Content-Type': contentType ?? 'application/json' });
        res.end(JSON.stringify(apBody ?? {}));
        return;
      }

      if (req.method === 'POST' && req.url === '/auth/oauth/register') {
        res.writeHead(stub.registerStatus, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            stub.registerStatus < 300
              ? stub.registerResponse
              : (stub.registerErrorBody ?? { error: 'invalid_client_metadata' })
          )
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.resolveRequests = () => stub.requests.filter((r) => r.path === '/v1/coo/local/resolve');
  stub.eventRequests = () => stub.requests.filter((r) => r.path === '/v1/coo/local/events');
  // Poll until at least `count` event POSTs have landed, or `timeoutMs` elapses.
  // Fire-and-forget POSTs land AFTER the hook process exits, so callers cannot
  // rely on requests being present the instant runHook resolves.
  stub.waitForEvents = async (count, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (stub.eventRequests().length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return stub.eventRequests();
  };
  stub.close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return stub;
}

export function makeStateDir() {
  return mkdtempSync(join(tmpdir(), 'noblecloak-hook-test-'));
}

/** Baseline PreToolUse hook input (Claude Code 2.1.165 shape). */
export function hookInput(overrides = {}) {
  return {
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/project/file.txt' },
    tool_use_id: 'toolu_0123456789',
    ...overrides,
  };
}

/** Baseline PostToolUse hook input (Claude Code 2.1.165 shape). */
export function postToolUseInput(overrides = {}) {
  return {
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { stdout: 'hi\n', stderr: '', exitCode: 0 },
    tool_use_id: 'toolu_0123456789',
    duration_ms: 12,
    ...overrides,
  };
}

/** Baseline PostToolUseFailure hook input (Claude Code 2.1.165 shape). */
export function postToolUseFailureInput(overrides = {}) {
  return {
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    permission_mode: 'default',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'false' },
    error: 'command exited with code 1',
    is_interrupt: false,
    tool_use_id: 'toolu_0123456789',
    duration_ms: 9,
    ...overrides,
  };
}

/** Baseline SubagentStart hook input (Claude Code 2.1.165 shape). */
export function subagentStartInput(overrides = {}) {
  return {
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'SubagentStart',
    agent_id: 'agent_abc123',
    agent_type: 'general-purpose',
    ...overrides,
  };
}

/** Baseline SubagentStop hook input (Claude Code 2.1.165 shape). */
export function subagentStopInput(overrides = {}) {
  return {
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    permission_mode: 'default',
    stop_hook_active: false,
    hook_event_name: 'SubagentStop',
    agent_id: 'agent_abc123',
    agent_type: 'general-purpose',
    agent_transcript_path: '/tmp/agent-transcript.jsonl',
    last_assistant_message: 'done',
    ...overrides,
  };
}

/**
 * Seed an audit-queue record (the Pre-side decision record brief #4 appends).
 * Writes through the real appendAuditRecord so the on-disk shape matches.
 */
export async function seedAuditRecord(stateDir, record) {
  const { appendAuditRecord } = await import('../scripts/lib/governance.mjs');
  appendAuditRecord(record, { NOBLECLOAK_STATE_DIR: stateDir });
}

/**
 * Run the hook script as a child process with JSON (or a raw string) on stdin.
 * env: extra env vars. The child env is deliberately minimal so host
 * NOBLECLOAK_* / CLAUDE_* vars never leak into tests.
 */
export function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      let output = null;
      try {
        output = JSON.parse(stdout);
      } catch {
        // leave null — tests assert
      }
      resolve({ code, stdout, stderr, output });
    });
    child.stdin.write(typeof input === 'string' ? input : JSON.stringify(input));
    child.stdin.end();
  });
}

/**
 * Run the post-events dispatcher as a child process with JSON (or a raw
 * string) on stdin. Resolves { code, stdout, stderr, output, elapsedMs }.
 * `elapsedMs` is wall-clock from spawn to child exit — the non-blocking
 * guarantee asserts on it (the dispatcher must exit fast even when the ingest
 * stub hangs, because the POST is fire-and-forget).
 */
export function runPostEvents(input, env = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [POST_EVENTS_PATH], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      let output = null;
      try {
        output = JSON.parse(stdout);
      } catch {
        // leave null — post hooks need not emit hookSpecificOutput
      }
      resolve({ code, stdout, stderr, output, elapsedMs: Date.now() - startedAt });
    });
    child.stdin.write(typeof input === 'string' ? input : JSON.stringify(input));
    child.stdin.end();
  });
}

export function readSpillRecords(stateDir) {
  const file = join(stateDir, 'audit-spill.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** tool_use_ids recorded in the shipped ledger (audit-sent.jsonl). */
export function readSentIds(stateDir) {
  const file = join(stateDir, 'audit-sent.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).tool_use_id);
}

/**
 * Poll the shipped ledger until it holds at least `count` ids or `timeoutMs`
 * elapses. The detached worker ledgers a :pre only AFTER its POST's response
 * arrives (and after the delivery bookkeeping), while the stub records the
 * request BEFORE responding — so `stub.waitForEvents` returning does not mean
 * the ledger is written yet. Same reason waitForSpill exists.
 */
export async function waitForSentIds(stateDir, count, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let ids = readSentIds(stateDir);
  while (ids.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    ids = readSentIds(stateDir);
  }
  return ids;
}

/** audit-queue.jsonl Pre records (raw rows, in file order). */
export function readQueueRecords(stateDir) {
  const file = join(stateDir, 'audit-queue.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Poll the spill file until it holds at least `count` records or `timeoutMs`
 * elapses. The detached worker spills AFTER the dispatcher exits, so callers
 * cannot rely on the spill being present the instant runPostEvents resolves.
 */
export async function waitForSpill(stateDir, count, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let records = readSpillRecords(stateDir);
  while (records.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    records = readSpillRecords(stateDir);
  }
  return records;
}

/**
 * Run the detached worker (post-events-worker.mjs) DIRECTLY with a given argv
 * (the payload path, or nothing). Isolates the worker's own defensive branches
 * from the dispatcher. Resolves { code, stdout, stderr }.
 */
export function runWorker(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [POST_EVENTS_WORKER_PATH, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Run an arbitrary plugin script (e.g. scripts/refresh.mjs) as a child
 * process with a minimal env. Resolves { code, stdout, stderr }.
 */
export function runScript(scriptPath, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function decisionOf(result) {
  return result.output?.hookSpecificOutput?.permissionDecision;
}

export function readAuditRecords(stateDir) {
  const file = join(stateDir, 'audit-queue.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Standard env for a hook run against the stub with the dev-token override. */
export function stubEnv(stub, stateDir, extra = {}) {
  return {
    NOBLECLOAK_COO_URL: stub.url,
    NOBLECLOAK_ISSUER: stub.url,
    NOBLECLOAK_STATE_DIR: stateDir,
    // Keep the hook away from any real .mcp.json at the repo root — the
    // noblecloak-MCP-server allowlist derives from this file.
    NOBLECLOAK_MCP_FILE: join(stateDir, 'mcp.json'),
    NOBLECLOAK_DEV_TOKEN: 'test-dev-token',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ...extra,
  };
}
