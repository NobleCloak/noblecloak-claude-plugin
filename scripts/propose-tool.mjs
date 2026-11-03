#!/usr/bin/env node
/**
 * Propose a tool and its policy for approval (P2 of the governed tool-proposal
 * surface). Opens ONE approval on the govern module API:
 *
 *   POST {govern}/v1/approvals
 *   action: { tool_ref: 'tool:noblecloak:set-tool-policy', arguments: <proposal> }
 *
 * The proposal is applied by the deployment when a person approves it in the
 * approvals module; this script writes no catalog row and calls no catalog /
 * tools route. It prints the approval id and one approval line, and never opens
 * a browser for the approval itself.
 *
 * Token: a govern-audience user token (RFC 8707 resource = the govern origin),
 * stored beside the gateway token in auth.json. First run (or an expired,
 * unrefreshable token) performs a PKCE sign-in with a consent screen.
 *
 * Exit codes: 0 opened · 2 refused (an input problem code is printed; includes local
 * validation; deployment-side codes such as approval_unroutable exit 1) · 3 not signed in (no session, 401, or consent denied/timed out) · 1 anything else (network, 5xx, bad config).
 *
 * Env: NOBLECLOAK_GOVERN_URL (govern origin override), NOBLECLOAK_APPROVALS_URL (overrides
 * the default: on beta, the shell's /approvals module, derived from the govern origin).
 */

import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import {
  AuthDiscoveryError,
  dropTokenFor,
  approvalsUrl,
  governResourceIndicator,
  loadAuthState,
  resolveResourceIndicator,
  TokenRefreshError,
} from './lib/governance.mjs';
import { governToken } from './lib/govern-token.mjs';
import { SignInError } from './lib/pkce-flow.mjs';
import { approvalRequestBody, validateProposal } from './lib/proposal.mjs';

const REQUEST_TIMEOUT_MS = 15_000;
// Problem codes that mean the PROPOSAL itself was refused (fixable input). Classified by
// code, not status: approval_unroutable / continuation_unsupported / invalid_continuation
// also arrive as 422 but describe the deployment, which no input change can fix.
const REFUSAL_CODES = new Set([
  'invalid_request',
  'reserved_tool_ref',
  'system_tool_ref',
  'tool_ref_in_use',
  'payload_too_large',
  'side_effect_level_downgrade',
  'continuation_conflict',
]);
const DEPLOYMENT_CODES = new Set(['approval_unroutable', 'continuation_unsupported', 'invalid_continuation']);

const USAGE = `Usage: propose-tool.mjs --tool-ref <ref> --level <read|write|delete|external|admin> --policy <ask|always_allow|deny>
         [--description <text>] [--schema <file.json>] [--owner <org|principal>] [--show-arguments]
         [--file <proposal.json>]   (flags override members of the file)`;

const SCRATCH_NAME = /^noblecloak-proposal-[\w.-]+\.json$/;

/** True when `file` lives under the OS temp directory (symlinks resolved on both sides). */
function isInTmpDir(file) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const root = real(tmpdir());
  const dir = real(dirname(file));
  return dir === root || dir.startsWith(root + sep);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`cannot read ${what} ${path} — ${err.message}`);
  }
}

function proposalFromArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'tool-ref': { type: 'string' },
      level: { type: 'string' },
      policy: { type: 'string' },
      description: { type: 'string' },
      schema: { type: 'string' },
      owner: { type: 'string' },
      'show-arguments': { type: 'boolean' },
      file: { type: 'string' },
    },
    strict: true,
  });
  const p = values.file ? readJson(values.file, 'proposal file') : {};
  // A scratch file the command wrote (noblecloak-proposal-*.json, INSIDE the OS temp directory) is
  // single-use: remove it once read, so no proposal text is left behind. A file with a scratch-like
  // name anywhere else is the caller's and is kept (the name alone never authorises a delete).
  if (values.file && SCRATCH_NAME.test(basename(values.file)) && isInTmpDir(values.file)) {
    rmSync(values.file, { force: true });
  }
  if (values['tool-ref'] !== undefined) p.tool_ref = values['tool-ref'];
  if (values.level !== undefined) p.side_effect_level = values.level;
  if (values.policy !== undefined) p.policy = values.policy;
  if (values.description !== undefined) p.description = values.description;
  if (values.schema !== undefined) p.input_schema = readJson(values.schema, 'schema file');
  if (values.owner !== undefined) p.owner_kind = values.owner;
  if (values['show-arguments']) p.show_arguments_to_approvers = true;
  return p;
}

