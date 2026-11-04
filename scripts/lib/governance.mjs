/**
 * Shared governance + auth library for the NobleCloak Claude Code plugin.
 *
 * Consumed by:
 *   - scripts/hooks/pre-tool-use.mjs  (PreToolUse governance adapter — ADR-0033 §9 plugin adapter)
 *   - scripts/login.mjs / scripts/refresh.mjs / scripts/status.mjs  (auth-state + OAuth discovery)
 *   - the PostToolUse/Subagent audit emitter (scripts/hooks/post-events.mjs +
 *     post-events-worker.mjs, epic brief #5) — reads the per-call records
 *     appended to the audit queue (see AUDIT RECORD CONTRACT below) and ships
 *     them via the emission helpers in this file's "Audit-event emission" section.
 *
 * Plain Node ESM, `node:` built-ins only, zero runtime dependencies — this runs
 * on customer laptops.
 *
 * Pinned to Claude Code ≥ 2.1.165 hook-input shapes (local-exec hook surface
 * verification spike, 2026-06-05).
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Plugin root = repo root (this file lives at scripts/lib/). */
export const PLUGIN_ROOT = dirname(dirname(__dirname));

// ── Configuration ─────────────────────────────────────────────────────────
//
// All env knobs, in one place:
//
//   NOBLECLOAK_ISSUER          OAuth issuer / API host. Discovery doc lives at
//                            {issuer}/.well-known/oauth-authorization-server.
//                            Default: the production API host,
//                            https://api.noblecloak.com (Core is the OAuth 2.1
//                            AS, packaged inside the core API).
//   NOBLECLOAK_COO_URL         COO API base for governance resolve. The resolve
//                            endpoint is {base}/v1/coo/local/resolve. Default:
//                            the same production API host, where the COO API
//                            is served under /v1/coo.
//   The hooks and scripts use another deployment (a non-production one
//   included) when these two, NOBLECLOAK_GOVERN_URL and NOBLECLOAK_MCP_FILE are
//   set; Claude Code's own MCP connection reads the committed .mcp.json.
//   NOBLECLOAK_LOCAL_ENFORCE   'true'/'1' flips the PreToolUse adapter from
//                            audit-only (default) to enforce mode.
//   NOBLECLOAK_DEV_TOKEN       DEV-ONLY bearer-token override while Core OAuth AS
//                            Stage 4 (/token) is pending. Takes precedence over
//                            <state dir>/auth.json. Never set this in real use.
//   NOBLECLOAK_RESOLVE_TIMEOUT_MS  Per-attempt resolve timeout (default 1500ms;
//                            ADR-0033 §8 budget ≈1–2s).
//   NOBLECLOAK_STATE_DIR       Override for the plugin-local state dir (auth.json,
//                            audit-queue.jsonl). Default: ~/.noblecloak/claude-plugin.
//                            Primarily for tests.
//   NOBLECLOAK_MCP_FILE        Override for the .mcp.json path. Default:
//                            $PLUGIN_ROOT/.mcp.json. Primarily for tests.
//   NOBLECLOAK_SDK_HOOK_ACTIVE Dedup marker set by the future Agent SDK adapter
//                            (epic brief #7) — when present the plugin hook
//                            no-ops to avoid double-fire (spike Q3 finding).

export const DEFAULT_ISSUER = 'https://api.noblecloak.com';
export const DEFAULT_COO_URL = 'https://api.noblecloak.com';
export const DEFAULT_RESOLVE_TIMEOUT_MS = 1500;
export const RESOLVE_PATH = '/v1/coo/local/resolve';
/** Audit-event ingest endpoint (brief #5 emitter; brief #3 owns the route). */
export const EVENTS_PATH = '/v1/coo/local/events';
/**
 * Printed by /noblecloak-login before it opens the browser. The deployment
 * provisions a person who signs in for the first time in the same OAuth flow: a
 * user and, when the identity provider supplies a name (the usual case), a
 * personal workspace with the sign-up entitlements. There is no separate
 * registration page.
 */
export const FIRST_SIGN_IN_NOTE =
  'If you do not have a NobleCloak account yet, signing in creates one, with a personal workspace.';

export function issuerBaseUrl(env = process.env) {
  return stripTrailingSlash(env.NOBLECLOAK_ISSUER || DEFAULT_ISSUER);
}

export function cooBaseUrl(env = process.env) {
  return stripTrailingSlash(env.NOBLECLOAK_COO_URL || DEFAULT_COO_URL);
}

