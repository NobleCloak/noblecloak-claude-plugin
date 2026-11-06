# PreToolUse Governance Adapter

The plugin ships a `PreToolUse` hook (`scripts/hooks/pre-tool-use.mjs`) that resolves every
matched local tool call against COO governance (`POST /v1/coo/local/resolve`) before it
executes — the plugin adapter from ADR-0033 "Governed Local Execution via Claude Code Hooks".

Pinned to **Claude Code ≥ 2.1.165** hook-input shapes.

## Modes

- **Audit-only (default)** — the hook always emits `permissionDecision: allow`. It still
  resolves against COO (proves the path, warms the cache) and records the would-be decision
  in the local audit queue. Nothing is ever blocked — including `deny` responses.
- **Enforce** (`NOBLECLOAK_LOCAL_ENFORCE=true`) — the hook obeys the server decision:
  `always_allow → allow`, `ask → ask`, `deny → deny`. Headless `ask → deny` degradation is
  applied **server-side**.

## What is matched

`hooks/hooks.json` matcher: `^mcp__.*$` (since 0.2.1; local tools such as `Bash`, `Edit` and `WebFetch` are not observed: ruled 2026-11-04, a per-organisation setting to widen the scope is planned). The summaries below for local tools describe what the hook would send if a matcher included them.

NobleCloak MCP tools match the regex but are **immediately allowed by the script** without a
resolve call — they are governed by the COO MCP gateway already (no double-enforcement,
ADR-0033 §2). The `PreToolUse` hook writes **no** audit-queue record for them. As of the
2026-07-09 session tool-call log brief the async `PostToolUse` hook does **log** (never
enforce) these calls as a single corroborating `coo_run_events` `:post` record — marked
`bn_corroborated_by: "action_ledger"` with `enforce_active: false` and the surface
attribution block — so the session tool-call log is complete while the gateway's
action-ledger audit remains the sole authoritative record. Membership is exact, never a
name-prefix match: the server id segment of the
tool name must be one of the server ids in the committed `.mcp.json` (static and tokenless —
Claude Code owns the live connection via native OAuth; there is no runtime writer). Both name
shapes are recognised: `mcp__<server>__<tool>` and, for tools of the installed plugin,
`mcp__plugin_noblecloak_<server>__<tool>`; only this plugin's own `plugin_noblecloak_` prefix is
unwrapped. The static fallback (`noblecloak`) applies **only when `.mcp.json` is absent or
unparseable**; a present-but-empty config (`{ "mcpServers": {} }` — e.g. a hand-edited one)
is authoritative, so nothing gets the gateway-skip. A
lookalike server named e.g. `mcp__noblecloakfake__*` or `mcp__noblecloak-unknown__*` is resolved
and audited like any other MCP tool.

**Residual risk (open decision).** The plain form `mcp__noblecloak__<tool>` is recognised
whenever `.mcp.json` lists a server named `noblecloak`. Once the plugin ships that server,
Claude Code names its tools `mcp__plugin_noblecloak_noblecloak__*`, so a plain-form name can
only come from a server configured independently (user, project or local scope) under the
name `noblecloak`; in ENFORCE mode such a server skips resolve and the pre-audit record.
Restricting the skip to the plugin-prefixed form
is a product decision and is not made here.

## Privacy: raw tool input never leaves the machine

The resolve request and audit record carry only:

- `arg_digest` — SHA-256 hex over the canonicalized (recursively key-sorted JSON) `tool_input`
- `arg_summary` — per-tool safe summary: `Bash` → first token, `Edit`/`Write` → cwd-relative
  path (basename if it escapes cwd), `WebFetch` → domain only, MCP tools → tool name only,
  everything else (`Read`/`Glob`/`Grep`/`Agent`) → tool name only

## Failure modes (ADR-0033 §8)

When COO is unreachable / times out / returns 5xx:

| Mode | read | write / external / delete / admin |
|---|---|---|
| Audit-only | allow (record marked `degraded`) | allow (record marked `degraded`) |
| Enforce | allow (`read-fail-open`) | deny (`fail-closed`) |