function problemCode(body) {
  const type = typeof body?.type === 'string' ? body.type : '';
  return type.split('/').pop() || 'refused';
}

async function main() {
  let proposal;
  try {
    proposal = proposalFromArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  const checked = validateProposal(proposal);
  if (!checked.ok) {
    console.error(`Refused: ${checked.code} — ${checked.detail}`);
    return 2;
  }

  if (!loadAuthState()) {
    console.error('Not signed in — run /noblecloak-login first.');
    return 3;
  }
  const resource = governResourceIndicator();
  if (!resource) {
    console.error('Cannot determine the govern API origin — set NOBLECLOAK_GOVERN_URL.');
    return 1;
  }
  if (resource === resolveResourceIndicator()) {
    // One audience per token: the gateway token lives at the top level of auth.json
    // and must never double as the govern token.
    console.error(`The govern API origin (${resource}) equals the MCP gateway origin — check NOBLECLOAK_GOVERN_URL.`);
    return 1;
  }

  let token;
  try {
    token = await governToken(resource);
  } catch (err) {
    if (err instanceof TokenRefreshError || err instanceof AuthDiscoveryError) {
      console.error(`Could not refresh the approvals token — ${err.message}. Try again shortly.`);
      return 1;
    }
    if (err instanceof SignInError && err.notSignedIn) {
      console.error(`Not signed in to the approvals API — ${err.message}. Re-run to try again.`);
      return 3;
    }
    // Port, endpoint, config and auth-file failures: a fresh login would not fix them.
    console.error(`Could not sign in to the approvals API — ${err.message}`);
    return 1;
  }

  let response;
  try {
    response = await fetch(`${resource}/v1/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(approvalRequestBody(checked.proposal)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Could not reach the approvals API at ${resource} — ${err.message}`);
    return 1;
  }

  // No Idempotency-Key: POST /v1/approvals dedupes an equal open obligation itself (same
  // action => 200 {created:false, id: <existing>}, one ledger row), which is the replay guard
  // for a re-run.
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    // The stored token was rejected (revoked, wrong audience/org): drop it so the
    // re-run signs in afresh instead of replaying the same bad token.
    await dropTokenFor(resource).catch(() => {});
    console.error(`Not signed in to the approvals API (${problemCode(body)}) — the stored approvals token was cleared; re-run to sign in again.`);
    return 3;
  }
  const detail = typeof body?.detail === 'string' ? ` — ${body.detail}` : '';
  const code = problemCode(body);
  if (DEPLOYMENT_CODES.has(code)) {
    console.error(`The deployment cannot route this proposal (${code})${detail} — changing the input will not help; report this to your administrator.`);
    return 1;
  }
  if (REFUSAL_CODES.has(code)) {
    console.error(`Refused: ${code}${detail}`);
    return 2;
  }
  if (response.status === 403) {
    console.error(`Access denied (${problemCode(body)})${detail} — your account may lack permission to open approvals.`);
    return 1;
  }
  if (response.status === 408 || response.status === 429) {
    console.error(`The approvals API asked to retry later (${response.status})${detail}.`);
    return 1;
  }
  if (response.status >= 400 && response.status < 500) {
    console.error(`Unexpected response from the approvals API (${response.status}: ${problemCode(body)})${detail}`);
    return 1;
  }
  const id = body?.data?.id;
  if (!response.ok || typeof id !== 'string') {
    console.error(`Unexpected response from the approvals API (${response.status}).`);
    return 1;
  }

  console.log(`${response.status === 200 ? 'Approval already open' : 'Approval opened'}: ${id}`);
  const approveAt = approvalsUrl(process.env, resource);
  console.log(approveAt ? `Approve it at ${approveAt}` : 'Approve it in the NobleCloak approvals module.');
  return 0;
}

process.exit(await main());