export function isEnforceMode(env = process.env) {
  const v = String(env.NOBLECLOAK_LOCAL_ENFORCE || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function resolveTimeoutMs(env = process.env) {
  const v = Number.parseInt(env.NOBLECLOAK_RESOLVE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RESOLVE_TIMEOUT_MS;
}

/**
 * Cumulative wall-clock budget for everything the PreToolUse hook does on the
 * network (resolve attempt #1 + OAuth discovery + token refresh + resolve
 * attempt #2). MUST stay comfortably under the hooks.json PreToolUse `timeout`
 * (5s): if the host kills the hook before it emits, no decision JSON is
 * written at all and the enforce-mode fail-closed guarantee is voided (the
 * host's hook-timeout default applies instead). Guarded by a test against
 * hooks.json.
 */
export const DEFAULT_TOTAL_BUDGET_MS = 4000;

/**
 * Clamp a per-attempt timeout to the time remaining before `deadline`
 * (epoch ms). No deadline → the per-attempt timeout as-is. Never negative.
 */
export function remainingBudgetMs(deadline, perAttemptMs, now = Date.now) {
  if (!deadline) return perAttemptMs;
  return Math.max(0, Math.min(perAttemptMs, deadline - now()));
}

/**
 * Clock for the resolve budget checkpoints. Production always returns the live
 * `Date.now`. TEST SEAM: when NOBLECLOAK_TEST_BUDGET_NOW_OFFSETS is set (a
 * comma-separated list of ms offsets, e.g. "0,5000"), successive calls return
 * `Date.now() + offset[i]` with the last offset sticky. This lets a test
 * simulate elapsed wall-clock at each checkpoint and deterministically
 * exercise the otherwise-unreachable 'budget-exhausted' guard: a successful
 * refresh always completes strictly before the real cumulative deadline, so
 * under real time the post-refresh budget is never <= 0.
 */
export function budgetClock(env = process.env) {
  const raw = env.NOBLECLOAK_TEST_BUDGET_NOW_OFFSETS;
  if (!raw) return Date.now;
  const offsets = raw
    .split(',')
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  if (offsets.length === 0) return Date.now;
  let i = 0;
  return () => Date.now() + offsets[Math.min(i++, offsets.length - 1)];
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

// ── Plugin-local state (auth.json, audit queue) ───────────────────────────

/**
 * Where the plugin keeps auth.json, client.json and the audit files: a stable
 * per-user directory, so a plugin rename or version bump (which changes
 * PLUGIN_ROOT) does not orphan them. `NOBLECLOAK_STATE_DIR` overrides it.
 * `~/.noblecloak/` also holds another tool's `beta-*` profile directories, hence
 * the subdirectory.
 */
export function stateDir(env = process.env) {
  return env.NOBLECLOAK_STATE_DIR || defaultStateDir();
}

export function defaultStateDir(home = homedir()) {
  return join(home, '.noblecloak', 'claude-plugin');
}

export function authFilePath(env = process.env) {
  return join(stateDir(env), 'auth.json');
}

export function auditQueuePath(env = process.env) {
  return join(stateDir(env), 'audit-queue.jsonl');
}

/**
 * Forensic spill for audit envelopes that failed to reach ingest (network
 * down, non-2xx). Degraded periods stay reconstructable from this file even
 * though v1 does not replay it (brief #5 out-of-scope: upload-on-recovery).
 */
export function auditSpillPath(env = process.env) {
  return join(stateDir(env), 'audit-spill.jsonl');
}

/**
 * Shipped-ledger: one tool_use_id per line for every Pre-side decision whose
 * `:pre` envelope has already been handed to ingest (POSTed or spilled). The
 * drain (drainUnshippedPreEnvelopes) consults this so the fabricated-success
 * defense never re-ships a Pre that already went out as part of a normal
 * pre+post pair, and never double-ships across drains. Append-only JSONL,
 * `{ tool_use_id }` per line — same best-effort posture as the audit queue.
 */
export function auditSentPath(env = process.env) {
  return join(stateDir(env), 'audit-sent.jsonl');
}

export function ensureStateDir(env = process.env) {
  const dir = stateDir(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ── One-time migration from an earlier state location ─────────────────────
//
// Earlier versions kept the state in `<PLUGIN_ROOT>/.local` (a directory-source
// install: the source checkout; a marketplace install: the versioned cache
// directory). Files moved from there; lock files stay (they belong to a live
// process).

/** State files moved by the migration, `auth.json` first (the smallest sign-in gap). */
export const MIGRATED_STATE_FILES = Object.freeze([
  'auth.json',
  'client.json',
  'signed-out.json',
  'refresh-backoff.json',
  'notices.json',
  'auth-401.json',
  'audit-queue.jsonl',
  'audit-spill.jsonl',
  'audit-sent.jsonl',
  'audit-dead.jsonl',
  'audit-runs.json',
  'audit-health.json',
  'audit-breaker.json',
]);

export const MIGRATION_MARKER = 'migrated-from';

/**
 * Moves one file to mode 0600. Across filesystems (EXDEV) the content is written
 * to a 0600 temp name in the destination directory, the source is unlinked, and
 * only then is the temp renamed into place; if the source cannot be unlinked the
 * temp is removed and the error thrown, so the destination never holds a copy of
 * a file the caller was told was not moved.
 */
function moveStateFile(from, to) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const tmp = `${to}.migrating-${process.pid}`;
    writeFileSync(tmp, readFileSync(from), { mode: 0o600, flag: 'w' });
    try {
      unlinkSync(from);
    } catch (unlinkErr) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw unlinkErr;
    }
    renameSync(tmp, to);
  }
  chmodSync(to, 0o600);
}

/** Earlier state directories that exist: `NOBLECLOAK_MIGRATE_FROM`, then `<pluginRoot>/.local`, de-duplicated. */
function legacyCandidates({ env, pluginRoot }) {
  const out = [];
  const add = (dir) => {
    if (dir && existsSync(dir) && !out.some((c) => c.dir === dir)) out.push({ dir });
  };
  add(env.NOBLECLOAK_MIGRATE_FROM);
  add(join(pluginRoot, '.local'));
  return out;
}

/**
 * Move the sign-in state of an earlier install into the stable state directory,
 * once. A no-op when `NOBLECLOAK_STATE_DIR` is set (the person chose the
 * location), when the stable directory already has an `auth.json`, or when it
 * holds the `migrated-from` marker of an earlier migration (so logging out
 * after a migration is not undone by a sign-in left in another candidate).
 *
 * Candidates, in order: `NOBLECLOAK_MIGRATE_FROM`, then `<pluginRoot>/.local`.
 * Exactly one is migrated: `NOBLECLOAK_MIGRATE_FROM` when it holds an
 * `auth.json`, otherwise `<pluginRoot>/.local`. Files in a candidate that was
 * not chosen are left alone and named in the message; so are files whose
 * destination already exists. The old directory is never deleted.
 *
 * Returns `{ status, source, moved, leftBehind, message }`; `message` is the one
 * line to show the person (null when there is nothing to say, including 'no-auth',
 * whose listing of the old directories is in `detail`, shown by /noblecloak-status). `status` is one of
 * 'override', 'present', 'done', 'migrated', 'failed' (auth.json could not be moved; no
 * marker is written), 'no-auth', 'none'.
 */
export function migrateLegacyState({ env = process.env, pluginRoot = PLUGIN_ROOT, home = homedir() } = {}) {
  if (env.NOBLECLOAK_STATE_DIR) return { status: 'override', source: null, moved: [], leftBehind: [], message: null };
  const dest = defaultStateDir(home);
  if (existsSync(join(dest, 'auth.json'))) {
    return { status: 'present', source: null, moved: [], leftBehind: [], message: null };
  }
  // Once means once: after a migration the `migrated-from` marker stays, so a
  // later /noblecloak-logout (which deletes auth.json) is not undone by moving
  // a sign-in in from a candidate that was not chosen the first time.
  if (existsSync(join(dest, MIGRATION_MARKER))) {
    return { status: 'done', source: null, moved: [], leftBehind: [], message: null };
  }
  const candidates = legacyCandidates({ env, pluginRoot }).filter((c) => c.dir !== dest);
  if (candidates.length === 0) return { status: 'none', source: null, moved: [], leftBehind: [], message: null };

  const withAuth = candidates.filter((c) => existsSync(join(c.dir, 'auth.json')));
  const stateFilesIn = (dir) => MIGRATED_STATE_FILES.filter((f) => existsSync(join(dir, f)));
  const describe = (c) => `${c.dir} (${stateFilesIn(c.dir).join(', ') || 'no state files'})`;
  if (withAuth.length === 0) {
    return {
      status: 'no-auth',
      source: null,
      moved: [],
      leftBehind: candidates.map((c) => c.dir),
      // Not `message`: with nothing to migrate it would repeat at every session
      // start and hook run. Only /noblecloak-status shows `detail`.
      message: null,
      detail:
        `NobleCloak: no earlier sign-in to migrate (no auth.json). Old state directories left untouched: ` +
        `${candidates.map(describe).join('; ')}.`,
    };
  }
  // legacyCandidates is in preference order: NOBLECLOAK_MIGRATE_FROM first.
  const [chosen] = withAuth;

  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const moved = [];
  const leftBehind = [];
  for (const name of MIGRATED_STATE_FILES) {
    const from = join(chosen.dir, name);
    if (!existsSync(from)) continue;
    const to = join(dest, name);
    if (existsSync(to)) {
      leftBehind.push(from);
      continue;
    }
    try {
      moveStateFile(from, to);
      moved.push(name);
    } catch (err) {
      // A concurrent process moved it first, or it cannot be moved; either way, leave it.
      if (err.code !== 'ENOENT') leftBehind.push(from);
    }
  }
  if (!moved.includes('auth.json')) {
    // No marker: the sign-in is still in the old directory and a later run may retry.
    return {
      status: 'failed',
      source: chosen.dir,
      moved,
      leftBehind,
      message:
        `NobleCloak: could not move auth.json from ${chosen.dir} to ${dest}; the earlier sign-in was not migrated ` +
        `(moved: ${moved.join(', ') || 'nothing'}). Run /noblecloak-login to sign in again.`,
    };
  }
  const markerFile = join(dest, MIGRATION_MARKER);
  writeFileSync(markerFile, `${chosen.dir}\n${new Date().toISOString()}\n`, { mode: 0o600 });

  const others = candidates.filter((c) => c !== chosen && stateFilesIn(c.dir).length > 0).map(describe);
  const message =
    `NobleCloak: moved plugin state from ${chosen.dir} to ${dest} (${moved.join(', ') || 'nothing'}).` +
    (others.length > 0 ? ` Left in place, not chosen: ${others.join('; ')}.` : '') +
    (leftBehind.length > 0 ? ` Not moved (already present at the destination or unmovable): ${leftBehind.join(', ')}.` : '');
  return { status: 'migrated', source: chosen.dir, moved, leftBehind, message };
}

/** The directory a past migration moved state from, or null (reads the `migrated-from` marker). */
export function readMigrationMarker(env = process.env) {
  try {
    const [source, at] = readFileSync(join(stateDir(env), MIGRATION_MARKER), 'utf-8').split('\n');
    return source ? { source, at: at || null } : null;
  } catch {
    return null;
  }
}

let lazyMigrationTried = false;

/**
 * A hook can run before the first SessionStart refresh of a session that
 * predates the state directory move; without this it would see an empty state directory and
 * report "not logged in". Tries the migration once per process, silently apart
 * from its one-line message on stderr.
 */
function migrateOnceIfDefaultDir(env) {
  if (lazyMigrationTried || env.NOBLECLOAK_STATE_DIR) return;
  lazyMigrationTried = true;
  try {
    const { message } = migrateLegacyState({ env });
    if (message) process.stderr.write(`${message}\n`);
  } catch {
    // best effort: an unreadable old directory must not break the hook
  }
}

/**
 * The sign-in saved in auth.json, as JSON, or null. Unlike `loadAuthState` it
 * does not check which deployment the sign-in belongs to.
 */
export function readAuthFile(env = process.env) {
  const file = authFilePath(env);
  if (!existsSync(file)) {
    migrateOnceIfDefaultDir(env);
    if (!existsSync(file)) return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * True when a saved sign-in was made against the issuer configured now:
 * `auth.issuer` (written by /noblecloak-login) equals `issuerBaseUrl(env)`.
 * A file with no `issuer` (written by plugin 0.1.x, whose default was the beta
 * deployment) counts as another deployment.
 */
export function authStateMatchesIssuer(auth, env = process.env) {
  return typeof auth?.issuer === 'string' && stripTrailingSlash(auth.issuer) === issuerBaseUrl(env);
}

/**
 * The saved sign-in, or null when there is none or it belongs to another
 * deployment (see `authStateMatchesIssuer`), so a token from one deployment is
 * never sent to, or refreshed at, another. /noblecloak-login replaces it.
 */
export function loadAuthState(env = process.env) {
  const auth = readAuthFile(env);
  return auth && authStateMatchesIssuer(auth, env) ? auth : null;
}

/**
 * Atomic write: temp file in the same directory + rename, so a concurrent
 * reader never observes a torn/partial file (a torn auth.json parses as null
 * and reads as "not logged in").
 */
function atomicWriteFileSync(filePath, contents, mode) {
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, contents, mode === undefined ? undefined : { mode });
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function saveAuthState(state, env = process.env) {
  ensureStateDir(env);
  // 0600: auth.json holds bearer + refresh tokens (including the govern token, which can open proposals and read approvals but cannot resolve them, D-A84).
  atomicWriteFileSync(authFilePath(env), JSON.stringify(state, null, 2), 0o600);
}

/**
 * Resolve the bearer token for governance calls.
 * NOBLECLOAK_DEV_TOKEN (dev-only) takes precedence over the cached auth state.
 * Returns { token, source: 'dev' | 'auth-file', refreshToken } or null.
 */
export function getBearerToken(env = process.env) {
  if (env.NOBLECLOAK_DEV_TOKEN) {
    return { token: env.NOBLECLOAK_DEV_TOKEN, source: 'dev', refreshToken: null };
  }
  const auth = loadAuthState(env);
  if (auth?.accessToken) {
    return { token: auth.accessToken, source: 'auth-file', refreshToken: auth.refreshToken || null };
  }
  return null;
}

// ── .mcp.json (committed, tokenless — no runtime writers; the MCP connection
//    is Claude Code's native OAuth. Readers: status.mjs AND isNobleCloakMcpTool,
//    which the PreToolUse hook calls at the enforcement boundary to decide
//    gateway-skip membership — a shape change here changes what bypasses
//    resolve/audit) ──

export function mcpConfigPath(env = process.env) {
  return env.NOBLECLOAK_MCP_FILE || join(PLUGIN_ROOT, '.mcp.json');
}

export function loadMcpConfig(env = process.env) {
  const file = mcpConfigPath(env);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * The RFC 8707 resource indicator for the NobleCloak MCP surface — the value the
 * OAuth client MUST send as `resource` on /authorize (and SHOULD send on the
 * token request) so the AS binds the issued token to this resource server.
 *
 * WHY THIS EXISTS. login.mjs previously sent no `resource` at all. Core's AS
 * binds `audience: code.resource ?? deps.resourceId`, so it silently supplied
 * the default and the minted token LOOKED correctly bound (`aud` = the MCP
 * URL, no `resource` claim) while the request was non-conformant. The defect
 * lived only in the authorize REQUEST, never in the token, making it invisible
 * to every resource-server-side log. Under `AS_ENFORCE_RESOURCE_INDICATOR=true`
 * core rejects that request with `invalid_target` (authorize.ts:
 * `if (deps.enforceResourceIndicator && q.resource === undefined)`), which
 * would break /noblecloak-login outright.
 *
 * DERIVED, not hardcoded: the indicator is the ORIGIN of the `noblecloak` MCP
 * server URL in .mcp.json (`https://host/v1/mcp` → `https://host`), so dev,
 * beta and prod each resolve their own without a literal that can drift from
 * core's `MCP_RESOURCE_ID` allowlist. Core compares with the trailing slash
 * normalized away (RFC 3986 §6.2.3) and binds the MATCHED allowlist entry as
 * the `aud`, so an origin with no trailing slash matches correctly.
 *
 * Returns `null` — never throws — when .mcp.json is absent, has no noblecloak
 * server, or carries an unparseable URL. Callers omit the parameter in that
 * case, which restores exactly today's pre-enforcement behaviour rather than
 * failing the login over a bad config.
 *
 * `NOBLECLOAK_MCP_RESOURCE` overrides the derivation for non-standard setups.
 */
export function resolveResourceIndicator(env = process.env) {
  const override = (env.NOBLECLOAK_MCP_RESOURCE || '').trim();
  if (override) return override;

  const config = loadMcpConfig(env);
  const url = config?.mcpServers?.noblecloak?.url;
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The approvals module's default URL for a govern origin. The shell serves the
 * approvals module at `/approvals` (D-A87; the `govern` name belongs to the API
 * host), so the production govern origin (`https://govern.noblecloak.com`)
 * maps to `https://app.noblecloak.com/approvals`. Any other origin (or null)
 * has no known shell host: returns `null`, and the caller prints the generic
 * sentence. `NOBLECLOAK_APPROVALS_URL` overrides this at the call site.
 */
// A literal map: display-only (no trust decision), so a miss fails safe to the
// generic sentence.
const APPROVALS_URL_BY_GOVERN_ORIGIN = new Map([
  ['https://govern.noblecloak.com', 'https://app.noblecloak.com/approvals'],
]);

export function defaultApprovalsUrl(governOrigin) {
  return (typeof governOrigin === 'string' && APPROVALS_URL_BY_GOVERN_ORIGIN.get(governOrigin)) || null;
}

/**
 * The approvals URL to print: `NOBLECLOAK_APPROVALS_URL` (trimmed, non-empty)
 * wins; otherwise the default for the govern origin; otherwise `null`.
 */
export function approvalsUrl(env, governOrigin) {
  return String(env?.NOBLECLOAK_APPROVALS_URL ?? '').trim() || defaultApprovalsUrl(governOrigin);
}

/**
 * The RFC 8707 resource indicator for the govern module API (the audience of
 * the second user token). `NOBLECLOAK_GOVERN_URL` overrides; otherwise it is
 * derived from the gateway origin in .mcp.json by swapping the leading `mcp.`
 * label for `govern.` (`https://mcp.noblecloak.com` →
 * `https://govern.noblecloak.com`). Returns a bare origin, or `null`
 * (never throws) when neither source yields one — including a gateway host that
 * does not start with `mcp.`, where guessing would mint a token for the wrong
 * audience.
 */
export function governResourceIndicator(env = process.env) {
  const override = (env.NOBLECLOAK_GOVERN_URL || '').trim();
  if (override) {
    try {
      return new URL(override).origin;
    } catch {
      return null;
    }
  }
  const gateway = resolveResourceIndicator(env);
  if (!gateway) return null;
  try {
    const url = new URL(gateway);
    if (!url.hostname.startsWith('mcp.')) return null;
    url.hostname = `govern.${url.hostname.slice('mcp.'.length)}`;
    return url.origin;
  } catch {
    return null;
  }
}

// ── Per-resource tokens ───────────────────────────────────────────────────
//
// auth.json keeps the GATEWAY token at the top level (accessToken/refreshToken/
// expiresAt — what the hooks, status and refresh read today, unchanged). Every
// other resource's token lives beside it under `tokens[<resource origin>]`
// with the same four fields. One resource per request, one audience per token
// (RFC 8707): the govern token is never the gateway token.

/**
 * The stored token for `resource`, as { accessToken, refreshToken, expiresAt,
 * scope?, authenticatedAt? }, or null. The gateway resource resolves to the
 * top-level fields, so a pre-existing single-token auth.json is already the
 * gateway entry of this shape (no file migration).
 */
export function getTokenFor(resource, env = process.env) {
  const auth = loadAuthState(env);
  if (!auth || !resource) return null;
  if (resource === resolveResourceIndicator(env)) {
    return auth.accessToken ? auth : null;
  }
  const entry = auth.tokens?.[resource];
  return entry?.accessToken ? entry : null;
}

/** Persist `entry` as the token for a NON-gateway `resource`, beside the gateway token. Requires an existing session. */
export async function saveTokenFor(resource, entry, env = process.env, opts = {}) {
  const lock = await acquireAuthLock(env, opts.deadline);
  try {
    const auth = loadAuthState(env);
    if (!auth) throw new Error('No NobleCloak session — run /noblecloak-login first.');
    saveAuthState({ ...auth, tokens: { ...(auth.tokens ?? {}), [resource]: entry } }, env);
  } finally {
    releaseAuthLock(lock.lockPath, lock.ownerToken);
  }
}

/** Remove the stored token for a NON-gateway `resource` (a rejected token must not be reused). No-op without a session or entry. */
export async function dropTokenFor(resource, env = process.env, opts = {}) {
  const lock = await acquireAuthLock(env, opts.deadline);
  try {
    const auth = loadAuthState(env);
    if (!auth?.tokens || !(resource in auth.tokens)) return;
    const { [resource]: _dropped, ...rest } = auth.tokens;
    const next = { ...auth, tokens: rest };
    if (Object.keys(rest).length === 0) delete next.tokens;
    saveAuthState(next, env);
  } finally {
    releaseAuthLock(lock.lockPath, lock.ownerToken);
  }
}

/**
 * The plugin's own semver, read from the committed .claude-plugin/plugin.json
 * manifest (the single versioned artifact). Best-effort: a missing/unparseable
 * manifest or a non-string `version` yields undefined so the caller (surface
 * attribution, D5) simply omits the field rather than crashing — mirrors
 * loadMcpConfig's try/catch/default-param shape (and, like it, is not cached).
 * `pluginRoot` is parameterized only for test isolation.
 */
export function pluginVersion(pluginRoot = PLUGIN_ROOT) {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

// ── Token identity + catalog health ──────────────────────────────────────────────────────────────────
//
// The access token's org binding is the single fact that diagnoses the
// "Tool 'X' not found in catalog" dead-end: ALL gateway tool calls
// resolve against the bound org's catalog, and the org is chosen on the
// consent page at login. Decode it, persist it
// at login, display it in status.
//
// TWO-TOKEN SEAM (documented, not solved here): this plugin's auth.json token
// drives the governance hooks; Claude Code's native MCP OAuth holds a SEPARATE
// token for the live gateway session. Each binds the org picked on
// its own consent page, so they normally bind the same org — but only the gateway
// can say authoritatively which org a live MCP session is bound to
// (a gateway-side introspection ask). Everything here reports the HOOKS token's binding.

/**
 * Decode a JWT's payload WITHOUT verification (display/diagnostics only —
 * never an authorization input). Returns the claims object, or null on any
 * malformed input. Never throws.
 */
export function decodeJwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * The identity bound into an auth state's access token: `{ sub, orgId }` (each
 * possibly undefined), or null when there is no decodable token. The LIVE
 * access token is the source of truth — the refresh path re-mints the token
 * (possibly against a different org picked on the consent page) and a stale persisted binding would
 * make status report org A while the catalog probe (which sends the live
 * token) reports org B: an internally-contradictory diagnostic in exactly the
 * org-mismatch scenario this feature exists to diagnose. The persisted
 * `orgId`/`sub` fields (written at login, preserved by refresh) are only the
 * fallback for tokens whose payload doesn't decode.
 */
export function tokenIdentity(auth) {
  if (!auth) return null;
  const claims = decodeJwtClaims(auth.accessToken) ?? {};
  const orgId = (typeof claims.org_id === 'string' ? claims.org_id : undefined) ?? auth.orgId;
  const sub = (typeof claims.sub === 'string' ? claims.sub : undefined) ?? auth.sub;
  if (orgId === undefined && sub === undefined) return null;
  return { sub, orgId };
}

/**
 * The MCP gateway URL from the committed .mcp.json, or null when absent.
 */
export function gatewayUrl(env = process.env) {
  const mcp = loadMcpConfig(env);
  const url = mcp?.mcpServers?.noblecloak?.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/**
 * Catalog health probe: one authenticated `tools/list`
 * against the MCP gateway, returning how many tools the session's org catalog
 * exposes. This is the same read the LLM's tool palette comes from, so N=0
 * here IS the "every dispatch will 404" precondition.
 *
 * Uses the HOOKS token (the only one this plugin holds — see the two-token
 * seam note above). Returns a discriminated result, never throws:
 *   { ok: true, count, names }         — probe succeeded
 *   { ok: false, reason, detail? }     — 'no_gateway' | 'http_<status>' |
 *                                        'bad_response' | 'network'
 */
export async function probeCatalog(token, env = process.env, { timeoutMs = 5000 } = {}) {
  const gateway = gatewayUrl(env);
  if (!gateway) return { ok: false, reason: 'no_gateway' };
  let text;
  let status;
  let httpOk;
  try {
    const res = await fetch(gateway, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The SDK transport requires both accept types (MCP Streamable HTTP).
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'catalog-probe', method: 'tools/list' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
    status = res.status;
    httpOk = res.ok;
  } catch (err) {
    // ONLY genuine transport failures (DNS, refused, abort/timeout) are
    // 'network' — a reachable gateway that answers garbage must NOT be
    // labeled unreachable (that remediation would point the wrong way).
    return { ok: false, reason: 'network', detail: err?.message };
  }
  if (!httpOk) {
    return { ok: false, reason: `http_${status}`, detail: text.slice(0, 200) };
  }
  // Stateless responses may arrive as plain JSON or as SSE framing depending
  // on the transport branch. An SSE stream may carry notifications before the
  // response, so pick the data line answering OUR request id (fall back to the
  // first data line for single-event streams from non-conforming servers).
  const parsed = parseProbeBody(text);
  if (parsed === null) {
    // A 200 with an unparseable body is a reachable-but-broken (or misrouted —
    // shared-ALB HTML error pages are a known class) gateway: bad_response.
    return { ok: false, reason: 'bad_response', detail: text.slice(0, 200) };
  }
  const tools = parsed?.result?.tools;
  if (!Array.isArray(tools)) {
    return { ok: false, reason: 'bad_response', detail: JSON.stringify(parsed?.error ?? parsed).slice(0, 200) };
  }
  return { ok: true, count: tools.length, names: tools.map((t) => t.name) };
}

/**
 * Parse a probe response body: plain JSON, or SSE framing (one JSON document
 * per `data:` line). For SSE, prefer the event whose JSON-RPC `id` matches the
 * probe's request id ('catalog-probe') — servers may emit notifications on the
 * stream before the response. Returns the parsed document or null.
 */
function parseProbeBody(text) {
  const dataLines = [...text.matchAll(/^data: (.*)$/gm)].map((m) => m[1]);
  const candidates = dataLines.length > 0 ? dataLines : [text];
  let first = null;
  for (const candidate of candidates) {
    let doc;
    try {
      doc = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (doc?.id === 'catalog-probe') return doc;
    if (first === null) first = doc;
  }
  return first;
}


// ── OAuth discovery + refresh (D4 — ISSUER-IS-API-HOST re-point) ──────────
//
// The issuer the plugin is configured with is the API host. Core is the OAuth
// 2.1 AS packaged under that host; endpoints are discovered via RFC 8414 (the
// discovery document may name a different host for them):
//   GET {issuer}/.well-known/oauth-authorization-server
// and the token endpoint comes from the discovery doc (lands on
// /auth/oauth/token once AS Stage 4 ships).

export class AuthDiscoveryError extends Error {}

export async function discoverAuthServer(env = process.env, { timeoutMs = 5000, deadline } = {}) {
  const issuer = issuerBaseUrl(env);
  const url = `${issuer}/.well-known/oauth-authorization-server`;
  const budgetMs = remainingBudgetMs(deadline, timeoutMs);
  if (budgetMs <= 0) {
    throw new AuthDiscoveryError(`OAuth discovery skipped — time budget exhausted before reaching ${url}`);
  }
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(budgetMs) });
  } catch (err) {
    throw new AuthDiscoveryError(
      `OAuth discovery unreachable at ${url} — ${err.message}`
    );
  }
  if (!response.ok) {
    throw new AuthDiscoveryError(`OAuth discovery failed (${response.status}) at ${url}`);
  }
  let doc;
  try {
    doc = await response.json();
  } catch {
    // Misrouted ALB / proxy error page / captive portal: infrastructure
    // problem, not a credential problem — keep it in the discovery taxonomy
    // so callers don't tell the user to re-login.
    throw new AuthDiscoveryError(
      `OAuth discovery returned non-JSON at ${url} — check NOBLECLOAK_ISSUER / network`
    );
  }
  if (!doc || typeof doc !== 'object') {
    throw new AuthDiscoveryError(`OAuth discovery returned a non-object document at ${url}`);
  }
  return doc;
}

/**
 * Token endpoint from the discovery doc. Throws AuthDiscoveryError with an
 * accurate message while Core OAuth AS Stage 4 (/token) is still pending.
 */
export async function getTokenEndpoint(env = process.env, opts = {}) {
  const doc = await discoverAuthServer(env, opts);
  if (!doc.token_endpoint) {
    throw new AuthDiscoveryError(
      'NobleCloak authorization server token endpoint not yet available ' +
        '(Core OAuth AS Stage 4 pending) — discovery doc has no token_endpoint.'
    );
  }
  return doc.token_endpoint;
}

export function clientId(env = process.env) {
  return env.NOBLECLOAK_CLIENT_ID || 'claude-code-plugin';
}

// ── Dynamic Client Registration (RFC 7591) ───────────────────────────────
//
// The AS issues OAuth client_ids via DCR (it does NOT honour a caller-chosen
// id), so the plugin registers a public + PKCE client on first login and
// persists the generated id in <state dir>/client.json, keyed by redirect_uri (the
// AS binds an issued code to the exact redirect_uri its client registered) and by
// the registration endpoint (another AS does not know the id).
// `clientId()` above stays a stable LABEL for the governance resolve payload;
// the OAuth client_id is this dynamically-registered value.

export function clientFilePath(env = process.env) {
  return join(stateDir(env), 'client.json');
}

export function loadRegisteredClient(env = process.env) {
  const file = clientFilePath(env);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    // A corrupt/truncated client.json (e.g. crash mid-write) must not present as
    // "no client registered" — that would silently degrade the refresh grant to
    // the static label. Leave a breadcrumb, then fall back as before.
    console.error(`NobleCloak: client.json unreadable at ${file} — ignoring (${err.message})`);
    return null;
  }
}

export function saveRegisteredClient(record, env = process.env) {
  ensureStateDir(env);
  atomicWriteFileSync(clientFilePath(env), JSON.stringify(record, null, 2));
}

/**
 * Register a public PKCE client at the AS DCR endpoint (RFC 7591). Returns the
 * server-generated client_id. Throws a clear, non-discovery error on failure so
 * callers never misadvise re-login on an infra/registration problem.
 */
export async function registerOAuthClient({ registrationEndpoint, redirectUri, timeoutMs = 5000 } = {}) {
  let response;
  try {
    response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Code — NobleCloak plugin',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Client registration unreachable at ${registrationEndpoint} — ${err.message}`);
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      if (errBody?.error) {
        detail = `${errBody.error}${errBody.error_description ? `: ${errBody.error_description}` : ''} (${response.status})`;
      }
    } catch {
      // keep the bare HTTP status
    }
    throw new Error(`Client registration failed at ${registrationEndpoint} — ${detail}`);
  }
  let doc;
  try {
    doc = await response.json();
  } catch {
    throw new Error(`Client registration at ${registrationEndpoint} returned a non-JSON body`);
  }
  if (!doc?.client_id) {
    throw new Error(`Client registration at ${registrationEndpoint} returned no client_id`);
  }
  return doc.client_id;
}

/**
 * True when a persisted client (client.json) was registered at
 * `registrationEndpoint`. A client.json with no `registrationEndpoint`
 * (written by plugin 0.1.x, whose default was the beta deployment) counts as
 * registered elsewhere.
 */
export function clientRegisteredAt(persisted, registrationEndpoint) {
  return Boolean(registrationEndpoint) && persisted?.registrationEndpoint === registrationEndpoint;
}

/**
 * Resolve the OAuth client_id to authorize with, registering once if needed:
 *   1. NOBLECLOAK_CLIENT_ID env override (a pre-registered client) wins.
 *   2. A persisted client_id for the SAME redirect_uri AND the same
 *      registration endpoint is reused (another authorization server does not
 *      know that client_id).
 *   3. Otherwise register via DCR and persist (with the redirect_uri and the
 *      registration endpoint).
 */
export async function ensureRegisteredClientId({ registrationEndpoint, redirectUri, env = process.env } = {}) {
  if (env.NOBLECLOAK_CLIENT_ID) return env.NOBLECLOAK_CLIENT_ID;

  const persisted = loadRegisteredClient(env);
  if (persisted?.clientId && persisted.redirectUri === redirectUri && clientRegisteredAt(persisted, registrationEndpoint)) {
    return persisted.clientId;
  }

  if (!registrationEndpoint) {
    throw new Error(
      'No OAuth client registered and the authorization server advertises no ' +
        'registration endpoint — cannot obtain a client_id. Set NOBLECLOAK_CLIENT_ID ' +
        'to a pre-registered client, or ensure the AS exposes registration_endpoint.'
    );
  }

  const newClientId = await registerOAuthClient({ registrationEndpoint, redirectUri });
  saveRegisteredClient(
    { clientId: newClientId, redirectUri, registrationEndpoint, registeredAt: new Date().toISOString() },
    env
  );
  return newClientId;
}

/**
 * The OAuth client_id to present on the refresh_token grant (`refreshTokens`).
 * This is the function's ONLY caller — the authorization-code exchange resolves
 * its client_id separately via `ensureRegisteredClientId()` in scripts/login.mjs,
 * not through here.
 *
 * The token was issued to the DCR-registered client persisted in client.json, so
 * the refresh_token grant MUST present that SAME id or the AS rejects it
 * (`invalid_grant — refresh token was issued to another client`). Order:
 * NOBLECLOAK_CLIENT_ID override → persisted DCR client → static label fallback
 * (`clientId()`, only when no client has been registered yet). `clientId()` itself
 * stays the governance-resolve LABEL, not the OAuth client.
 */
export function oauthClientId(env = process.env) {
  return env.NOBLECLOAK_CLIENT_ID || loadRegisteredClient(env)?.clientId || clientId(env);
}

/**
 * Token-endpoint failure with enough taxonomy for callers to give accurate
 * advice: `transient: false` means the grant itself was rejected — a 400/401
 * carrying one of DEAD_GRANT_OAUTH_ERRORS — and re-login is the fix; anything
 * else (5xx, 408, 429, a 4xx with no or another OAuth error, network, non-JSON
 * body) is `transient: true`, where re-login is the WRONG advice and the
 * signed-out marker must not be written. `oauthError` carries the OAuth error
 * code when the server provided one; `status` the HTTP status (null when no
 * response arrived).
 */
export class TokenRefreshError extends Error {
  constructor(message, { transient = false, oauthError = null, status = null } = {}) {
    super(message);
    this.name = 'TokenRefreshError';
    this.transient = transient;
    this.oauthError = oauthError;
    this.status = status;
  }
}

/**
 * RFC 6749 §5.2 error codes that mean the refresh grant or the client is dead,
 * so only a fresh sign-in can fix it. Trusted only on a 400 or 401: a rate
 * limit (429), a misrouted ALB (404) or a WAF (403) is an infrastructure
 * answer, not a verdict on the grant.
 */
const DEAD_GRANT_OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request']);

/**
 * Refresh-token grant against the discovered token endpoint.
 * Returns the raw token response ({ access_token, refresh_token?, expires_in? }).
 * `deadline` (epoch ms, optional) caps discovery + token POST cumulatively.
 * Throws AuthDiscoveryError (discovery taxonomy) or TokenRefreshError.
 */
export async function refreshTokens(refreshTokenStr, env = process.env, { timeoutMs = 5000, deadline, resource } = {}) {
  const tokenEndpoint = await getTokenEndpoint(env, { timeoutMs, deadline });
  const budgetMs = remainingBudgetMs(deadline, timeoutMs);
  if (budgetMs <= 0) {
    throw new TokenRefreshError(
      'Token refresh skipped — time budget exhausted before the token request',
      { transient: true }
    );
  }
  let response;
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: oauthClientId(env),
        refresh_token: refreshTokenStr,
        // RFC 8707 §2.2: only a per-resource token (tokens[resource]) re-sends
        // its resource; the gateway token's grant is byte-for-byte unchanged.
        ...(resource ? { resource } : {}),
      }),
      signal: AbortSignal.timeout(budgetMs),
    });
  } catch (err) {
    throw new TokenRefreshError(
      `Token endpoint unreachable at ${tokenEndpoint} — ${err.message}`,
      { transient: true }
    );
  }
  if (!response.ok) {
    // Surface the OAuth error body: a 400/401 `invalid_grant` (or another
    // DEAD_GRANT_OAUTH_ERRORS code) means re-login is the fix; everything else
    // is transient and re-login advice would be wrong.
    let oauthError = null;
    let detail = '';
    try {
      const body = await response.json();
      if (body && typeof body === 'object' && typeof body.error === 'string') {
        oauthError = body.error;
        detail = `: ${body.error}${body.error_description ? ` — ${body.error_description}` : ''}`;
      }
    } catch {
      // non-JSON error body — status alone will have to do
    }
    const deadGrant = (response.status === 400 || response.status === 401) && DEAD_GRANT_OAUTH_ERRORS.has(oauthError);
    const transient = !deadGrant;
    throw new TokenRefreshError(
      `Token refresh failed (${response.status}${detail})` +
        (transient ? ' — transient failure; will retry' : ''),
      { transient, oauthError, status: response.status }
    );
  }
  try {
    return await response.json();
  } catch {
    // Misrouted ALB / proxy error page on a 200: infrastructure problem, not a
    // credential problem (mirrors the discoverAuthServer non-JSON taxonomy).
    throw new TokenRefreshError(
      `Token endpoint returned non-JSON at ${tokenEndpoint} — check NOBLECLOAK_ISSUER / network`,
      { transient: true }
    );
  }
}