`external` is unspecified in ADR-0033 §8 (the ADR table covers read → fail-open and
write/delete/admin → fail-closed) — this adapter treats `external` as fail-closed
(conservative extension).

The offline side-effect classification is a static mirror of the 8 built-in entries in
the COO API's local tool catalog (+ `mcp__*` → `write`);
server resolution always wins when reachable.

The hook never throws: any internal failure — including unparseable hook input and truly
unexpected internal errors, which are treated as an unclassifiable (non-read) tool, so they
allow in audit-only and **fail closed in enforce** — produces a fail-mode decision, a
degraded audit record (`degraded_reason` `malformed-input` / `shape-drift` / `timeout` /
`internal-error: …` / …), one stderr line, and exit 0 with valid JSON. Malformed-input and
internal-error records carry `session_id`/`tool_use_id` as `null` (there is nothing
trustworthy to record); shape-drift records keep whatever fields survived.

All network steps (resolve attempt, OAuth discovery, token refresh, retried resolve) share a
cumulative ~4s budget so the worst-case 401→refresh→retry path always emits a decision
before the 5s `hooks.json` hook timeout — a hook killed by the host emits nothing, and the
host default (proceed) would silently bypass enforce mode. A test pins the budget against
`hooks.json`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `NOBLECLOAK_LOCAL_ENFORCE` | `false` (audit-only) | Flip to `true` to enforce server decisions |
| `NOBLECLOAK_COO_URL` | `https://api.noblecloak.com` | COO API base; resolve endpoint is `{base}/v1/coo/local/resolve` |
| `NOBLECLOAK_ISSUER` | `https://api.noblecloak.com` | OAuth issuer; endpoints discovered via `{issuer}/.well-known/oauth-authorization-server` |
| `NOBLECLOAK_RESOLVE_TIMEOUT_MS` | `1500` | Per-attempt resolve timeout |
| `NOBLECLOAK_STATE_DIR` | `~/.noblecloak/claude-plugin` | State dir override (auth.json, audit queue) — mainly for tests |
| `NOBLECLOAK_MIGRATE_FROM` | unset | An old state directory (for example a checkout that was renamed or moved) to migrate from; preferred over `<plugin>/.local` when it holds an `auth.json`; see README "State" |
| `NOBLECLOAK_SDK_HOOK_ACTIVE` | ignored | Ignored since 0.2.6: no environment variable turns off enforcement or the audit trail. Versions up to 0.2.5 skipped the hooks when it was set |
| `NOBLECLOAK_SIGNED_OUT_RECHECK_MS` | `900000` (15 min) | How often a signed-out plugin re-tries its refresh grant |
| `NOBLECLOAK_AUDIT_UNSHIPPED_RETENTION` | `2000` | Max unshipped Pre records kept in the audit queue (newest kept) |
| `NOBLECLOAK_AUDIT_UNSHIPPED_MAX_AGE_MS` | `604800000` (7 days) | Max age of a kept unshipped Pre record |

## Channel detection

`bn_invocation_channel` is `interactive` only when the hook process env
`CLAUDE_CODE_ENTRYPOINT` is a known interactive host (`cli`) **and** the hook input has no
`agent_id` (i.e. not a subagent). Everything else — `sdk-cli` (`claude -p`), subagents,
unknown entrypoints — is `headless` (fail-safe).

## Surface attribution

Every tool-call event carries a `data.surface` block — **self-reported, best-effort host
attribution**, not verified:

- `reported` — which client host produced the call, derived from the hook process env
  `CLAUDE_CODE_ENTRYPOINT` (`cli`/`sdk-cli` → `claude-code`). An unrecognized/future host is
  `unknown` (fail-safe — never mislabel).
- `version` — the plugin's own semver (from `.claude-plugin/plugin.json`); omitted when the
  manifest is unreadable.

The block is purely client-supplied, so it is **not** trustworthy attribution on its own.
**Verified** attribution will be a future COO **server-stamped** field, resolved from the
token at ingest — it is deliberately **not** a slot in this client-supplied block.