// ── Cross-process refresh lock ─────────────────────────────────────────────
//
// PreToolUse hooks run as independent processes and Claude Code issues tool
// calls in parallel, so an expired token produces a 401 storm: several hook
// processes try to refresh at once. With refresh-token rotation the first
// grant invalidates the refresh token the others are still holding, and
// last-writer-wins on auth.json can persist a stale/revoked token. The fix is
// single-flight: an O_EXCL lockfile in the state dir — one process refreshes,
// the others wait, re-read auth.json, and adopt the winner's tokens.

// A legitimate no-deadline hold (refresh.mjs path) can reach ~10s of network
// time (discovery 5s + token POST 5s); the staleness threshold must sit above
// that so a healthy-but-slow holder is never stolen from mid-grant.
const AUTH_LOCK_STALE_MS = 15_000;
const AUTH_LOCK_POLL_MS = 50;

function authLockPath(env = process.env) {
  return join(stateDir(env), 'auth.json.lock');
}

/**
 * Acquire the cross-process auth lock. Returns { lockPath, ownerToken } —
 * release MUST go through releaseAuthLock with the same ownerToken so a holder
 * whose lock was stolen as stale never deletes the thief's lock (which would
 * let a third process acquire concurrently and reintroduce the double-refresh
 * the lock exists to prevent).
 */
async function acquireAuthLock(env, deadline) {
  ensureStateDir(env);
  const lockPath = authLockPath(env);
  const ownerToken = `${process.pid}.${randomBytes(8).toString('hex')}`;
  for (;;) {
    // Deadline check at the top so EVERY path through the loop — including the
    // retry-immediately continues below — is deadline-bounded.
    if (deadline && Date.now() >= deadline) {
      throw new Error('timed out waiting for the auth refresh lock');
    }
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, ownerToken);
      closeSync(fd);
      return { lockPath, ownerToken };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // Lock held by someone else. A crashed holder must not wedge auth forever:
    // steal stale locks — atomically, via rename to a unique name. rename
    // guarantees exactly one stealer wins; an rmSync on the shared path would
    // let two waiters both "steal" and one delete the other's freshly created
    // lock (TOCTOU).
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > AUTH_LOCK_STALE_MS) {
        const stolen = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
        try {
          renameSync(lockPath, stolen);
          rmSync(stolen, { force: true });
        } catch {
          // another waiter won the steal — fall through to poll/retry
        }
        continue; // retry acquisition (deadline-checked at the loop top)
      }
    } catch (err) {
      // Only the lock-vanished-between-EEXIST-and-stat race retries
      // immediately; any other stat failure (EACCES/EPERM/EIO/…) must NOT
      // silently busy-spin past the deadline — rethrow so callers surface it.
      if (err.code !== 'ENOENT') throw err;
      continue; // deadline-checked at the loop top
    }
    await new Promise((resolve) => setTimeout(resolve, AUTH_LOCK_POLL_MS));
  }
}

/**
 * Release the auth lock — only if we still own it. If a waiter stole the lock
 * as stale while we were still running, the lockfile content no longer matches
 * our ownerToken and we must leave it alone.
 */
function releaseAuthLock(lockPath, ownerToken) {
  let current;
  try {
    current = readFileSync(lockPath, 'utf-8');
  } catch {
    return; // already gone — nothing to release
  }
  if (current !== ownerToken) return; // stolen — not ours to delete
  rmSync(lockPath, { force: true });
}

// ── Generic non-blocking single-flight lock (compaction) ───────────────────
//
// The auth lock above is a *waiting* single-flight (callers must converge on a
// fresh token). Compaction is different: it is best-effort and idempotent, so
// it never needs to wait — if another worker holds the lock, this one simply
// skips compaction and the next drain retries. Same O_EXCL primitive, no poll
// loop, with the identical stale-steal so a crashed holder can never wedge it.

/** Stale threshold for the best-effort compaction lock. Compaction is
 *  in-process file I/O (no network), so it is short-lived; a holder older than
 *  this is presumed crashed and its lock is stolen. */
const COMPACT_LOCK_STALE_MS = 30_000;

/**
 * Try to acquire a named O_EXCL lock in the state dir WITHOUT blocking. Returns
 * `{ lockPath, ownerToken }` on success, or `null` if the lock is held by a
 * live holder (caller skips its best-effort work). A stale lock (crashed
 * holder) is stolen atomically via rename, exactly like the auth lock, so it
 * can never wedge forever. Never throws — any FS error returns null (the caller
 * just skips this round).
 */
function tryAcquireLock(name, staleMs, env = process.env) {
  let lockPath;
  try {
    ensureStateDir(env);
    lockPath = join(stateDir(env), name);
  } catch {
    return null;
  }
  const ownerToken = `${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, ownerToken);
    closeSync(fd);
    return { lockPath, ownerToken };
  } catch (err) {
    if (err.code !== 'EEXIST') return null;
  }
  // Held by someone else. Steal it only if stale, and only via an atomic rename
  // so exactly one stealer wins (an rmSync on the shared path would let two
  // waiters both "steal"). Do NOT retry-acquire after a successful steal — this
  // is best-effort: leave the now-free lock for the next drain to claim.
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
      const stolen = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
      renameSync(lockPath, stolen);
      rmSync(stolen, { force: true });
    }
  } catch {
    // another waiter won the steal, or the lock vanished — either way, skip.
  }
  return null;
}

/** Release a lock acquired via tryAcquireLock — only if we still own it. */
function releaseLock(lockPath, ownerToken) {
  let current;
  try {
    current = readFileSync(lockPath, 'utf-8');
  } catch {
    return; // already gone — nothing to release
  }
  if (current !== ownerToken) return; // stolen — not ours to delete
  rmSync(lockPath, { force: true });
}

/**
 * Refresh the cached auth state in place (refresh grant → save). Returns the
 * updated auth state, or throws. Single-flight across concurrent processes:
 * holds the auth lock for the read-modify-write, and if another process
 * already refreshed while we waited (access token on disk changed), adopts
 * its tokens instead of burning our (possibly rotated-out) refresh token.
 */
export async function refreshAuthState(env = process.env, opts = {}) {
  const before = loadAuthState(env);
  let used = before;
  try {
    return await refreshAuthStateLocked(env, opts, before, (auth) => {
      used = auth;
    });
  } catch (err) {
    // Bind the failure to the credential it was about, so a signed-out marker
    // written from it can never describe a credential /noblecloak-login saved since.
    if (err && typeof err === 'object' && err.credentialFp === undefined) {
      err.credentialFp = credentialFingerprint(used);
    }
    throw err;
  }
}

async function refreshAuthStateLocked(env, opts, before, noteUsed) {
  if (!before?.refreshToken) {
    throw noRefreshTokenError();
  }
  const lock = await acquireAuthLock(env, opts.deadline);
  try {
    const auth = loadAuthState(env);
    noteUsed(auth);
    if (!auth?.refreshToken) {
      throw noRefreshTokenError();
    }
    if (auth.accessToken !== before.accessToken) {
      return auth; // another process refreshed while we waited — use its tokens
    }
    // A concurrent waiter just had THIS grant rejected and wrote the signed-out
    // marker while we queued on the lock: don't send the same dead refresh
    // token again (one rejected grant per expiry, not one per parallel hook).
    if (Number.isFinite(opts.signedOutSince)) {
      const marker = readSignedOut(env);
      if (marker && Number.isFinite(marker.checkedAt) && marker.checkedAt >= opts.signedOutSince) {
        const err = new Error(`Signed out (${marker.reason}) — run /noblecloak-login to re-authenticate.`);
        err.code = 'SIGNED_OUT';
        throw err;
      }
    }
    const tokens = await refreshTokens(auth.refreshToken, env, opts);
    const updated = {
      ...auth,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || auth.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    };
    saveAuthState(updated, env);
    return updated;
  } finally {
    releaseAuthLock(lock.lockPath, lock.ownerToken);
  }
}

function noRefreshTokenError() {
  const err = new Error('No refresh token available — run /noblecloak-login to re-authenticate.');
  err.code = 'NO_REFRESH_TOKEN';
  return err;
}

/**
 * Refresh one per-resource token (tokens[resource]) under the auth lock, the
 * same single-flight as the gateway token: adopt a concurrent winner's tokens
 * rather than burn a rotated-out refresh token. Returns the stored entry.
 * Throws TokenRefreshError / AuthDiscoveryError like refreshTokens, or a plain
 * Error when there is no refresh token.
 */
export async function refreshTokenFor(resource, env = process.env, opts = {}) {
  const before = loadAuthState(env)?.tokens?.[resource];
  if (!before?.refreshToken) {
    throw new Error(`No refresh token for ${resource} — re-run the command that signs in to it.`);
  }
  const lock = await acquireAuthLock(env, opts.deadline);
  try {
    const auth = loadAuthState(env);
    const current = auth?.tokens?.[resource];
    if (!current?.refreshToken) {
      throw new Error(`No refresh token for ${resource} — re-run the command that signs in to it.`);
    }
    if (current.accessToken !== before.accessToken) return current; // adopted a concurrent refresh
    const tokens = await refreshTokens(current.refreshToken, env, { ...opts, resource });
    const updated = {
      ...current,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || current.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    };
    saveAuthState({ ...auth, tokens: { ...auth.tokens, [resource]: updated } }, env);
    return updated;
  } finally {
    releaseAuthLock(lock.lockPath, lock.ownerToken);
  }
}

// ── Signed-out marker + local expiry check (auth/audit hygiene, 2026-10-20) ─
//
// A dead grant used to cost one 401 + one rejected refresh on EVERY tool call
// (and COO logged each 401 at error level), while the only message about it
// went to the SessionStart hook's stderr, which the user never sees. Now:
//   - a token is checked against its local `expiresAt` (minus a small clock-skew
//     allowance) BEFORE any COO call; an expired one is refreshed once, never sent;
//   - a REJECTED refresh (invalid_grant, or no refresh token at all) writes
//     `<state dir>/signed-out.json` = { since, reason, checkedAt }. While it exists no
//     hook calls COO: resolve takes its no-token fail-mode, emit/drain spill as
//     logged out (the breaker is untouched — logged out is not an outage);
//   - the marker is deleted by /noblecloak-login and by any successful refresh;
//   - a marked plugin re-tries the refresh at most once per
//     SIGNED_OUT_RECHECK_MS, so a grant fixed server-side recovers without a login.
// A TRANSIENT refresh failure (5xx, network, discovery, lock timeout) never
// writes the marker: the expired token is still not sent, and the next call retries.

/** Clock-skew allowance: a token this close to `expiresAt` counts as expired. */
export const TOKEN_EXPIRY_SKEW_MS = 30_000;
/**
 * How often a signed-out plugin re-tries its refresh grant (env-overridable via
 * NOBLECLOAK_SIGNED_OUT_RECHECK_MS). 15 minutes: one token-endpoint call per
 * quarter hour is negligible load, and a grant fixed server-side recovers well
 * within a working session without the user having to notice and re-login.
 */
export const SIGNED_OUT_RECHECK_MS = 15 * 60 * 1000;

export function signedOutPath(env = process.env) {
  return join(stateDir(env), 'signed-out.json');
}

function signedOutRecheckMs(env) {
  const n = Number.parseInt(env.NOBLECLOAK_SIGNED_OUT_RECHECK_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : SIGNED_OUT_RECHECK_MS;
}

/**
 * The signed-out marker `{ since, reason, checkedAt }`, or null when signed in.
 * An unreadable marker still means signed out (it was written for a reason);
 * it reads with no `checkedAt`, so the next caller re-checks immediately.
 */
export function readSignedOut(env = process.env) {
  const file = signedOutPath(env);
  if (!existsSync(file)) return null;
  try {
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    if (rec && typeof rec === 'object') {
      // A marker describes one credential. If auth.json now holds another (a
      // login finished after a late rejection wrote this), it is stale: drop it.
      if (typeof rec.credentialFp === 'string' && rec.credentialFp !== credentialFingerprint(loadAuthState(env))) {
        try {
          rmSync(file, { force: true });
        } catch {
          // best-effort — it is ignored either way
        }
        return null;
      }
      return rec;
    }
  } catch {
    // fall through
  }
  return { since: null, reason: 'unreadable signed-out marker', checkedAt: null };
}

/**
 * Short sha256 fingerprint of the credential an auth state stands on: its
 * refresh token, else its access token. null when there is neither. The token
 * itself is never written to the marker.
 */
export function credentialFingerprint(auth) {
  return tokenFingerprint(auth?.refreshToken || auth?.accessToken);
}

/** Short sha256 fingerprint of one token string, or null. */
export function tokenFingerprint(token) {
  if (typeof token !== 'string' || !token) return null;
  return createHash('sha256').update(token, 'utf-8').digest('hex').slice(0, 16);
}

/** The user-visible sentence for a signed-out plugin. */
export function signedOutMessage(marker) {
  const since = marker?.since ? ` since ${marker.since}` : '';
  const reason = marker?.reason ? ` (${marker.reason})` : '';
  return (
    `NobleCloak: signed out of governance${since}${reason}. Tool calls are not being ` +
    'checked against your policies or audited to NobleCloak. Run /noblecloak-login to sign back in.'
  );
}

/**
 * Write (or refresh) the signed-out marker and queue the once-per-session
 * user-visible notice. `since` is preserved across re-checks. The marker is
 * bound to `credentialFp` (the fingerprint of the credential that was
 * rejected; a refresh error carries it as `err.credentialFp`), defaulting to
 * the credential on disk now. When `credentialFp` no longer matches auth.json
 * (a login replaced it while the rejected refresh was in flight) nothing is
 * written. Best-effort, never throws.
 */
export function writeSignedOut(reason, env = process.env, { now = Date.now(), credentialFp } = {}) {
  try {
    const current = credentialFingerprint(loadAuthState(env));
    if (credentialFp !== undefined && credentialFp !== current) return;
    const prev = readSignedOut(env);
    const marker = {
      since: prev?.since ?? new Date(now).toISOString(),
      reason: String(reason ?? 'refresh rejected').slice(0, 300),
      checkedAt: now,
      credentialFp: current,
    };
    ensureStateDir(env);
    atomicWriteFileSync(signedOutPath(env), JSON.stringify(marker));
    if (!prev) postNotice('signed-out', signedOutMessage(marker), env);
  } catch {
    // best-effort — the expired token is still never sent (local expiry check)
  }
}

/** Record a re-check attempt without changing since/reason. Best-effort. */
function touchSignedOutCheck(env, now = Date.now()) {
  try {
    const prev = readSignedOut(env);
    if (!prev) return;
    atomicWriteFileSync(signedOutPath(env), JSON.stringify({ ...prev, checkedAt: now }));
  } catch {
    // best-effort
  }
}

/** Delete the marker (login, or a successful refresh) and its notice. Best-effort. */
export function clearSignedOut(env = process.env) {
  try {
    if (existsSync(signedOutPath(env))) rmSync(signedOutPath(env), { force: true });
    clearNotice('signed-out', env);
  } catch {
    // best-effort
  }
}

/** True when the marker's last refresh attempt is at least the re-check interval old. */
export function signedOutRecheckDue(marker, env = process.env, now = Date.now()) {
  if (!marker) return false;
  return !Number.isFinite(marker.checkedAt) || now - marker.checkedAt >= signedOutRecheckMs(env);
}

/** True when `auth.expiresAt` (epoch ms) is past, allowing TOKEN_EXPIRY_SKEW_MS of skew. No expiresAt → not known expired. */
export function isTokenExpired(auth, now = Date.now()) {
  return Number.isFinite(auth?.expiresAt) && now >= auth.expiresAt - TOKEN_EXPIRY_SKEW_MS;
}

/**
 * True when a refresh failure means the GRANT is dead (re-login is the fix):
 * a non-transient TokenRefreshError (a 400/401 with a DEAD_GRANT_OAUTH_ERRORS
 * code) or no refresh token. Discovery failures, 5xx/408/429/other 4xx,
 * network, and a lock timeout are transient.
 */
export function isRejectedRefresh(err) {
  return (err instanceof TokenRefreshError && !err.transient) || err?.code === 'NO_REFRESH_TOKEN';
}

// ── Transient refresh backoff ─────────────────────────────────────────────
//
// A transient refresh failure (5xx, 429, a hung core, discovery) used to be
// retried by every COO call: each emit, and each of a drain's up to 50 records,
// ran discovery + a grant. Now the failure is stamped in
// <state dir>/refresh-backoff.json = { credentialFp, failedAt, reason } and, for
// REFRESH_BACKOFF_MS, an expired token is not refreshed (nothing is sent) and
// the drain is skipped. The stamp is bound to the credential like the
// signed-out marker; a successful refresh deletes it.

/** How long a transient refresh failure suppresses the next attempt (env: NOBLECLOAK_REFRESH_BACKOFF_MS). */
export const REFRESH_BACKOFF_MS = 60_000;

function refreshBackoffMs(env) {
  const n = Number.parseInt(env.NOBLECLOAK_REFRESH_BACKOFF_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : REFRESH_BACKOFF_MS;
}

export function refreshBackoffPath(env = process.env) {
  return join(stateDir(env), 'refresh-backoff.json');
}

/** The backoff stamp, or null (missing/corrupt). Never throws. */
export function readRefreshBackoff(env = process.env) {
  try {
    const file = refreshBackoffPath(env);
    if (!existsSync(file)) return null;
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    return rec && typeof rec === 'object' && Number.isFinite(rec.failedAt) ? rec : null;
  } catch {
    return null;
  }
}

/** True when a transient refresh failure of THIS auth state's credential is younger than the backoff. */
export function refreshBackoffActive(auth, env = process.env, now = Date.now()) {
  const rec = readRefreshBackoff(env);
  if (!rec || rec.credentialFp !== credentialFingerprint(auth)) return false;
  const age = now - rec.failedAt;
  return age >= 0 && age < refreshBackoffMs(env);
}

function writeRefreshBackoff(err, env, now = Date.now()) {
  try {
    ensureStateDir(env);
    const credentialFp = err?.credentialFp !== undefined ? err.credentialFp : credentialFingerprint(loadAuthState(env));
    atomicWriteFileSync(
      refreshBackoffPath(env),
      JSON.stringify({ credentialFp, failedAt: now, reason: String(err?.message ?? 'refresh failed').slice(0, 300) })
    );
  } catch {
    // best-effort — without the stamp the next call simply retries
  }
}

function clearRefreshBackoff(env) {
  try {
    rmSync(refreshBackoffPath(env), { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Refresh for a COO call. Success clears the marker and the backoff; a rejected
 * grant writes the marker; a transient failure stamps the backoff. Returns a
 * usableBearer result.
 */
async function refreshForUse(env, { deadline, timeoutMs, signedOut }) {
  const startedAt = Date.now();
  try {
    const updated = await refreshAuthState(env, {
      deadline,
      ...(timeoutMs ? { timeoutMs } : {}),
      // Only when we started WITHOUT a marker: if a concurrent caller's grant is
      // rejected while we wait on the lock, don't resend it. A re-check (marker
      // present) stamped checkedAt itself just before this call, so the
      // short-circuit would always fire on its own stamp.
      ...(signedOut ? {} : { signedOutSince: startedAt }),
    });
    clearSignedOut(env);
    clearRefreshBackoff(env);
    return { token: updated.accessToken, source: 'auth-file', refreshToken: updated.refreshToken || null, refreshed: true };
  } catch (err) {
    if (err?.code === 'SIGNED_OUT') return { token: null, reason: 'signed-out', error: err };
    if (isRejectedRefresh(err)) {
      writeSignedOut(err.message, env, { credentialFp: err.credentialFp });
      return { token: null, reason: 'signed-out', error: err };
    }
    writeRefreshBackoff(err, env);
    return { token: null, reason: signedOut ? 'signed-out' : 'token-expired', error: err };
  }
}

/**
 * The bearer a hook may send to COO, after the local expiry check:
 *   { token, source: 'dev' | 'auth-file', refreshToken, refreshed? }
 * or, when nothing may be sent:
 *   { token: null, reason: 'no-token' | 'signed-out' | 'token-expired', error? }
 *
 * NOBLECLOAK_DEV_TOKEN (dev-only) is returned as-is: it has no known expiry and
 * the marker describes auth.json, not the override. `allowRefresh: false`
 * never touches the network (the token is used only if locally valid).
 */
export async function usableBearer(env = process.env, { allowRefresh = true, deadline, timeoutMs, now = Date.now } = {}) {
  if (env.NOBLECLOAK_DEV_TOKEN) {
    return { token: env.NOBLECLOAK_DEV_TOKEN, source: 'dev', refreshToken: null };
  }
  const auth = loadAuthState(env);
  if (!auth?.accessToken) return { token: null, reason: 'no-token' };

  const marker = readSignedOut(env);
  if (marker) {
    if (!allowRefresh || !auth.refreshToken || !signedOutRecheckDue(marker, env, now())) {
      return { token: null, reason: 'signed-out' };
    }
    // Claim this re-check BEFORE the network so parallel hooks don't all retry.
    touchSignedOutCheck(env, now());
    return refreshForUse(env, { deadline, timeoutMs, signedOut: true });
  }

  if (!isTokenExpired(auth, now())) {
    return { token: auth.accessToken, source: 'auth-file', refreshToken: auth.refreshToken || null };
  }
  if (!auth.refreshToken) {
    writeSignedOut('token expired and no refresh token', env, { credentialFp: credentialFingerprint(auth) });
    return { token: null, reason: 'signed-out' };
  }
  if (!allowRefresh) return { token: null, reason: 'token-expired' };
  if (refreshBackoffActive(auth, env, now())) return { token: null, reason: 'token-expired', backoff: true };
  return refreshForUse(env, { deadline, timeoutMs, signedOut: false });
}

/**
 * True when local state alone says no COO call may be made (no network needed
 * to know): the signed-out marker exists, there is no auth.json token and no
 * dev-token override, or the token is expired and its refresh is backing off
 * after a transient failure. The worker skips its drain then — re-spilling up
 * to a drain-cap of queued records on every event would be pure churn.
 */
export function cooCallsSuspended(env = process.env, now = Date.now()) {
  if (env.NOBLECLOAK_DEV_TOKEN) return false;
  if (readSignedOut(env)) return true;
  const auth = loadAuthState(env);
  if (!auth?.accessToken) return true;
  return isTokenExpired(auth, now) && refreshBackoffActive(auth, env, now);
}

// ── User-visible notices (once per session) ───────────────────────────────
//
// Claude Code shows a hook's JSON `systemMessage` to the user for SessionStart,
// PreToolUse and PostToolUse (code.claude.com/docs/en/hooks, fetched
// 2026-10-20: "systemMessage — Warning message shown to the user"; the events
// that discard it are listed per event and do not include these three). Plain
// stdout from SessionStart goes to Claude's context, and stderr from an exit-0
// hook is never shown. The audit worker is DETACHED and has no channel at all,
// so anything it needs to say is queued here and shown by the next synchronous
// hook (PreToolUse, or the post-events dispatcher), once per Claude Code session.
//
// <state dir>/notices.json = { pending: { <kind>: { message, sessionId|null, at } },
//                         shown: { "<kind>|<sessionId>": at } }

/** Cap on remembered (kind, session) shown pairs and on pending notices. */
const NOTICE_SHOWN_RETENTION = 256;
const NOTICE_PENDING_RETENTION = 32;

export function noticesPath(env = process.env) {
  return join(stateDir(env), 'notices.json');
}

function readNotices(env) {
  const file = noticesPath(env);
  if (!existsSync(file)) return { pending: {}, shown: {} };
  try {
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    return {
      pending: rec?.pending && typeof rec.pending === 'object' ? rec.pending : {},
      shown: rec?.shown && typeof rec.shown === 'object' ? rec.shown : {},
    };
  } catch {
    return { pending: {}, shown: {} };
  }
}

function writeNotices(state, env) {
  const trim = (obj, max) => Object.fromEntries(Object.entries(obj).slice(-max));
  ensureStateDir(env);
  atomicWriteFileSync(
    noticesPath(env),
    JSON.stringify({ pending: trim(state.pending, NOTICE_PENDING_RETENTION), shown: trim(state.shown, NOTICE_SHOWN_RETENTION) })
  );
}

/**
 * Queue a user-visible notice. `sessionId` scopes it to one Claude Code
 * session; null shows it once in every session. Re-posting an existing kind
 * keeps its shown-state (still once per session). Best-effort, never throws.
 */
export function postNotice(kind, message, env = process.env, { sessionId = null } = {}) {
  try {
    const state = readNotices(env);
    if (state.pending[kind]?.message === message && state.pending[kind]?.sessionId === sessionId) return;
    state.pending[kind] = { message, sessionId, at: new Date().toISOString() };
    writeNotices(state, env);
  } catch {
    // best-effort
  }
}

/** Drop a resolved notice and its shown-state (a recurrence warns again). Best-effort. */
export function clearNotice(kind, env = process.env) {
  try {
    if (!existsSync(noticesPath(env))) return;
    const state = readNotices(env);
    const shownKeys = Object.keys(state.shown).filter((k) => k.startsWith(`${kind}|`));
    if (!state.pending[kind] && shownKeys.length === 0) return;
    delete state.pending[kind];
    for (const k of shownKeys) delete state.shown[k];
    writeNotices(state, env);
  } catch {
    // best-effort
  }
}

/**
 * Messages this session has not seen yet; marks them shown. A null/absent
 * `sessionId` returns nothing (once-per-session can't be tracked). Never throws.
 */
export function takeNotices(sessionId, env = process.env) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return [];
  try {
    if (!existsSync(noticesPath(env))) return [];
    const state = readNotices(env);
    const out = [];
    for (const [kind, notice] of Object.entries(state.pending)) {
      if (!notice || typeof notice.message !== 'string') continue;
      if (notice.sessionId && notice.sessionId !== sessionId) continue;
      const key = `${kind}|${sessionId}`;
      if (state.shown[key]) continue;
      state.shown[key] = new Date().toISOString();
      out.push(notice.message);
    }
    if (out.length > 0) writeNotices(state, env);
    return out;
  } catch {
    return [];
  }
}

/** Mark a kind as already shown to a session (e.g. SessionStart printed it itself). Best-effort. */
export function markNoticeShown(kind, sessionId, env = process.env) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;
  try {
    const state = readNotices(env);
    state.shown[`${kind}|${sessionId}`] = new Date().toISOString();
    writeNotices(state, env);
  } catch {
    // best-effort
  }
}

// ── Local-tool classification mirror (offline fail-mode knowledge) ────────
//
// STATIC MIRROR of the 8 built-in classifications enrolled in COO — source of
// truth: the COO API's local tool catalog (LOCAL_TOOL_CATALOG). Drift here is tolerable: this table is
// used ONLY to pick the offline fail-mode (read → fail-open, everything else →
// fail-closed) when COO is unreachable; server resolution always wins when
// reachable (ADR-0033 §1 server-authoritative).

export const SIDE_EFFECT_LEVELS = Object.freeze(['read', 'write', 'external', 'delete', 'admin']);

export const LOCAL_TOOL_SIDE_EFFECTS = Object.freeze({
  'tool:claude-code:bash': 'delete',
  'tool:claude-code:edit': 'write',
  'tool:claude-code:write': 'write',
  'tool:claude-code:read': 'read',
  'tool:claude-code:glob': 'read',
  'tool:claude-code:grep': 'read',
  'tool:claude-code:webfetch': 'external',
  'tool:claude-code:agent': 'read',
});

/** mcp__* tools without annotations classify as write (COO classifyMcpTool default). */
export const MCP_DEFAULT_SIDE_EFFECT = 'write';
/** Unknown built-ins resolve ephemerally as write server-side; mirror that offline. */
export const UNKNOWN_TOOL_SIDE_EFFECT = 'write';

/**
 * Map a Claude Code tool name to its governance tool_ref.
 *   Bash → tool:claude-code:bash, … (lowercased built-in name)
 *   mcp__<server>__<action> → verbatim
 */
export function toolRefFor(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  if (toolName.startsWith('mcp__')) return toolName;
  return `tool:claude-code:${toolName.toLowerCase()}`;
}

/**
 * Static fallback for "gateway-governed NobleCloak MCP server ids" when
 * .mcp.json does not exist (or is unparseable) — dev-token runs on a fresh
 * checkout. Exact ids only — never a prefix match (a prefix would let any
 * 'mcp__noblecloak*'-named server silently bypass resolve AND audit at the
 * enforcement boundary).
 */
export const FALLBACK_NOBLECLOAK_SERVER_IDS = Object.freeze(['noblecloak']);

/** This plugin's id in plugin.json; Claude Code prefixes its tools `mcp__plugin_<id>_<server>__`. */
const PLUGIN_ID = 'noblecloak';
const PLUGIN_TOOL_PREFIX = `plugin_${PLUGIN_ID}_`;

/**
 * The MCP server id a tool name addresses, or null. Two shapes:
 *   mcp__<server>__<tool>                      (a server from the user's or project's config)
 *   mcp__plugin_noblecloak_<server>__<tool>    (a server this plugin ships in its .mcp.json)
 * Only this plugin's own prefix is unwrapped: `mcp__plugin_other_noblecloak__x`
 * yields `plugin_other_noblecloak`, which is never a configured server id.
 */
function mcpServerIdOf(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null;
  const boundary = toolName.indexOf('__', 'mcp__'.length);
  if (boundary === -1) return null;
  const segment = toolName.slice('mcp__'.length, boundary);
  if (segment.startsWith(PLUGIN_TOOL_PREFIX) && segment.length > PLUGIN_TOOL_PREFIX.length) {
    return segment.slice(PLUGIN_TOOL_PREFIX.length);
  }
  return segment;
}

/**
 * True when the tool belongs to a NobleCloak MCP server — gateway-governed,
 * never double-ENFORCED: the PreToolUse hook skips resolve and writes no
 * audit-queue record (the COO gateway is the enforcement point). As of the
 * 2026-07-09 session tool-call log brief (D1-D5) the PostToolUse hook DOES emit
 * a single corroborating `:post` local record for these calls — the gateway's
 * action-ledger audit stays the sole authoritative record, linked via
 * bn_corroborated_by:'action_ledger' and never cross-written. Membership is
 * derived from the server ids in the committed .mcp.json (the single source of
 * truth for "gateway-governed"); the file is static and tokenless — Claude Code
 * owns the live MCP connection via native OAuth, so there is no runtime writer.
 *
 * Three states, deliberately distinct:
 *   - file absent/unparseable → exact-id static fallback applies
 *   - file present with servers → the config is the source of truth
 *   - file present but EMPTY ({ mcpServers: {} } — e.g. a hand-edited config)
 *     → the config is STILL the source of truth: there are no gateway-governed
 *     servers, so NOTHING gets the gateway-skip. An empty config must never
 *     silently reactivate the static fallback — that would let an independently
 *     configured server named `noblecloak` bypass resolve and audit.
 */
export function isNobleCloakMcpTool(toolName, env = process.env) {
  const serverId = mcpServerIdOf(toolName);
  if (serverId === null) return false;
  const config = loadMcpConfig(env);
  if (config?.mcpServers && typeof config.mcpServers === 'object') {
    return Object.prototype.hasOwnProperty.call(config.mcpServers, serverId);
  }
  return FALLBACK_NOBLECLOAK_SERVER_IDS.includes(serverId);
}

/** Offline side-effect level for fail-mode selection (see mirror note above). */
export function offlineSideEffectLevel(toolRef) {
  if (!toolRef) return UNKNOWN_TOOL_SIDE_EFFECT;
  if (toolRef.startsWith('mcp__')) return MCP_DEFAULT_SIDE_EFFECT;
  return LOCAL_TOOL_SIDE_EFFECTS[toolRef] || UNKNOWN_TOOL_SIDE_EFFECT;
}

// ── Channel detection (ADR-0033 §7; spike Q2) ─────────────────────────────
//
// The channel signal is the hook process env CLAUDE_CODE_ENTRYPOINT (NOT a
// hook-input field) × agent_id presence (subagent vs root). Checked lookup
// table; anything unknown → 'headless' (fail-safe). The 'cli' interactive
// value rides the spike's residual 60s human pass — if it turns out to differ,
// only this table changes.

export const CHANNEL_BY_ENTRYPOINT = Object.freeze({
  cli: 'interactive', // interactive Claude Code CLI/desktop (spike-expected; human pass pending)
  'sdk-cli': 'headless', // claude -p (spike-verified 2026-06-05)
});

/**
 * @param {string|undefined} entrypoint  CLAUDE_CODE_ENTRYPOINT
 * @param {string|undefined} agentId     hook input agent_id (present inside subagents)
 * @returns {'interactive'|'headless'}
 */
export function detectChannel(entrypoint, agentId) {
  if (agentId) return 'headless'; // subagents are never human-promptable
  return CHANNEL_BY_ENTRYPOINT[entrypoint] === 'interactive' ? 'interactive' : 'headless';
}

// ── Surface detection (D5a — session tool-call log brief 2026-07-09) ────────
//
// The surface signal identifies WHICH client host produced a tool call, sourced
// from the same hook-process env CLAUDE_CODE_ENTRYPOINT as the channel signal.
// Checked lookup table; anything unknown/future → 'unknown' (fail-safe — never
// mislabel an unrecognized host). Known limitation carried from the channel
// table: 'cli' covers BOTH the interactive CLI and the desktop app (the
// entrypoint does not distinguish them), so both report surface 'claude-code';
// if a distinct desktop entrypoint later surfaces, only this table changes.

export const SURFACE_BY_ENTRYPOINT = Object.freeze({
  cli: 'claude-code', // interactive Claude Code CLI/desktop
  'sdk-cli': 'claude-code', // claude -p (headless CLI) — still the claude-code surface
});

/**
 * Self-reported host attribution only. `reported` identifies which client host
 * produced the tool call, sourced best-effort from CLAUDE_CODE_ENTRYPOINT; an
 * unrecognized/future host yields 'unknown' (fail-safe — never mislabel). This
 * is CLIENT-supplied and unverified: verified attribution will be a future COO
 * server-stamped field resolved from the token at ingest, NOT a slot in this
 * client block.
 *
 * @param {Record<string,string|undefined>} [env]  defaults to process.env
 * @returns {'claude-code'|'unknown'}
 */
export function detectSurface(env = process.env) {
  const key = env?.CLAUDE_CODE_ENTRYPOINT;
  // Exact-match lookup, prototype-safe (mirrors detectChannel): a key like
  // "toString"/"constructor"/"__proto__" must fall back to 'unknown', not pick
  // up an inherited Object.prototype member. Object.hasOwn also guards an
  // absent/undefined key.
  return Object.hasOwn(SURFACE_BY_ENTRYPOINT, key) ? SURFACE_BY_ENTRYPOINT[key] : 'unknown';
}

// ── Arg digest + per-tool safe summary (ADR-0033 §5 privacy decision) ─────
//
// Raw tool input NEVER leaves the machine. The resolve request and audit
// record carry only:
//   arg_digest  — SHA-256 hex over the canonicalized (recursively key-sorted
//                 JSON) tool_input
//   arg_summary — per-tool safe summary: Bash → first token only, Edit/Write →
//                 cwd-relative path, WebFetch → domain only, MCP → tool name
//                 only. Tools without a decided summary (Read/Glob/Grep/Agent/
//                 unknown) get the tool name only (fail-safe).

export function canonicalize(value) {
  return JSON.stringify(sortKeysDeep(value === undefined ? null : value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

export function argDigest(toolInput) {
  return createHash('sha256').update(canonicalize(toolInput), 'utf-8').digest('hex');
}

export function argSummary(toolName, toolInput, cwd) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (typeof toolName !== 'string') return 'unknown-tool';
  if (toolName.startsWith('mcp__')) return toolName;
  switch (toolName) {
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      const first = command.split(/\s+/)[0];
      return first || 'bash';
    }
    case 'Edit':
    case 'Write': {
      const filePath = typeof input.file_path === 'string' ? input.file_path : '';
      if (!filePath) return toolName;
      return safeRelativePath(filePath, cwd);
    }
    case 'WebFetch': {
      try {
        return new URL(input.url).hostname;
      } catch {
        return 'invalid-url';
      }
    }
    default:
      // Read/Glob/Grep/Agent and anything undecided: tool name only (fail-safe).
      return toolName;
  }
}

function safeRelativePath(filePath, cwd) {
  if (!cwd || !isAbsolute(filePath)) return basenameOrSelf(filePath);
  const rel = relative(cwd, filePath);
  // A path escaping cwd would leak directory structure outside the workspace;
  // degrade to basename in that case.
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..') return basenameOrSelf(filePath);
  return rel;
}

function basenameOrSelf(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// ── Per-call audit record (the brief #5 seam) ─────────────────────────────
//
// AUDIT RECORD CONTRACT — consumed by the PostToolUse/Subagent audit emitter
// (scripts/hooks/post-events.mjs + post-events-worker.mjs, epic brief #5; the
// emission helpers live in this file's "Audit-event emission" section). One
// JSON object per line, appended to
// ~/.noblecloak/claude-plugin/audit-queue.jsonl (override dir: NOBLECLOAK_STATE_DIR).
// The emitter drains the queue (correlate on tool_use_id ↔ Post events) and
// ships coo_run_events; this adapter only ever appends.
//
// Degraded early-exit records (degraded_reason 'malformed-input' /
// 'shape-drift') carry only the fields that survived parsing — string fields
// that could not be trusted are null/absent — so adapter degradation is
// countable from the audit data instead of being stderr-only.
//
// Shape (v=1):
// {
//   v: 1,
//   ts: string (ISO-8601),                 // when the hook started (resolve completed at ts + duration_ms)
//   hook_event: 'PreToolUse',
//   session_id: string | null,             // null only on degraded early-exit records
//   tool_use_id: string | null,            // Pre↔Post correlation key; null only on degraded early-exit records
//   agent_id?: string,                     // present inside subagents
//   agent_type?: string,
//   tool_name: string,
//   tool_ref: string,                      // 'tool:claude-code:*' | 'mcp__*'
//   cwd?: string,
//   bn_invocation_channel: 'interactive' | 'headless',
//   arg_digest: string,                    // SHA-256 hex (canonicalized tool_input)
//   arg_summary: string,                   // per-tool safe summary — never raw args
//   enforce: boolean,                      // mode at decision time
//   token_source?: 'dev' | 'auth-file',
//   resolve?: {                            // server response — absent when degraded
//     mode, source, side_effect_level,
//     headless_degraded?, undegraded_mode?, reason?
//   },
//   decision: 'allow' | 'ask' | 'deny',    // what the hook actually emitted
//   would_decision: 'allow' | 'ask' | 'deny', // what enforce mode would emit
//   degraded: boolean,                     // resolve failed/timed out/unauthenticated/unparseable input
//   degraded_reason?: string,              // e.g. 'timeout', 'http-503', 'no-token',
//                                          //      'signed-out', 'token-expired' (no COO call made),
//                                          //      'malformed-input', 'shape-drift', 'budget-exhausted',
//                                          //      'internal-error: <message>' (top-level catch)
//   fail_mode?: 'read-fail-open' | 'fail-closed' | 'audit-only-degraded',
//   duration_ms: number
// }

export const AUDIT_RECORD_VERSION = 1;

/**
 * Append a per-call record to the audit queue. Best-effort by design — audit
 * write failures must never affect the hook decision (caller wraps in try).
 */
export function appendAuditRecord(record, env = process.env) {
  ensureStateDir(env);
  appendFileSync(auditQueuePath(env), `${JSON.stringify({ v: AUDIT_RECORD_VERSION, ...record })}\n`);
}

// ── Decision mapping (ADR-0033 §6 isomorphism) ────────────────────────────

/** Policy mode → hook permissionDecision. Headless ask→deny is SERVER-side. */
export function mapModeToDecision(mode) {
  switch (mode) {
    case 'always_allow':
      return 'allow';
    case 'ask':
      return 'ask';
    case 'deny':
      return 'deny';
    default:
      return null; // out-of-vocabulary → caller treats as degraded
  }
}

/**
 * Inverse of mapModeToDecision: hook permissionDecision → policy mode. The audit
 * ingest (COO POST /v1/coo/local/events) validates decision fields against the
 * POLICY-MODE vocabulary (always_allow|ask|deny), so a would-be decision recorded
 * in permissionDecision vocabulary (allow|ask|deny) must be normalized on the way
 * out — otherwise 'allow' is rejected (COO has no 'allow' enum member) and the
 * event never persists. 'ask'/'deny' are spelled identically in both vocabularies.
 */
export function mapDecisionToMode(decision) {
  switch (decision) {
    case 'allow':
      return 'always_allow';
    case 'ask':
      return 'ask';
    case 'deny':
      return 'deny';
    default:
      return null; // out-of-vocabulary → caller omits the field rather than ship an invalid enum
  }
}

/**
 * Side-effect-aware fail-mode when resolve is unavailable:
 * enforce mode: read → fail-open allow; write/external/delete/admin → fail-closed deny.
 * audit-only:   always allow (failures are recorded as degraded).
 *
 * ADR-0033 §8 specifies read → fail-open and write/delete/admin → fail-closed;
 * it is silent on 'external'. This adapter treats 'external' as fail-closed
 * (conservative extension, not part of the ADR table).
 */
export function failModeDecision(sideEffectLevel, enforce) {
  if (!enforce) return { decision: 'allow', failMode: 'audit-only-degraded' };
  if (sideEffectLevel === 'read') return { decision: 'allow', failMode: 'read-fail-open' };
  return { decision: 'deny', failMode: 'fail-closed' };
}

// ── Audit-event emission (brief #5 — async whole-tree audit) ──────────────
//
// The PostToolUse/Subagent emitter ships CloudEvents 1.0 envelopes to COO's
// POST /v1/coo/local/events (brief #3 owns the route + Zod schemas). The wire
// envelope is CloudEvents 1.0 — `id`/`source`/`type`/`subject` map to the
// brief's logical `ce_id`/`ce_source`/`ce_type`/`run_id`. Two distinctions are
// load-bearing:
//   - Raw payloads NEVER leave the machine: `tool_response` is dropped, the
//     failure `error` is truncated, outcome is the only result data shipped.
//   - Detached-worker model: the dispatcher (post-events.mjs) does only
//     synchronous work and hands the envelopes to a detached, unref'd worker
//     (post-events-worker.mjs); the dispatcher itself never calls
//     emitAuditEvent. The worker AWAITS each emitAuditEvent to completion — the
//     POST runs under AbortSignal.timeout(2000), and on a fetch rejection or a
//     retryable non-2xx (401, 5xx, and every 4xx without a recognised
//     permanent code) emitAuditEvent spills synchronously and returns
//     EMIT_SPILLED; a recognised permanent refusal (403 tenant_run_mismatch;
//     400/422 validation_error, which COO's local-events route sends for a
//     rejected payload; 413 payload_too_large) returns EMIT_REJECTED and is
//     dead-lettered instead (see classifyEmitFailure). The spill
//     exists so a failed/timed-out POST is never silently dropped (not because
//     the process exits mid-POST — nothing kills the unparented worker, so the
//     abort always fires and the catch→spill always runs). A spilled `:pre`
//     stays eligible for re-ship on the next drain after COO recovers, because
//     the worker marks a tool_use_id shipped only on EMIT_DELIVERED.

// The deployment's event contract: its /v1/coo/local/events route rejects a
// CloudEvents source or type outside its allow-lists (400 unknown_ce_source /
// unknown_ce_type), and these are the values it lists for this plugin. They
// change only together with the deployment, which must accept a new value
// before the plugin sends it.
export const CE_SOURCE_LOCAL_EXECUTION = 'noblecloak/local-execution/claude-code';
export const CE_TYPE_TOOL_CALL_AUTHORIZED = 'com.noblecloak.tool.call.authorized.v1';
export const CE_TYPE_TOOL_CALL_DENIED = 'com.noblecloak.tool.call.denied.v1';
export const CE_TYPE_SUBAGENT_STARTED = 'com.noblecloak.local.subagent.started.v1';
export const CE_TYPE_SUBAGENT_STOPPED = 'com.noblecloak.local.subagent.stopped.v1';

/** Per-attempt audit POST timeout — the worker awaits this, then spills on abort. */
export const DEFAULT_EVENT_TIMEOUT_MS = 2000;
/** Cap on the shipped failure-message length (no raw payloads off the box). */
export const MAX_ERROR_MESSAGE_LEN = 500;

/**
 * Idempotent ce_id: `<key>:<phase>`. Matches the ingest `(run_id, ce_id)`
 * UNIQUE index so hook retries dedup server-side. The key is the tool_use_id
 * for tool calls and the agent_id for subagent lifecycle events.
 */
export function deriveCeId(key, phase) {
  return `${key}:${phase}`;
}

/**
 * Find the most recent PreToolUse audit record for a tool_use_id. The queue is
 * append-only JSONL; the last matching line wins (a retry's later record
 * supersedes an earlier one). Returns null when none matches or the queue is
 * unreadable — callers degrade gracefully (never crash the emitter).
 */
export function findPreRecord(toolUseId, env = process.env) {
  if (!toolUseId) return null;
  const file = auditQueuePath(env);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue; // skip a torn line, keep scanning
    }
    if (record.hook_event === 'PreToolUse' && record.tool_use_id === toolUseId) {
      return record;
    }
  }
  return null;
}

/**
 * Map a Pre-record to the shipped `data.decision` block (brief #3 D3 shape).
 * When no Pre record exists, degrade with explicit metadata rather than crash
 * — the post-phase event must still ship (the tree needs the outcome).
 */
export function decisionBlockFromPreRecord(pre, opts = {}) {
  const { gatewayGoverned = false } = opts;
  if (!pre) {
    return {
      mode: 'unknown',
      source: 'unknown-no-pre-record',
      side_effect_level: 'unknown',
      enforce_active: false,
    };
  }
  const resolve = pre.resolve && typeof pre.resolve === 'object' ? pre.resolve : {};
  const block = {
    mode: resolve.mode ?? (pre.degraded ? 'degraded' : 'unknown'),
    source: resolve.source ?? (pre.degraded ? pre.degraded_reason || 'degraded' : 'unknown'),
    // Prefer the server-resolved level; when the resolve degraded we have none,
    // but the hook still classified the tool offline to pick its fail-mode —
    // record THAT (from tool_ref) so a degraded audit event explains why it
    // failed open/closed, rather than reporting a useless 'unknown'.
    side_effect_level:
      resolve.side_effect_level ?? (pre.tool_ref ? offlineSideEffectLevel(pre.tool_ref) : 'unknown'),
    // A gateway-governed tool is NEVER locally enforced — the COO gateway is the
    // enforcement point. Force false regardless of what a stale/mismatched Pre
    // record claims, so enforce_active can't depend solely on pre being absent.
    enforce_active: gatewayGoverned ? false : pre.enforce === true,
  };
  if (resolve.headless_degraded !== undefined) block.headless_degraded = resolve.headless_degraded;
  if (resolve.reason !== undefined) block.reason = resolve.reason;
  // audit-only mode records the would-be decision (first-increment toggle).
  // Normalize to COO's policy-mode vocabulary (always_allow|ask|deny): would_decision
  // is in the permissionDecision vocabulary (allow|ask|deny) and COO's ingest rejects
  // 'allow'. Omit rather than ship an out-of-vocabulary value.
  if (pre.enforce !== true && pre.would_decision !== undefined) {
    const mode = mapDecisionToMode(pre.would_decision);
    if (mode !== null) block.would_have_been = mode;
  }
  return block;
}

/** authorized vs denied ce_type from the recorded would-be decision. */
function toolCallCeType(pre) {
  const decision = pre?.would_decision ?? pre?.decision;
  return decision === 'deny' ? CE_TYPE_TOOL_CALL_DENIED : CE_TYPE_TOOL_CALL_AUTHORIZED;
}

/** Truncate a failure message — raw payloads never leave the machine. */
export function sanitizeError(error) {
  if (typeof error !== 'string') return undefined;
  return error.length > MAX_ERROR_MESSAGE_LEN ? `${error.slice(0, MAX_ERROR_MESSAGE_LEN)}…` : error;
}

/** outcome block from a Post-side hook input — NEVER includes tool_response. */
export function outcomeFromPostInput(input) {
  const isFailure = input.hook_event_name === 'PostToolUseFailure';
  const outcome = { ok: !isFailure };
  if (isFailure) {
    const error = sanitizeError(input.error);
    if (error !== undefined) outcome.error = error;
    if (typeof input.is_interrupt === 'boolean') outcome.is_interrupt = input.is_interrupt;
  }
  if (typeof input.duration_ms === 'number') outcome.duration_ms = input.duration_ms;
  return outcome;
}

/**
 * The bn_governance block. Per ADR-0014 the authoritative org/principal are
 * stamped from the JWT SERVER-side; the laptop body carries only the local
 * provenance marker so ingest can distinguish local-execution rows.
 */
function localGovernanceBlock() {
  return { provenance: 'local_execution' };
}

/** Compose a CloudEvents 1.0 envelope (the ingest wire shape). */
function buildEnvelope(ceType, ceId, runId, data, ts = new Date().toISOString()) {
  return {
    specversion: '1.0',
    id: ceId,
    source: CE_SOURCE_LOCAL_EXECUTION,
    type: ceType,
    subject: runId,
    time: ts,
    data,
    bn_governance: localGovernanceBlock(),
  };
}

/**
 * Shared `data` fields for a tool-call event, sourced from the Pre record where
 * available and the Post input otherwise. Carries no raw args/response.
 */
/**
 * The `data.surface` block — SELF-REPORTED host attribution stamped on EVERY
 * tool-call event (D5), not just gateway-governed ones. `reported` is the
 * detected surface (best-effort, 'unknown' for an unrecognized host); `version`
 * is the plugin's own semver when the manifest is readable (omitted otherwise).
 * This block is purely client-supplied and unverified: verified attribution
 * will be a future COO server-stamped field resolved from the token at ingest,
 * NOT a slot in this client-supplied block.
 */
function surfaceBlock(env = process.env) {
  const version = pluginVersion();
  return { reported: detectSurface(env), ...(version ? { version } : {}) };
}

function toolCallData(input, pre, gatewayGoverned = false) {
  const data = {
    tool_ref: pre?.tool_ref ?? toolRefFor(input.tool_name),
    tool_use_id: input.tool_use_id,
    bn_invocation_channel:
      pre?.bn_invocation_channel ?? detectChannel(process.env.CLAUDE_CODE_ENTRYPOINT, input.agent_id),
    decision: decisionBlockFromPreRecord(pre, { gatewayGoverned }),
  };
  const agentId = pre?.agent_id ?? input.agent_id;
  const agentType = pre?.agent_type ?? input.agent_type;
  const cwd = pre?.cwd ?? input.cwd;
  if (agentId) data.agent_id = agentId;
  if (agentType) data.agent_type = agentType;
  if (cwd) data.cwd = cwd;
  if (pre?.arg_digest) data.arg_digest = pre.arg_digest;
  if (pre?.arg_summary) data.arg_summary = pre.arg_summary;
  data.surface = surfaceBlock(process.env);
  // Gateway-governed calls are logged locally as an INDEPENDENT corroborating
  // record; the COO gateway's action-ledger audit remains the sole authoritative
  // record. The marker links the two without cross-writing either (D4).
  if (gatewayGoverned) data.bn_corroborated_by = 'action_ledger';
  return data;
}

/**
 * Build the tool-call envelope(s) for a Post-side hook input. `pre` is the
 * joined Pre record (or null); `opts` = { gatewayGoverned, ts }.
 *
 * Default (gatewayGoverned:false) — a local governed tool: TWO envelopes, the
 * pre-phase (decision only) and post-phase (decision + outcome). Both fire
 * independently — the pre event is NOT held back waiting for a Post that may
 * never come (the fabricated-success defense).
 *
 * gatewayGoverned:true (D3) — a NobleCloak MCP tool governed by the COO gateway:
 * exactly ONE envelope, the :post. The plugin never emitted a :pre for it (the
 * PreToolUse hook allows it without a resolve/audit record), so there is no
 * pre-phase to ship; the single :post is an INDEPENDENT corroborating record
 * (bn_corroborated_by:'action_ledger', enforce_active:false) alongside the
 * gateway's authoritative action-ledger audit (D1/D4).
 */
export function buildToolCallEnvelopes(input, pre, opts = {}) {
  const { gatewayGoverned = false, ts = new Date().toISOString() } = opts;
  // A gateway-governed corroboration record must NEVER ship typed `denied`: the
  // COO gateway already authorized (and audited) the call, so this local :post
  // is always the AUTHORIZED ce_type regardless of what a stale/colliding Pre
  // record's would_decision claims. Mirrors the enforce_active:false forcing in
  // decisionBlockFromPreRecord. A PostToolUseFailure stays authorized too — a
  // runtime failure is not a denial (it rides outcome.ok:false).
  const ceType = gatewayGoverned ? CE_TYPE_TOOL_CALL_AUTHORIZED : toolCallCeType(pre);
  const base = toolCallData(input, pre, gatewayGoverned);
  const postEnvelope = buildEnvelope(
    ceType,
    deriveCeId(input.tool_use_id, 'post'),
    input.session_id,
    { ...base, outcome: outcomeFromPostInput(input) },
    ts
  );
  if (gatewayGoverned) return [postEnvelope];
  const preEnvelope = buildEnvelope(ceType, deriveCeId(input.tool_use_id, 'pre'), input.session_id, { ...base }, ts);
  return [preEnvelope, postEnvelope];
}

/** Build a subagent lifecycle envelope (started/stopped). */
export function buildSubagentEnvelope(input, ts = new Date().toISOString()) {
  const started = input.hook_event_name === 'SubagentStart';
  const ceType = started ? CE_TYPE_SUBAGENT_STARTED : CE_TYPE_SUBAGENT_STOPPED;
  const phase = started ? 'started' : 'stopped';
  const data = {
    agent_id: input.agent_id,
    bn_invocation_channel: detectChannel(process.env.CLAUDE_CODE_ENTRYPOINT, input.agent_id),
  };
  if (input.agent_type) data.agent_type = input.agent_type;
  if (input.cwd) data.cwd = input.cwd;
  if (!started && input.agent_transcript_path) data.agent_transcript_path = input.agent_transcript_path;
  return buildEnvelope(ceType, deriveCeId(input.agent_id, phase), input.session_id, data, ts);
}

/**
 * Append a failed audit envelope to the spill file. Synchronous append (same
 * posture as appendAuditRecord) so a failed/timed-out POST is durably recorded
 * before the worker moves on — the worker AWAITS each emit to completion, so
 * this is not racing a process exit; it is the durable record of an envelope
 * that did not reach ingest. Wrapped by emitAuditEvent so a spill-write failure
 * (ENOSPC/EACCES/read-only FS) cannot break emitAuditEvent's never-throws
 * contract; if you call it directly, guard it yourself.
 */
export function spillAuditEvent(envelope, env = process.env) {
  ensureStateDir(env);
  appendFileSync(auditSpillPath(env), `${JSON.stringify(envelope)}\n`);
}

/** emitAuditEvent outcome: the envelope reached ingest (2xx) vs only spilled. */
export const EMIT_DELIVERED = 'delivered';
export const EMIT_SPILLED = 'spilled';
/**
 * emitAuditEvent outcome: COO refused the envelope PERMANENTLY with a
 * recognised code (see classifyEmitFailure), or the run is already known to be
 * refused for the current org. Not spilled for retry, not an outage (breaker
 * untouched); the envelope goes to the bounded dead-letter tail and the caller
 * marks the record dead so the drain never re-sends it.
 */
export const EMIT_REJECTED = 'rejected';

/**
 * COO error codes that make a refusal permanent, by HTTP status. Only these are
 * dead-lettered; every other 4xx is retried. Codes are the COO API's
 * `{ error: { code } }` envelope: 403 `tenant_run_mismatch` (BN004 from the
 * coo_run_events trigger), `validation_error` (its ValidationError, 422;
 * COO's local-events route sends it on 400 for a rejected payload) and
 * `payload_too_large` (413: the body cap is route-local, so an envelope over
 * it never fits on a retry).
 *
 * The same route keeps 400 `bad_request` for a server fault, which stays
 * transient.
 */
const PERMANENT_ERROR_CODES = {
  400: new Set(['validation_error']),
  403: new Set(['tenant_run_mismatch']),
  413: new Set(['payload_too_large']),
  422: new Set(['validation_error']),
};

/**
 * Classify a non-2xx ingest response from its status and the COO error `code`:
 *   'auth'      — 401 (the token was refused; refresh at most once per token, and
 *                 count toward the breaker)
 *   'permanent' — 403 `tenant_run_mismatch`, 400/422 `validation_error`, or
 *                 413 `payload_too_large` (see above):
 *                 re-sending the same envelope can never succeed.
 *   'transient' — everything else: 5xx, 408, 429, and every other 4xx (404,
 *                 409, a 413 with no or another code, a 403 with no or another code, …) → spill + breaker.
 *                 An unrecognised refusal is never treated as permanent, so an
 *                 audit event is never dropped on a status alone.
 */
export function classifyEmitFailure(status, code = null) {
  if (status === 401) return 'auth';
  if (typeof code === 'string' && PERMANENT_ERROR_CODES[status]?.has(code)) return 'permanent';
  return 'transient';
}

/** COO error envelope `{ error: { code, message, details }, meta }` → code, or null. Never throws. */
async function errorCodeOf(response) {
  try {
    const body = await response.json();
    return typeof body?.error?.code === 'string' ? body.error.code : null;
  } catch {
    return null;
  }
}

/** The org bound into the bearer we sent (token claim, else auth.json's orgId). */
function bearerOrgId(bearer, env) {
  const claims = decodeJwtClaims(bearer?.token);
  if (typeof claims?.org_id === 'string') return claims.org_id;
  if (bearer?.source === 'auth-file') return loadAuthState(env)?.orgId;
  return undefined;
}

// ── Run ↔ org bindings + dead letters (permanent rejections) ───────────────
//
// COO keys local audit on the Claude Code session id as run_id and seeds that
// run in the org of the FIRST token that posts to it (the COO API's
// local-events route). A later event for the run from a token
// in ANOTHER org is refused by the coo_run_events trigger (BN004 → 403
// tenant_run_mismatch) — permanently for that run, and a resumed Claude Code
// session keeps its session id. So the plugin remembers, per session:
//   <state dir>/audit-runs.json = { <session>: { orgId?, deliveredAt?,
//                                           rejected?: { at, orgId, code } } }
// `orgId` is the org a delivery succeeded under (the run's org, when known);
// `rejected.orgId` is the org whose token was refused. Events for a rejected
// run skip the network only while the current token is KNOWN to be in that
// same org (an unknown org on either side attempts delivery); signing back in
// to the run's original org clears it on the next delivery.

/**
 * How long a recorded run rejection suppresses sends. Past it the next event
 * probes COO once; a fresh 403 tenant_run_mismatch re-records the rejection
 * (the session's notice is not repeated), a delivery clears it. So a refusal
 * fixed server-side, or one learned in error, costs at most one hour of
 * dead-lettered events instead of suppressing the session forever.
 */
export const AUDIT_RUN_REJECTION_TTL_MS = 60 * 60 * 1000;
/** Cap on remembered sessions in audit-runs.json (newest kept). */
const AUDIT_RUNS_RETENTION = 128;
/** Cap on retained audit-dead.jsonl lines (forensic tail, like the spill). */
export const AUDIT_DEAD_LETTER_RETENTION = 256;

export const TENANT_RUN_MISMATCH_MESSAGE =
  "NobleCloak: this Claude Code session's audit run belongs to a different org than your current sign-in, " +
  'so NobleCloak refuses its audit events. Start a new Claude Code session (or sign back in to the original org) ' +
  'to resume audit delivery.';

export function auditRunsPath(env = process.env) {
  return join(stateDir(env), 'audit-runs.json');
}

export function auditDeadLetterPath(env = process.env) {
  return join(stateDir(env), 'audit-dead.jsonl');
}

export function auditHealthPath(env = process.env) {
  return join(stateDir(env), 'audit-health.json');
}

export function readAuditRuns(env = process.env) {
  const file = auditRunsPath(env);
  if (!existsSync(file)) return {};
  try {
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : {};
  } catch {
    return {};
  }
}

function writeAuditRuns(runs, env) {
  try {
    ensureStateDir(env);
    const entries = Object.entries(runs).slice(-AUDIT_RUNS_RETENTION);
    atomicWriteFileSync(auditRunsPath(env), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // best-effort — the next 403 re-learns a rejection
  }
}

/** A delivery succeeded for `sessionId` under `orgId`: remember the run's org; clear any rejection. */
export function recordRunDelivered(sessionId, orgId, env = process.env) {
  if (typeof sessionId !== 'string') return;
  const runs = readAuditRuns(env);
  const prev = runs[sessionId];
  if (prev && prev.orgId === orgId && !prev.rejected) return; // nothing new — no write per event
  delete runs[sessionId];
  runs[sessionId] = { ...(orgId ? { orgId } : {}), deliveredAt: prev?.deliveredAt ?? new Date().toISOString() };
  writeAuditRuns(runs, env);
  if (prev?.rejected) clearNotice(`tenant_run_mismatch:${sessionId}`, env);
}

/** COO refused `sessionId`'s run for a token in `orgId` (403 tenant_run_mismatch). Queues the session's notice. */
export function recordRunRejected(sessionId, orgId, code, env = process.env) {
  if (typeof sessionId !== 'string') return;
  const runs = readAuditRuns(env);
  const prev = runs[sessionId] ?? {};
  delete runs[sessionId];
  runs[sessionId] = { ...prev, rejected: { at: new Date().toISOString(), ...(orgId ? { orgId } : {}), code } };
  writeAuditRuns(runs, env);
  postNotice(`tenant_run_mismatch:${sessionId}`, TENANT_RUN_MISMATCH_MESSAGE, env, { sessionId });
}

/**
 * True when `sessionId`'s run is known to refuse tokens of `orgId`: only when
 * the rejection is younger than AUDIT_RUN_REJECTION_TTL_MS and BOTH the
 * refused org and the current token's org are known and equal. When
 * either is unknown (a dev token or a token with no org claim and no
 * auth.json orgId) delivery is attempted and COO decides.
 */
export function isRunRejected(sessionId, orgId, env = process.env, now = Date.now()) {
  if (typeof sessionId !== 'string') return false;
  const rejected = readAuditRuns(env)[sessionId]?.rejected;
  if (!rejected) return false;
  // Expired (or an unreadable timestamp) → not suppressed: attempt delivery.
  const at = Date.parse(rejected.at);
  if (!Number.isFinite(at) || now - at >= AUDIT_RUN_REJECTION_TTL_MS) return false;
  return Boolean(rejected.orgId && orgId && rejected.orgId === orgId);
}

/** Read the small audit health counters file. Never throws. */
export function readAuditHealth(env = process.env) {
  const file = auditHealthPath(env);
  if (!existsSync(file)) return {};
  try {
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    return rec && typeof rec === 'object' ? rec : {};
  } catch {
    return {};
  }
}

/** Read-modify-write the health counters. Best-effort (racy by design, like the breaker). */
function updateAuditHealth(fn, env) {
  try {
    const next = fn(readAuditHealth(env));
    ensureStateDir(env);
    atomicWriteFileSync(auditHealthPath(env), JSON.stringify(next));
  } catch {
    // best-effort — counters are diagnostics
  }
}

/**
 * Append a permanently-refused envelope to the bounded dead-letter tail and bump
 * the dead-letter counter. The envelope carries no raw tool args (only the
 * digest/safe summary), same as the spill. Best-effort, never throws.
 */
export function recordDeadLetter(envelope, status, code, env = process.env) {
  try {
    ensureStateDir(env);
    appendFileSync(
      auditDeadLetterPath(env),
      `${JSON.stringify({ time: new Date().toISOString(), status, code, envelope })}\n`
    );
  } catch {
    // best-effort
  }
  updateAuditHealth(
    (h) => ({
      ...h,
      deadLettered: {
        ...h.deadLettered,
        total: (h.deadLettered?.total ?? 0) + 1,
        lastAt: new Date().toISOString(),
        lastCode: code ?? null,
      },
    }),
    env
  );
}

/**
 * Bound the dead-letter tail to AUDIT_DEAD_LETTER_RETENTION lines and COUNT
 * what was trimmed: `deadLettered.trimmed` in audit-health.json, shown by
 * /noblecloak-status, so forensic loss past the cap is never silent. Best-effort.
 */
export function boundAuditDeadLetters(env = process.env) {
  const { dropped } = boundJsonlTail(auditDeadLetterPath(env), AUDIT_DEAD_LETTER_RETENTION);
  if (dropped > 0) {
    updateAuditHealth(
      (h) => ({
        ...h,
        deadLettered: {
          ...h.deadLettered,
          trimmed: (h.deadLettered?.trimmed ?? 0) + dropped,
          lastTrimmedAt: new Date().toISOString(),
        },
      }),
      env
    );
  }
  return { dropped };
}

// A 401 refresh is spent at most once per access token. The token a 401-driven
// refresh minted is remembered (<state dir>/auth-401.json = { mintedFp, at }, a
// fingerprint, never the token); if THAT token draws a 401 too, COO is refusing
// fresh tokens (an audience/issuer mismatch), so refreshing again would only add
// a grant per emit. Same for a token an expiry refresh minted in this call.
function unauthorizedStatePath(env) {
  return join(stateDir(env), 'auth-401.json');
}

/** True when a 401 on `bearer` may be answered with a refresh. Never throws. */
function mayRefreshAfterUnauthorized(bearer, env) {
  if (bearer.source !== 'auth-file' || bearer.refreshed) return false;
  try {
    const file = unauthorizedStatePath(env);
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf-8'))?.mintedFp === tokenFingerprint(bearer.token)) {
      return false;
    }
  } catch {
    // unreadable → allow the one refresh
  }
  return !refreshBackoffActive(loadAuthState(env), env);
}

/**
 * Refresh after a 401 on the emit path. Success remembers the minted token; a
 * REJECTED grant signs the plugin out; a transient failure stamps the refresh
 * backoff. Never throws.
 */
async function refreshAfterUnauthorized(env) {
  try {
    const updated = await refreshAuthState(env, { deadline: Date.now() + DEFAULT_TOTAL_BUDGET_MS, signedOutSince: Date.now() });
    clearSignedOut(env);
    clearRefreshBackoff(env);
    try {
      ensureStateDir(env);
      atomicWriteFileSync(unauthorizedStatePath(env), JSON.stringify({ mintedFp: tokenFingerprint(updated.accessToken), at: Date.now() }));
    } catch {
      // best-effort — without it a second 401 may cost one more grant
    }
  } catch (err) {
    if (err?.code === 'SIGNED_OUT') return;
    if (isRejectedRefresh(err)) writeSignedOut(err.message, env, { credentialFp: err.credentialFp });
    else writeRefreshBackoff(err, env);
  }
}

/**
 * Best-effort spill that can itself never throw — preserves emitAuditEvent's
 * never-throws contract even when the machine is already degraded (disk full,
 * read-only FS), which is precisely when the underlying POST is failing too.
 */
function spillAuditEventGuarded(envelope, env, logErr) {
  try {
    spillAuditEvent(envelope, env);
  } catch (err) {
    // The spill is itself best-effort: if even the local append fails we have
    // nowhere durable to put the record, but we must not break the contract.
    logErr?.(`spill write failed (${err?.message || err}) — envelope not durably recorded.`);
  }
}

// ── Circuit breaker (brief 2026-06-15 D1) ──────────────────────────────────
//
// A sustained COO outage under a wide agent fan-out used to melt the host:
// every emit kept hitting the network (2s timeout each), detached workers piled
// up, and the spill grew unbounded. The breaker makes a run of consecutive emit
// failures FAST-FAIL (spill, no network) for a cooldown window, then half-opens
// to probe. State is shared across the INDEPENDENT detached workers via a small
// JSON file in the state dir. Increments race under concurrency — that is fine
// by design: the load-bearing property is "once open, every reader fast-fails,"
// not an exact failure count. So there is intentionally NO lock around the
// counter (a lock would re-introduce contention under the very fan-out we are
// protecting against).

/** Consecutive emit failures that trip the breaker open (env-overridable). */
export const AUDIT_BREAKER_THRESHOLD = 5;
/** Cooldown before an open breaker half-opens to probe (env-overridable). */
export const AUDIT_BREAKER_COOLDOWN_MS = 30_000;

export function breakerStatePath(env = process.env) {
  return join(stateDir(env), 'audit-breaker.json');
}

// Half-open single-flight: when the cooldown elapses the breaker flips to
// half_open for EVERY reader at once. Without a gate, every concurrent emit
// (across detached workers AND the concurrent emits inside one worker's
// Promise.allSettled) would hit the still-down COO with the full timeout
// simultaneously — the exact thundering-herd the breaker exists to prevent. The
// probe is gated to ONE in-flight network call via this non-blocking lock;
// readers that cannot take it spill. The stale window lets a crashed prober's
// lock be stolen so recovery is not wedged longer than this.
const BREAKER_PROBE_LOCK_NAME = 'audit-breaker-probe.lock';
const BREAKER_PROBE_LOCK_STALE_MS = 5_000;

function breakerThreshold(env) {
  const n = Number.parseInt(env.NOBLECLOAK_AUDIT_BREAKER_THRESHOLD ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : AUDIT_BREAKER_THRESHOLD;
}

function breakerCooldownMs(env) {
  // Require > 0 (matching breakerThreshold above), NOT >= 0. A 0ms cooldown
  // would make readBreaker classify the breaker as half_open the instant it
  // opens — the "open" fast-fail phase (the whole point of the breaker:
  // suppress the network during an outage) could then never be observed, and
  // every reader would re-compete for the probe lock immediately. So a
  // malformed/zero/negative env ('', 'abc', '0', '-5') falls back to the
  // default rather than silently voiding the suppression window.
  const n = Number.parseInt(env.NOBLECLOAK_AUDIT_BREAKER_COOLDOWN_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : AUDIT_BREAKER_COOLDOWN_MS;
}

/** Raw `{ failures, openedAt }` from disk; closed defaults on missing/corrupt. */
function readBreakerRaw(env) {
  const file = breakerStatePath(env);
  if (!existsSync(file)) return { failures: 0, openedAt: null };
  try {
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    return {
      failures: Number.isFinite(rec.failures) ? rec.failures : 0,
      openedAt: Number.isFinite(rec.openedAt) ? rec.openedAt : null,
    };
  } catch {
    return { failures: 0, openedAt: null }; // torn/corrupt → read as closed
  }
}

function writeBreakerRaw(state, env) {
  try {
    ensureStateDir(env);
    atomicWriteFileSync(breakerStatePath(env), JSON.stringify(state));
  } catch {
    // Best-effort — the breaker is a heuristic; a write failure just means the
    // next emit re-evaluates from whatever is (or is not) on disk.
  }
}

/**
 * The breaker phase at `now` (epoch ms). Never throws.
 *   - closed     → openedAt null (normal; attempt the network)
 *   - open       → opened, within cooldown (FAST-FAIL: spill, no network)
 *   - half_open  → opened, cooldown elapsed (allow ONE probe attempt)
 */
export function readBreaker(env = process.env, now = Date.now()) {
  const { failures, openedAt } = readBreakerRaw(env);
  if (openedAt === null) return { phase: 'closed', failures, openedAt: null };
  if (now - openedAt >= breakerCooldownMs(env)) return { phase: 'half_open', failures, openedAt };
  return { phase: 'open', failures, openedAt };
}

/** The once-per-session notice queued when the breaker opens. */
export const BREAKER_OPEN_MESSAGE =
  'NobleCloak: audit delivery to COO is failing (the circuit breaker opened after repeated errors). ' +
  'Tool-call audit events are being kept locally and retried in the background; run /noblecloak-status for details.';

/** Record a delivered emit — closes the breaker and clears the failure run (and its notice). */
export function recordBreakerSuccess(env = process.env) {
  const { openedAt } = readBreakerRaw(env);
  writeBreakerRaw({ failures: 0, openedAt: null }, env);
  if (openedAt !== null) clearNotice('breaker-open', env);
}

/**
 * Record a failed emit. Increments the consecutive-failure run and (re-)arms the
 * cooldown from `now` once the run reaches the threshold — this both opens a
 * closed breaker that just crossed K and re-opens a half-open breaker whose
 * probe just failed.
 */
export function recordBreakerFailure(env = process.env, now = Date.now()) {
  const { failures, openedAt } = readBreakerRaw(env);
  const nextFailures = failures + 1;
  const nextOpenedAt = nextFailures >= breakerThreshold(env) ? now : openedAt;
  writeBreakerRaw({ failures: nextFailures, openedAt: nextOpenedAt }, env);
  // closed → open: the user hears about it once per session (the detached
  // worker can't show anything itself; the next synchronous hook does).
  if (openedAt === null && nextOpenedAt !== null) postNotice('breaker-open', BREAKER_OPEN_MESSAGE, env);
}

// ── Worker watchdog deadline (brief 2026-06-15 D3) ─────────────────────────
//
// The hard process-level worker watchdog deadline. Lives here (not only in
// post-events-worker.mjs) because TWO independent concerns depend on it:
//   1. the worker arms a setTimeout(deadline) backstop so it can never outlive
//      this bound regardless of a hung endpoint; and
//   2. the SHARED drain-lock stale window must be >= this deadline, or a
//      watchdog kill could leave the drain lock stealable by a second worker
//      while the original holder is still (briefly) alive — re-introducing the
//      concurrent re-ship the single-flight lock exists to prevent. Deriving the
//      drain-lock stale window from THIS accessor (see acquireDrainLock) keeps
//      that invariant intact even when an operator overrides the deadline.
//
// Falls back to 10s on a non-finite or <= 0 value so a malformed env
// ('', 'abc', '0', '-5') can never arm a 0ms/NaN deadline that would
// self-terminate the worker at t=0 (dropping every in-band emit). The worker
// re-exports this so the default + bad-env fallback are unit-tested directly.
export const AUDIT_WORKER_DEADLINE_MS = 10_000;

export function workerDeadlineMs(env = process.env) {
  const n = Number.parseInt(env.NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : AUDIT_WORKER_DEADLINE_MS;
}

/**
 * Record a countable degraded marker for a worker that exited mid-work (e.g. the
 * watchdog deadline fired while it was still shipping). exit(0) is an
 * unconditional success signal, yet such a worker may have shipped only part of
 * its obligation — so the loss must be VISIBLE in the audit data, not look
 * identical to a clean exit. The durability invariant is preserved regardless:
 * the unshipped obligation lives in audit-queue.jsonl, deferred to the next
 * event. Best-effort, NEVER throws — it fires exactly when the FS may be
 * degraded (the same condition that can make a spill fail), and a throw here
 * would surface as an uncaught exception inside the watchdog timer callback.
 */
export function recordWorkerDegraded(reason, env = process.env) {
  try {
    const marker = {
      bn_degraded: true,
      degraded_side: 'worker',
      degraded_reason: reason,
      time: new Date().toISOString(),
    };
    spillAuditEvent(marker, env);
  } catch {
    // best-effort — nowhere durable to record it, but the contract is no-throw.
  }
}

/**
 * POST one envelope to the events endpoint and report whether it reached ingest.
 *
 * Returns EMIT_DELIVERED on a 2xx; EMIT_REJECTED when COO refuses it
 * permanently (403 tenant_run_mismatch, 400/422 validation_error, or 413
 * payload_too_large — see classifyEmitFailure) or its run is already known refused for this org —
 * dead-lettered, never spilled, breaker untouched; and EMIT_SPILLED otherwise
 * (no usable token, breaker open, network failure, timeout, 401, 5xx, and every
 * other 4xx) — having spilled the envelope to
 * audit-spill.jsonl. The spill exists so a
 * failed/timed-out POST is never silently dropped; the worker AWAITS this to
 * completion, so the spill is not racing a process exit.
 *
 * The DELIVERED/SPILLED distinction is load-bearing for the shipped ledger: a
 * spilled `:pre` (COO outage) must stay eligible for re-ship on the next drain
 * after recovery, so the worker marks a tool_use_id shipped only on DELIVERED
 * (server-side `(run_id, ce_id)` dedup makes a later re-ship of an already-
 * delivered envelope harmless).
 *
 * Never throws — a rejected fetch is caught and spilled, and the spill write is
 * itself guarded (a spill-write failure on a degraded FS is logged, not thrown).
 * Auth goes through usableBearer: the dev token is honored; an auth-file token
 * is checked against its local expiry first and refreshed once if expired (a
 * known-expired token is never sent); a signed-out plugin makes no COO call.
 */
export async function emitAuditEvent(envelope, env = process.env, logErr) {
  const bearer = await usableBearer(env, { deadline: Date.now() + DEFAULT_TOTAL_BUDGET_MS });
  if (!bearer.token) {
    // Logged out (no auth.json, signed-out marker, or an expired token whose
    // refresh did not succeed) is NOT an outage — never touch the breaker here,
    // or a logged-out session would trip it and suppress the probe the moment
    // auth returns.
    spillAuditEventGuarded(envelope, env, logErr);
    return EMIT_SPILLED;
  }

  // A run COO already refused for this org will refuse every later event too
  // (resumed sessions keep their id): no network, no spill, no breaker.
  if (isRunRejected(envelope?.subject, bearerOrgId(bearer, env), env)) {
    recordDeadLetter(envelope, null, 'tenant_run_mismatch (known)', env);
    return EMIT_REJECTED;
  }

  const phase = readBreaker(env).phase;

  // Breaker open → fast-fail: spill and skip the network entirely (no POST, no
  // breaker write). The cooldown will half-open us for a probe.
  if (phase === 'open') {
    spillAuditEventGuarded(envelope, env, logErr);
    return EMIT_SPILLED;
  }

  // Breaker half-open → allow exactly ONE probe. Take the non-blocking probe
  // lock; if another emit is already probing (lock held by a live prober) this
  // reader spills without touching the network — single-flight, no thundering
  // herd. A crashed prober's stale lock is stolen (older than the stale window)
  // so recovery is never wedged. The lock is released in `finally` regardless of
  // the network outcome so the next half-open window can probe again.
  let probeLock = null;
  if (phase === 'half_open') {
    probeLock = tryAcquireLock(BREAKER_PROBE_LOCK_NAME, BREAKER_PROBE_LOCK_STALE_MS, env);
    if (!probeLock) {
      spillAuditEventGuarded(envelope, env, logErr);
      return EMIT_SPILLED;
    }
  }

  try {
    const url = `${cooBaseUrl(env)}${EVENTS_PATH}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer.token}`,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(DEFAULT_EVENT_TIMEOUT_MS),
        // Don't pool/persist the socket past this request — a detached worker is
        // short-lived and the watchdog (brief D3) hard-bounds its life, so a
        // lingering keep-alive connection would only leak fds during an outage.
        keepalive: false,
      });
    } catch {
      recordBreakerFailure(env);
      spillAuditEventGuarded(envelope, env, logErr);
      return EMIT_SPILLED;
    }
    if (response.ok) {
      recordBreakerSuccess(env);
      recordRunDelivered(envelope?.subject, bearerOrgId(bearer, env), env);
      return EMIT_DELIVERED;
    }
    // Read the COO error code first: permanence depends on it, not the status alone.
    const code = response.status === 401 ? null : await errorCodeOf(response);
    const failure = classifyEmitFailure(response.status, code);
    if (failure === 'auth') {
      // 401: the token was refused (revoked, the clocks disagree, or COO does
      // not accept tokens from this issuer/audience at all). It counts toward
      // the breaker, so a COO that refuses every token stops being called after
      // the threshold. Refresh at most once per token (mayRefreshAfterUnauthorized);
      // a rejected grant writes the signed-out marker. The envelope is kept
      // (spill; a :pre stays drain-eligible).
      recordBreakerFailure(env);
      if (mayRefreshAfterUnauthorized(bearer, env)) await refreshAfterUnauthorized(env);
      spillAuditEventGuarded(envelope, env, logErr);
      return EMIT_SPILLED;
    }
    if (failure === 'permanent') {
      recordDeadLetter(envelope, response.status, code, env);
      if (code === 'tenant_run_mismatch') recordRunRejected(envelope?.subject, bearerOrgId(bearer, env), code, env);
      logErr?.(`ingest refused ${envelope?.id} permanently (${response.status}${code ? ` ${code}` : ''}) — dead-lettered, not retried.`);
      return EMIT_REJECTED;
    }
    if (response.status >= 400 && response.status < 500) {
      logErr?.(`ingest refused ${envelope?.id} (${response.status}${code ? ` ${code}` : ''}) — not a recognised permanent refusal; spilled for retry.`);
    }
    recordBreakerFailure(env);
    spillAuditEventGuarded(envelope, env, logErr);
    return EMIT_SPILLED;
  } finally {
    // Release the half-open probe lock on EVERY exit (2xx, non-2xx, fetch-throw)
    // so a leaked lock can never block the next probe. No-op when closed (lock
    // was never taken).
    if (probeLock) releaseLock(probeLock.lockPath, probeLock.ownerToken);
  }
}

// ── Local governance/audit health snapshot (/noblecloak-status) ──────────────

/** Line count and byte size of a JSONL file ({ records: 0, bytes: 0 } when absent). Never throws. */
function jsonlSize(file) {
  try {
    if (!existsSync(file)) return { records: 0, bytes: 0 };
    const buf = readFileSync(file);
    let records = 0;
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) records += 1;
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) records += 1;
    return { records, bytes: buf.length };
  } catch {
    return { records: 0, bytes: 0 };
  }
}

/**
 * Everything /noblecloak-status reports about local governance + audit state that
 * used to be invisible: sign-in state, token expiry, the org of the current
 * token vs the org bound to a session's audit run, the breaker, queue/spill
 * sizes, unshipped records dropped by the caps, and dead letters. `sessionId`
 * (optional) selects which run to compare; without it the most recent refused
 * run is reported. Never throws.
 */
export function localAuditStatus(env = process.env, { sessionId = null, now = Date.now() } = {}) {
  const auth = loadAuthState(env);
  const marker = readSignedOut(env);
  const identity = tokenIdentity(auth);
  const runs = readAuditRuns(env);
  const health = readAuditHealth(env);
  const breaker = readBreaker(env, now);
  const rejectedRuns = Object.entries(runs)
    .filter(([, r]) => r?.rejected)
    .map(([id, r]) => {
      const at = Date.parse(r.rejected.at);
      const retryAt = Number.isFinite(at) ? new Date(at + AUDIT_RUN_REJECTION_TTL_MS).toISOString() : null;
      return { sessionId: id, ...r.rejected, runOrgId: r.orgId, retryAt };
    });
  const session = sessionId && runs[sessionId] ? { sessionId, ...runs[sessionId] } : null;
  return {
    signedIn: Boolean(auth?.accessToken) && !marker,
    signedOut: marker ? { since: marker.since ?? null, reason: marker.reason ?? null, checkedAt: marker.checkedAt ?? null } : null,
    loggedIn: Boolean(auth?.accessToken),
    tokenExpiresAt: Number.isFinite(auth?.expiresAt) ? new Date(auth.expiresAt).toISOString() : null,
    tokenExpired: auth ? isTokenExpired(auth, now) : null,
    currentOrgId: identity?.orgId ?? null,
    session,
    rejectedRuns,
    breaker: {
      phase: breaker.phase,
      failures: breaker.failures,
      ...(breaker.openedAt !== null
        ? { openedAt: new Date(breaker.openedAt).toISOString(), retryAt: new Date(breaker.openedAt + breakerCooldownMs(env)).toISOString() }
        : {}),
    },
    queue: jsonlSize(auditQueuePath(env)),
    spill: jsonlSize(auditSpillPath(env)),
    unshippedDropped: health.unshippedDropped ?? { total: 0 },
    deadLettered: health.deadLettered ?? { total: 0 },
  };
}

// ── Shipped ledger + Pre-without-Post drain (fabricated-success defense) ────
//
// A call that is denied/blocked in enforce mode — or a blocked subagent tool
// call that fabricates success — never fires a PostToolUse, so the only
// truthful record of it is the Pre-side decision. That Pre envelope must reach
// ingest INDEPENDENTLY of any Post (brief Goal: "the calls that never produced
// a Post event"). We achieve this with:
//   - a shipped ledger: every tool_use_id whose `:pre` envelope has been
//     handed to ingest is recorded here, so we never double-ship; and
//   - a drain: walk the Pre queue and ship the `:pre` envelope for every
//     tool_use_id NOT yet in the ledger. The dispatcher drains on SubagentStop
//     (a natural tree-segment boundary) and on session-wide events, catching
//     any Pre that a Post never reconciled. Server-side `(run_id, ce_id)`
//     dedup makes a late Post's own `:pre` harmless if it later arrives.

/** Record that a tool_use_id's `:pre` envelope has been shipped (POST or spill). */
export function markPreShipped(toolUseId, env = process.env) {
  if (!toolUseId) return;
  ensureStateDir(env);
  appendFileSync(auditSentPath(env), `${JSON.stringify({ tool_use_id: toolUseId })}\n`);
}

/**
 * Record that a tool_use_id's `:pre` was REFUSED permanently (EMIT_REJECTED).
 * It goes in the same ledger as delivered ones — the ledger means "handled,
 * never re-send" — tagged `dead: true` for forensics.
 */
export function markPreDead(toolUseId, env = process.env) {
  if (!toolUseId) return;
  ensureStateDir(env);
  appendFileSync(auditSentPath(env), `${JSON.stringify({ tool_use_id: toolUseId, dead: true })}\n`);
}

/** Set of tool_use_ids whose `:pre` envelope has already been shipped (or dead-lettered). */
export function loadShippedSet(env = process.env) {
  const file = auditSentPath(env);
  const set = new Set();
  if (!existsSync(file)) return set;
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return set;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (typeof rec.tool_use_id === 'string') set.add(rec.tool_use_id);
    } catch {
      // torn line — skip, keep scanning
    }
  }
  return set;
}

/**
 * Every PreToolUse record currently in the audit queue, most-recent-wins per
 * tool_use_id (a retry's later record supersedes an earlier one). Unreadable
 * queue → empty (the emitter never crashes on a degraded queue).
 */
export function readPreRecords(env = process.env) {
  const file = auditQueuePath(env);
  if (!existsSync(file)) return [];
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // torn line — skip
    }
    if (record.hook_event === 'PreToolUse' && typeof record.tool_use_id === 'string') {
      byId.set(record.tool_use_id, record); // later line wins
    }
  }
  return [...byId.values()];
}

/** Max envelopes one drain ships (oldest-first). Env-overridable. Brief D2. */
export const AUDIT_DRAIN_CAP = 50;

function drainCap(env) {
  const n = Number.parseInt(env.NOBLECLOAK_AUDIT_DRAIN_CAP ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : AUDIT_DRAIN_CAP;
}

// Single-flight the drain so many concurrent workers never re-ship the same
// backlog at once (the meltdown driver). Reuses the same non-blocking O_EXCL
// primitive compaction uses; a worker that can't take the lock skips its drain.
const DRAIN_LOCK_NAME = 'audit-drain.lock';

// Floor for the drain-lock stale window. The drain lockfile mtime is set once at
// creation and never heartbeated, so its age is wall-clock-since-acquisition,
// not liveness; a too-short window steals a still-live holder's lock.
const DRAIN_LOCK_STALE_FLOOR_MS = 10_000;

/**
 * Stale window for the drain lock, DERIVED from the worker watchdog deadline
 * (workerDeadlineMs(), default 10s — both live in this module so the coupling is
 * grep-verifiable) rather than a hardcoded constant. Invariant: the stale window
 * must be >= the watchdog deadline. The watchdog hard-bounds a worker's life at
 * the deadline, so a drain holder cannot still be alive past it; keeping the
 * stale window at/above the deadline guarantees a lock is only ever stolen as
 * "stale" AFTER its holder is provably dead. If this is read at acquire time
 * from the SAME env, an operator raising NOBLECLOAK_AUDIT_WORKER_DEADLINE_MS (say
 * to 60s) cannot make a live, still-draining holder's lock steal-eligible at 10s
 * — which would let a second worker drain the same backlog concurrently, exactly
 * the meltdown driver the single-flight lock exists to prevent.
 */
function drainLockStaleMs(env = process.env) {
  return Math.max(DRAIN_LOCK_STALE_FLOOR_MS, workerDeadlineMs(env));
}

/** Non-blocking drain lock. Returns a handle, or null if another worker holds it. */
export function acquireDrainLock(env = process.env) {
  return tryAcquireLock(DRAIN_LOCK_NAME, drainLockStaleMs(env), env);
}

/** Release a drain lock acquired via acquireDrainLock (no-op for null). */
export function releaseDrainLock(lock) {
  if (lock) releaseLock(lock.lockPath, lock.ownerToken);
}

/**
 * Build the `:pre` envelopes for the OLDEST `cap` queued Pre records whose
 * tool_use_id is NOT yet in the shipped ledger — the fabricated-success
 * defense, bounded per drain (brief D2). The caller ships these and marks each
 * tool_use_id shipped (markPreShipped) so a later drain or a late-arriving Post
 * never double-ships it. Capping the OLDEST means the most-aged unshipped Pre
 * records (the ones most at risk of being lost) ship first; the window advances
 * as they ledger, so a large backlog drains in bounded batches across events.
 *
 * Returns `[{ toolUseId, envelope }]`. A Pre record missing session_id (a
 * degraded early-exit record) is skipped — there is no run_id to attach it to.
 */
export function drainUnshippedPreEnvelopes(env = process.env, ts = new Date().toISOString(), cap = drainCap(env)) {
  const shipped = loadShippedSet(env);
  const out = [];
  for (const pre of readPreRecords(env)) {
    if (out.length >= cap) break; // bounded per-drain work — oldest N only
    if (shipped.has(pre.tool_use_id)) continue;
    if (typeof pre.session_id !== 'string') continue; // no run_id — cannot attach
    const ceType = toolCallCeType(pre);
    const data = toolCallDataFromPre(pre);
    const envelope = buildEnvelope(ceType, deriveCeId(pre.tool_use_id, 'pre'), pre.session_id, data, ts);
    out.push({ toolUseId: pre.tool_use_id, envelope });
  }
  return out;
}

/**
 * `data` block for a drained Pre envelope, built from the Pre record alone (no
 * Post input is available — that is the whole point of the drain). Mirrors
 * toolCallData's field selection.
 */
function toolCallDataFromPre(pre) {
  const data = {
    tool_ref: pre.tool_ref ?? toolRefFor(pre.tool_name),
    tool_use_id: pre.tool_use_id,
    bn_invocation_channel: pre.bn_invocation_channel ?? 'headless',
    decision: decisionBlockFromPreRecord(pre),
  };
  if (pre.agent_id) data.agent_id = pre.agent_id;
  if (pre.agent_type) data.agent_type = pre.agent_type;
  if (pre.cwd) data.cwd = pre.cwd;
  if (pre.arg_digest) data.arg_digest = pre.arg_digest;
  if (pre.arg_summary) data.arg_summary = pre.arg_summary;
  data.surface = surfaceBlock(process.env);
  return data;
}

// ── Bounded retention (queue + ledger compaction) ──────────────────────────
//
// audit-queue.jsonl and audit-sent.jsonl are append-only. Without compaction
// they grow without bound on a long session, and every Post re-reads the whole
// queue (readPreRecords + findPreRecord) and the whole ledger (loadShippedSet),
// so per-call audit cost climbs as O(queue size). This runs on customer
// laptops, so both the disk growth and the rising per-call CPU are user-visible.
//
// compactAuditQueueAndLedger() rewrites both files (temp + rename) keeping only
// what later events still need:
//   - UNSHIPPED Pre records that can still drain (have a session_id) are kept —
//     each is the only truthful record of a call no Post reconciled — within
//     two bounds (ruled 2026-10-20 after a two-months-signed-out queue reached
//     117 MB): none older than AUDIT_UNSHIPPED_MAX_AGE_MS, and at most the
//     newest AUDIT_UNSHIPPED_RETENTION. Records over either bound are DROPPED —
//     never delivered — and the drop is counted in <state dir>/audit-health.json
//     (`unshippedDropped`), which /noblecloak-status reports. Records under both
//     bounds are untouched.
//   - A bounded TAIL of already-shipped Pre records is kept as a join buffer so
//     a slightly-late Post can still find its Pre (findPreRecord) and the drain
//     can still short-circuit on the ledger. Older shipped records are dropped.
//   - A bounded TAIL of UNDRAINABLE records (session_id === null, degraded
//     early-exit) is kept; these can never ship, so without a cap they would be
//     re-scanned and re-skipped on every Post forever. Older ones are dropped.
// The ledger is then rewritten to only the tool_use_ids still present in the
// compacted queue, so it can never outgrow the queue.

/** Join-buffer: shipped Pre records retained so a late Post can still join. */
export const AUDIT_SHIPPED_RETENTION = 256;
/** Cap on retained undrainable (session-less) degraded records. */
export const AUDIT_UNDRAINABLE_RETENTION = 64;
/**
 * Cap on retained UNSHIPPED drainable Pre records (newest kept). 2,000 records
 * is ~1–1.5 MB at the observed ~600 B/record (vs 117 MB unbounded), more than a
 * full day of heavy use, and drains in 40 drain-capped (50/event) events once
 * COO is reachable again. Env: NOBLECLOAK_AUDIT_UNSHIPPED_RETENTION.
 */
export const AUDIT_UNSHIPPED_RETENTION = 2000;
/**
 * Max age of a retained UNSHIPPED Pre record. 7 days covers a long weekend or a
 * week-long outage/sign-out; past that the audit run is stale (and a resumed
 * session may now belong to another org) — the 2026-10-20 ruling: "we don't
 * need to send them". Env: NOBLECLOAK_AUDIT_UNSHIPPED_MAX_AGE_MS.
 */
export const AUDIT_UNSHIPPED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function positiveEnvInt(env, name, fallback) {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/**
 * Cap on retained audit-spill.jsonl lines. The new no-mark-shipped recovery
 * behavior re-spills every un-reconciled `:pre` on every drain while COO is
 * unreachable (or the session is logged out), so without a bound the spill
 * grows O(K·N) over a long degraded session — user-visible disk on a customer
 * laptop. The spill is a forensic tail; a recent window is all the offline
 * reconstruction needs, and server-side `(run_id, ce_id)` dedup makes the
 * dropped older duplicates harmless.
 */
export const AUDIT_SPILL_RETENTION = 1024;
/** Lockfile name for the best-effort compaction single-flight (state dir). */
const COMPACT_LOCK_NAME = 'audit-compact.lock';

/**
 * Compact the audit queue and the shipped ledger in place. Best-effort: any
 * read/write failure leaves the files untouched (never throws — callers run it
 * after a successful ship/drain and must not let it disturb exit-0). Returns
 * `{ compacted: boolean }`.
 *
 * The queue and ledger are otherwise append-only (concurrency-safe under POSIX
 * append). Compaction is the ONE read-modify-rewrite path, so it must not race
 * concurrent appenders: the PreToolUse hook appendFileSyncs new unshipped Pre
 * records and markPreShipped appends ledger lines, both potentially WHILE a
 * detached Post worker is compacting. A clobbered unshipped-Pre append is a
 * permanently-lost fabricated-success record — the core security invariant. So:
 *   - Compaction runs under a non-blocking O_EXCL lock (audit-compact.lock); if
 *     another worker holds it, this round is skipped (best-effort, next drain
 *     retries) so two workers never rewrite concurrently.
 *   - Even under the lock, a hook in a *different* process appends without
 *     taking the lock, so before the rename we re-stat the queue and ABORT if it
 *     grew since our snapshot read — a concurrent append is never clobbered.
 */
export function compactAuditQueueAndLedger(env = process.env) {
  const queueFile = auditQueuePath(env);
  if (!existsSync(queueFile)) {
    // The queue is gone, but a stale spill / dead-letter tail may still need bounding.
    boundAuditSpill(env);
    boundAuditDeadLetters(env);
    return { compacted: false };
  }

  // Single-flight: never let two workers rewrite the append-only files at once.
  // Best-effort — if the lock is held, skip (the next drain retries).
  const lock = tryAcquireLock(COMPACT_LOCK_NAME, COMPACT_LOCK_STALE_MS, env);
  if (!lock) return { compacted: false };

  try {
    return compactUnderLock(queueFile, env);
  } finally {
    releaseLock(lock.lockPath, lock.ownerToken);
    // Spill bounding is independent of the queue/ledger rewrite; do it whether
    // or not the queue compacted, but still inside the same best-effort pass.
    boundAuditSpill(env);
    boundAuditDeadLetters(env);
  }
}

/** Trim a forensic JSONL file to its newest `retention` lines. Best-effort, never throws. */
export function boundJsonlTail(file, retention) {
  try {
    if (!existsSync(file)) return { trimmed: false, dropped: 0 };
    const sizeBefore = statSync(file).size;
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    if (lines.length <= retention) return { trimmed: false, dropped: 0 };
    if (statSync(file).size !== sizeBefore) return { trimmed: false, dropped: 0 }; // concurrent append
    atomicWriteFileSync(file, `${lines.slice(-retention).join('\n')}\n`);
    return { trimmed: true, dropped: lines.length - retention };
  } catch {
    return { trimmed: false, dropped: 0 };
  }
}

function compactUnderLock(queueFile, env) {
  // Snapshot the queue size so we can detect a concurrent append (a Pre hook in
  // another process appends WITHOUT the lock) and abort rather than clobber it.
  let sizeBefore;
  let raw;
  try {
    sizeBefore = statSync(queueFile).size;
    raw = readFileSync(queueFile, 'utf-8');
  } catch {
    return { compacted: false };
  }

  // The shipped set BEFORE compaction. liveIds for the rewritten ledger must be
  // a SUBSET of this — never inject a never-shipped tool_use_id into the ledger
  // (that would mark an undelivered Pre as shipped and suppress its drain
  // forever, defeating the fabricated-success defense).
  const shipped = loadShippedSet(env);
  const lines = raw.split('\n').filter(Boolean);

  // Classify each line BY INDEX (line content can collide; indices never do).
  // Non-Pre / torn lines are dropped (the queue only exists to join/drain Pre
  // records; nothing reads anything else from it).
  const keepIdx = new Set(); // kept: unshipped + drainable within the caps (+ the tails below)
  const unshippedIdx = []; // unshipped + drainable — bounded by age and count
  const tsByIdx = []; // [index] → epoch ms of record.ts (NaN when unparseable)
  const shippedIdx = []; // delivered — keep only a recent join buffer
  const undrainableIdx = []; // session-less degraded — keep only a recent tail
  const idById = []; // [index] → tool_use_id, for the live-id sweep
  for (let i = 0; i < lines.length; i += 1) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue; // torn line — drop
    }
    if (record.hook_event !== 'PreToolUse' || typeof record.tool_use_id !== 'string') continue;
    idById[i] = record.tool_use_id;
    if (typeof record.session_id !== 'string') {
      undrainableIdx.push(i);
    } else if (shipped.has(record.tool_use_id)) {
      shippedIdx.push(i);
    } else {
      unshippedIdx.push(i);
      tsByIdx[i] = Date.parse(record.ts);
    }
  }

  // Unshipped bounds: drop by age first (an unparseable ts is never dropped by
  // age), then keep the newest N. Queue order is append order, so "newest" is
  // the tail and the oldest go first.
  const now = Date.now();
  const maxAgeMs = positiveEnvInt(env, 'NOBLECLOAK_AUDIT_UNSHIPPED_MAX_AGE_MS', AUDIT_UNSHIPPED_MAX_AGE_MS);
  const unshippedCap = positiveEnvInt(env, 'NOBLECLOAK_AUDIT_UNSHIPPED_RETENTION', AUDIT_UNSHIPPED_RETENTION);
  const young = unshippedIdx.filter((i) => !(Number.isFinite(tsByIdx[i]) && now - tsByIdx[i] > maxAgeMs));
  const keptUnshipped = young.slice(-unshippedCap);
  const droppedByAge = unshippedIdx.length - young.length;
  const droppedByCount = young.length - keptUnshipped.length;
  for (const i of keptUnshipped) keepIdx.add(i);

  const keepShipped = shippedIdx.slice(-AUDIT_SHIPPED_RETENTION);
  const keepUndrainable = undrainableIdx.slice(-AUDIT_UNDRAINABLE_RETENTION);
  for (const i of keepShipped) keepIdx.add(i);
  for (const i of keepUndrainable) keepIdx.add(i);

  // Nothing to gain if every line is already retained.
  if (keepIdx.size === lines.length) return { compacted: false };

  // Reassemble in original order, and collect the surviving tool_use_ids that
  // were ALREADY shipped — the only ledger entries worth retaining. An unshipped
  // survivor (keepIdx via the unshipped branch) must NOT be added to the ledger:
  // doing so would mark a never-delivered Pre as shipped and permanently
  // suppress its drain. Intersecting with `shipped` enforces this.
  const compactedQueue = [];
  const liveIds = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!keepIdx.has(i)) continue;
    compactedQueue.push(lines[i]);
    const id = idById[i];
    if (typeof id === 'string' && shipped.has(id)) liveIds.add(id);
  }

  // Final guard against a concurrent append between our snapshot and the rename:
  // if the file grew, a Pre was appended after we read it — abort so the rename
  // never clobbers it. The next drain retries.
  try {
    if (statSync(queueFile).size !== sizeBefore) return { compacted: false };
  } catch {
    return { compacted: false };
  }

  try {
    atomicWriteFileSync(queueFile, compactedQueue.length ? `${compactedQueue.join('\n')}\n` : '');
  } catch {
    return { compacted: false };
  }

  // Count undelivered drops only once the rewrite actually happened.
  const dropped = droppedByAge + droppedByCount;
  if (dropped > 0) {
    updateAuditHealth(
      (h) => ({
        ...h,
        unshippedDropped: {
          total: (h.unshippedDropped?.total ?? 0) + dropped,
          byAge: (h.unshippedDropped?.byAge ?? 0) + droppedByAge,
          byCount: (h.unshippedDropped?.byCount ?? 0) + droppedByCount,
          last: dropped,
          lastAt: new Date(now).toISOString(),
        },
      }),
      env
    );
  }

  const sentFile = auditSentPath(env);
  if (existsSync(sentFile)) {
    const compactedLedger = [];
    for (const id of liveIds) compactedLedger.push(JSON.stringify({ tool_use_id: id }));
    try {
      atomicWriteFileSync(sentFile, compactedLedger.length ? `${compactedLedger.join('\n')}\n` : '');
    } catch {
      // Queue already compacted; a stale-but-larger ledger is harmless (it only
      // ever short-circuits drains). Leave it rather than fail the compaction.
    }
  }

  return { compacted: true, droppedUnshipped: dropped };
}

/** Retention tail length for audit-spill.jsonl, from NOBLECLOAK_AUDIT_SPILL_RETENTION (else default). */
function spillRetention(env) {
  const n = Number.parseInt(env.NOBLECLOAK_AUDIT_SPILL_RETENTION ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : AUDIT_SPILL_RETENTION;
}

/**
 * Bound audit-spill.jsonl to its retention tail (brief 2026-06-15 D4). Exported
 * and callable INDEPENDENTLY of the drain/compaction path: the worker invokes it
 * early so the spill stays capped even when the drain is skipped (breaker open)
 * or the worker is killed mid-drain by the watchdog — the gap that let the spill
 * reach 1.86 GB (compaction, which used to be the only caller, ran only after a
 * never-completing drain). When it actually drops lines it appends a countable
 * `bn_degraded` marker so the loss is visible, not silent. Best-effort, never
 * throws. Returns `{ trimmed, dropped }`.
 */
export function boundAuditSpill(env = process.env, opts = {}) {
  const spillFile = auditSpillPath(env);
  if (!existsSync(spillFile)) return { trimmed: false, dropped: 0 };
  let sizeBefore;
  let raw;
  try {
    sizeBefore = statSync(spillFile).size;
    raw = readFileSync(spillFile, 'utf-8');
  } catch {
    return { trimmed: false, dropped: 0 };
  }
  // Test-only seam: deterministically inject a concurrent append into the exact
  // window between the snapshot read above and the re-stat below, to exercise the
  // concurrent-append guard (the only path that can race a live emitAuditEvent
  // spill). Production never passes this.
  if (typeof opts._onSnapshot === 'function') opts._onSnapshot();
  const retention = spillRetention(env);
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= retention) return { trimmed: false, dropped: 0 };
  const dropped = lines.length - retention;
  const tail = lines.slice(-retention);
  // A countable degraded marker for the drop — server-side `(run_id, ce_id)`
  // dedup makes the dropped older duplicates harmless, but the loss must stay
  // visible (mirrors the Pre/Post-side bn_degraded records).
  const marker = JSON.stringify({
    bn_degraded: true,
    degraded_side: 'spill',
    degraded_reason: 'spill-cap-trimmed',
    dropped,
    retention,
    time: new Date().toISOString(),
  });
  try {
    if (statSync(spillFile).size !== sizeBefore) return { trimmed: false, dropped: 0 }; // concurrent append — abort
  } catch {
    return { trimmed: false, dropped: 0 };
  }
  try {
    // A spill append that lands in the window between this re-stat and the
    // rename below is clobbered — but that only loses a FORENSIC spill line; the
    // fabricated-success obligation lives durably in audit-queue.jsonl (the :pre
    // record), not here, so the invariant is never at risk.
    atomicWriteFileSync(spillFile, `${tail.join('\n')}\n${marker}\n`);
    return { trimmed: true, dropped };
  } catch {
    return { trimmed: false, dropped: 0 }; // best-effort — leave the spill on a write failure
  }
}