`surface` rides **every** tool-call event (both `:pre` and `:post`, local and gateway-governed
alike). Contrast `bn_corroborated_by: "action_ledger"`, which is stamped **only** on
gateway-governed (NobleCloak MCP) `:post` records to mark them as corroborating the gateway's
authoritative action-ledger audit.

## Per-call audit records (the seam for the audit emitter)

Each resolved call appends one JSON line to `~/.noblecloak/claude-plugin/audit-queue.jsonl`. The
authoritative shape (v=1) is documented in `scripts/lib/governance.mjs` (AUDIT RECORD
CONTRACT). The future PostToolUse/Subagent audit emitter (epic brief #5) drains this queue,
correlating on `tool_use_id`.

## Auth

Before any COO call (resolve, audit emit, drain) the hooks check the token's local
`expiresAt`, treating anything within 30s of it as expired. An expired token is refreshed
once, within the call's budget, and is never sent. Resolve also keeps its
401 → refresh → retry-once path for a token COO refuses before it expires; an audit emit that
gets a 401 refreshes once and spills the envelope for a later drain.
Refresh is single-flight across concurrent hook processes (an exclusive lockfile in the
state dir; waiters re-read and adopt the winner's tokens) and `auth.json` is written
atomically (temp file + rename), so parallel tool calls hitting a 401 storm can't burn a
rotated refresh token or tear the file.
A sign-in is used only against the issuer it was made at: `auth.json` records `issuer`
(the `NOBLECLOAK_ISSUER` base at sign-in), and a file whose `issuer` differs from the current one,
or has none (plugin 0.1.x), reads as signed out, so its tokens are neither sent to COO nor
refreshed. `client.json` records `registrationEndpoint`; `/noblecloak-login` reuses the client
only when it matches the discovered `registration_endpoint`, and registers again otherwise.
Token refresh goes through RFC 8414 discovery on `NOBLECLOAK_ISSUER` — the token endpoint comes
from the discovery doc. **Core OAuth AS Stage 4 has shipped** (verified 2026-08-13: the beta
discovery document serves `authorization_endpoint`, `token_endpoint`, `registration_endpoint`
and `revocation_endpoint` under `/auth/oauth/*`, `scopes_supported: [mcp, offline_access]`,
PKCE `S256`, and `token_endpoint_auth_methods_supported: [none]`). `/noblecloak-login` works
against the live endpoints; the "endpoints not yet available" path is a genuine-outage message
now, not the expected steady state.

### Signed out

When a refresh is **rejected** (a 400 or 401 from the token endpoint carrying `invalid_grant`,
`invalid_client`, `unauthorized_client` or `invalid_request`), or the token has actually expired and there is
no refresh token, the plugin writes `~/.noblecloak/claude-plugin/signed-out.json` (`{ since, reason, checkedAt }`). A
token that is still valid is never marked signed out: if it expires within the session-start
refresh window (5 minutes) and has no refresh token, the plugin keeps using it and shows a
visible "expires at … run /noblecloak-login to renew it" line instead. While the marker exists:

- the hooks make **no** COO calls;
- resolve takes the normal no-token fail-mode (audit-only allows; enforce allows reads and
  fails closed for everything else; the audit record says `degraded_reason: signed-out`);
- audit events spill locally as logged out, the drain is skipped, and the breaker is not
  touched (being logged out is not an outage);
- the refresh is re-tried at most every 15 minutes (`NOBLECLOAK_SIGNED_OUT_RECHECK_MS`), and on
  every session start, so a grant fixed server-side recovers without a login.

`/noblecloak-login`, `/noblecloak-logout` and any successful refresh delete the marker. The marker
also records a short sha256 fingerprint of the credential that was rejected (never the token
itself). A marker whose fingerprint no longer matches `auth.json` is ignored and deleted, so a
refresh rejected after `/noblecloak-login` finished can't sign out the new sign-in. A
**transient** refresh failure (5xx, 408, 429, any other 4xx or a 4xx with no OAuth error code
— a rate limit, a misrouted load balancer, a WAF — network, discovery) never signs the plugin out: the
expired token still isn't sent. The failure is stamped in `~/.noblecloak/claude-plugin/refresh-backoff.json`, and for
the next 60 seconds (`NOBLECLOAK_REFRESH_BACKOFF_MS`) the hooks don't retry the refresh and the
audit drain is skipped, so a struggling core gets one grant per minute rather than one per tool
call and per drained record. A successful refresh deletes the stamp, and a stamp for a
credential `auth.json` no longer holds is ignored.

The user is told. At session start, a rejected or impossible refresh produces a visible
"signed out of governance … run /noblecloak-login" message, and a transient failure produces a
softer visible line. If the plugin is signed out mid-session, the next tool call shows the
same message once per session. `/noblecloak-status` shows the signed-out state with its `since`
and `reason`.

`/noblecloak-login` takes one optional argument, an email (`/noblecloak-login you@yourcompany.com`),
for staff of an organisation that signs in with corporate SSO. It is sent to the authorization
server as `login_hint` on the authorize URL, so the server can route the sign-in; an argument
that is not an email address with a dotted domain (`local@domain.tld`) exits 2 with a usage line before any file, browser or network call.

### Where the hooks' messages show up

Per the Claude Code hooks reference (code.claude.com/docs/en/hooks, checked 2026-10-20):

- a hook's JSON `systemMessage` is the "warning message shown to the user". The events
  that discard it are listed per event, and SessionStart, PreToolUse and PostToolUse are not
  among them;
- a SessionStart hook's plain stdout (and `additionalContext`) goes to **Claude's context**,
  not to the user;
- stderr from a hook that exits 0 is never shown (it only reaches the debug log).

So `refresh.mjs` writes one JSON object: `systemMessage` for what the user must act on, and
`hookSpecificOutput.additionalContext` for the rest. The detached audit worker has no output
channel, so it queues notices in `~/.noblecloak/claude-plugin/notices.json`. The next PreToolUse hook (or the
PostToolUse dispatcher) shows each one as `systemMessage`, **once per Claude Code session**.

### The two token custodians

The plugin's `~/.noblecloak/claude-plugin/auth.json` token drives the governance hooks; **Claude Code's native MCP
OAuth holds a separate token** for the live gateway session (the committed, tokenless
`.mcp.json` only declares the server). Each token binds the organization picked on its own consent
page (the default organization is only preselected there), so their org bindings normally agree
— but they are minted at different moments and CAN drift (a different org picked on the two
consent pages): local-resolve audits would then run against
org A while gateway `tools/call`s resolve org B's catalog. There is no client-side way to read
the native token; `/noblecloak-status` therefore labels its org line "hooks token" and the
authoritative session-org echo is a gateway-side ask. When the bindings are suspected
to differ, re-run `/noblecloak-login` AND reconnect the MCP server from `/mcp` so both re-mint
against the organization you pick on each consent page.

The organization shown after sign-in was chosen on the consent page. To use a different one,
re-run `/noblecloak-login` and pick it there (tick "Make this my default organization" to keep
it). The MCP server connection holds its own token, so reconnect it from `/mcp` after changing
organizations, and pick the same organization on its consent page (it preselects your default
organization, not the one you just chose, unless you ticked the checkbox).

Login persists the hooks token's `orgId`/`sub` into `auth.json`, and `/noblecloak-status` probes
the gateway catalog (`Catalog: N tools visible`) — N=0 is the "every dispatch will 404"
precondition, printed with remediation (the org line and the catalog probe).

## Audit delivery: what is retried, what is dropped

Audit events go to `POST /v1/coo/local/events` from a detached worker. How a response is
handled:

| Response | Treated as | What happens |
|---|---|---|
| 2xx | delivered | the `:pre` is ledgered as shipped |
| 401 | auth | spilled (a `:pre` stays eligible for the next drain) and counts toward the circuit breaker; the token is refreshed, at most once per token: if the token that refresh minted also draws a 401, COO is refusing fresh tokens, and the breaker, not more refreshes, stops the calls. A rejected grant signs the plugin out |
| 403 with code `tenant_run_mismatch`; 400 or 422 with code `validation_error`; 413 with code `payload_too_large` | **permanent** | not spilled for retry, not counted toward the breaker; written to the dead-letter tail `~/.noblecloak/claude-plugin/audit-dead.jsonl` (last 256; older lines trimmed from it are counted and shown by `/noblecloak-status`); the `:pre` is marked dead so no drain re-sends it |
| every other 4xx (404, 409, a 413 with no or another code, a 403 with no or another code, …), 5xx, 408, 429, timeout, network | transient | spilled, counts toward the circuit breaker (5 in a row opens it for 30s) |

Only a refusal carrying one of those COO error codes (`{ error: { code } }`) is permanent. A
status alone never is, so a proxy 404 or a gateway 403 during a deploy keeps the events for retry
instead of dropping them.

COO's local-events route sends 400 `validation_error` for a rejected payload (`data_invalid`,
`cloudevents_envelope_invalid`, `unknown_ce_type`, `unknown_ce_source`, non-JSON), so those are
dead-lettered. It answers an oversize body as 413 `payload_too_large`, also dead-lettered: an
envelope over the cap never fits on a retry. It keeps 400 `bad_request` for a server fault, which is
retried and counts toward the breaker.

When the breaker opens, the next tool call tells the user once per session.

### Org mismatch (403 `tenant_run_mismatch`)

COO files a Claude Code session's local audit under an audit run whose id **is the session
id**, created in the org of the first token that posted to it. If you then sign in to a
different org (for example `/noblecloak-login` after you picked a different org on the consent page), COO refuses
every later event for that run with 403 `tenant_run_mismatch`. That is permanent for the run,
and a **resumed** Claude Code session keeps its session id, so it never recovers on its own.

The plugin records the run as refused for your current org (`~/.noblecloak/claude-plugin/audit-runs.json`), stops
sending that session's events (they are dead-lettered locally), and tells you once in that
session. It stops sending only when both orgs are known and equal: the org that was refused and
the org of your current token. If either is unknown (for example a token without an
`org_id` claim), every event is still sent and COO decides. The message:

> this Claude Code session's audit run belongs to a different org than your current sign-in;
> start a new Claude Code session (or sign back in to the original org) to resume audit delivery.

A new session gets a new run in your current org. Signing back in to the original org makes
the plugin try again, and the first delivery clears the refusal. A refusal also expires after one
hour (`AUDIT_RUN_REJECTION_TTL_MS`): the next event is sent once, so a mismatch fixed on the COO
side recovers on its own. If COO refuses it again, the refusal is recorded again without a second
warning. `/noblecloak-status` shows the
current org, the org bound to this session's run when known, and the refused sessions.

### Queue bounds

`~/.noblecloak/claude-plugin/audit-queue.jsonl` holds the Pre-side record of every governed call until its `:pre`
is delivered. Compaction (after each drain-eligible event) keeps:

- unshipped records no older than **7 days** and, of those, the newest **2,000**
  (`NOBLECLOAK_AUDIT_UNSHIPPED_MAX_AGE_MS` / `NOBLECLOAK_AUDIT_UNSHIPPED_RETENTION`). At ~600 B a
  record that's about 1.2 MB, and it drains in about 40 events once COO is reachable (50 per
  drain);
- the newest 256 shipped records, as the join buffer for late Post events;
- the newest 64 records that can never ship because they have no session.

Unshipped records over either bound are **dropped and never delivered**. Compaction counts
them in `~/.noblecloak/claude-plugin/audit-health.json`, and `/noblecloak-status` reports the total ("Unshipped
records dropped (NOT delivered)"). The spill is capped at 1,024 lines and the dead-letter
tail at 256.

## Tests

```
npm test   # node --test against a local stub HTTP server
```
