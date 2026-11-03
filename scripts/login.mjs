#!/usr/bin/env node
/**
 * NobleCloak OAuth Login Script
 *
 * Implements OAuth 2.0 Authorization Code + PKCE flow:
 * 1. Generate code verifier + challenge
 * 2. Start local HTTP server for callback
 * 3. Open browser to authorization URL
 * 4. Receive callback with authorization code
 * 5. Exchange code for access + refresh tokens
 * 6. Store tokens locally (auth.json — for the governance hooks)
 * 7. Register the connection (best-effort)
 *
 * The MCP connection itself is owned by Claude Code's native OAuth against the
 * committed, tokenless .mcp.json; this script does NOT write .mcp.json.
 */

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import open from 'open';
import {
  AuthDiscoveryError,
  DEFAULT_ISSUER,
  clearSignedOut,
  decodeJwtClaims,
  discoverAuthServer,
  ensureRegisteredClientId,
  FIRST_SIGN_IN_NOTE,
  issuerBaseUrl,
  migrateLegacyState,
  resolveResourceIndicator,
  saveAuthState,
} from './lib/governance.mjs';

// ── Configuration ───────────────────────────────────────────────────────
// These can be overridden via environment variables for different environments.
// Auth endpoints are NOT configured directly: they are discovered per RFC 8414
// from {NOBLECLOAK_ISSUER}/.well-known/oauth-authorization-server (Core is the
// OAuth 2.1 AS under the API host; the discovery document names its endpoints).

const API_BASE_URL = process.env.NOBLECLOAK_API_URL || DEFAULT_ISSUER;
// The OAuth client_id is resolved at login time via ensureRegisteredClientId
// (DCR-registered + persisted, or NOBLECLOAK_CLIENT_ID override) — not a constant.
const REDIRECT_PORT = 19284;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
// Canonical scope set per the MCP native-OAuth design (2026-06-25): `mcp`
// (the AS's own advertised gateway-access scope) + `offline_access` (refresh).
// Matches the COO resource metadata's scopes_supported. Subject to the live
// verification gate; if the gateway/governance routes reject an mcp-scoped
// token, revert to 'openid profile email offline_access' (the prior set).
const SCOPES = 'mcp offline_access';

// ── PKCE Helpers ────────────────────────────────────────────────────────

function generateCodeVerifier() {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ── Auth Server Discovery (RFC 8414) ────────────────────────────────────

async function discoverEndpoints() {
  let doc;
  try {
    doc = await discoverAuthServer();
  } catch (err) {
    if (err instanceof AuthDiscoveryError) throw err;
    throw new AuthDiscoveryError(`OAuth discovery failed against ${issuerBaseUrl()} — ${err.message}`);
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new AuthDiscoveryError(
      'NobleCloak authorization server endpoints not yet available ' +
        '(Core OAuth AS Stage 4 pending) — discovery doc is missing ' +
        'authorization_endpoint/token_endpoint. Login is expected to fail until Stage 4 ships.'
    );
  }
  return {
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    registrationEndpoint: doc.registration_endpoint,
  };
}

// ── Token Exchange ──────────────────────────────────────────────────────

async function exchangeCodeForTokens(tokenEndpoint, code, codeVerifier, oauthClientId, resource) {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oauthClientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      // RFC 8707 §2.2: a client that sent `resource` to /authorize SHOULD send
      // the same value here. Core binds the aud from the stored code, so this
      // is currently informational (its /token schema is non-strict and strips
      // unknown keys) — sent for conformance and so a future strict validation
      // finds the matching value rather than an omission.
      ...(resource ? { resource } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  return response.json();
}

// ── Register Connection ─────────────────────────────────────────────────

async function registerConnection(accessToken, organizationId) {
  // Best-effort by design (connection tracking is advisory), but NEVER silent:
  // a swallowed registration failure is one more piece of
  // invisible state in the org-binding diagnosis chain.
  try {
    const res = await fetch(`${API_BASE_URL}/mcp/connections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        clientToolId: 'claude-code',
        organizationId,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      console.error(
        `NobleCloak: connection registration failed (${res.status}) — non-fatal, continuing. ${detail}`
      );
    }
  } catch (err) {
    console.error(
      `NobleCloak: connection registration failed (${err.message}) — non-fatal, continuing.`
    );
  }
}

// ── Main Login Flow ─────────────────────────────────────────────────────

async function login() {
  // Discover the AS endpoints up front — fails with an accurate message
  // ("token endpoint not yet available") instead of an NXDOMAIN.
  const { authorizationEndpoint, tokenEndpoint, registrationEndpoint } = await discoverEndpoints();

  // Resolve the OAuth client_id — DCR-register a public PKCE client on first run
  // (persisted in <state dir>/client.json), or honour a NOBLECLOAK_CLIENT_ID override.
  const oauthClientId = await ensureRegisteredClientId({
    registrationEndpoint,
    redirectUri: REDIRECT_URI,
  });

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString('hex');
  // RFC 8707 resource indicator, derived from .mcp.json's server origin. Sent
  // on BOTH legs of the code flow; null (and therefore omitted) only when it
  // cannot be derived.
  const resourceIndicator = resolveResourceIndicator();

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        const description = url.searchParams.get('error_description') || error;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Login Failed</h2><p>${description}</p><p>You can close this window.</p></body></html>`);
        server.close();
        reject(new Error(description));
        return;
      }

      const returnedState = url.searchParams.get('state');
      if (returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Login Failed</h2><p>State mismatch — possible CSRF attack.</p></body></html>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Login Failed</h2><p>No authorization code received.</p></body></html>');
        server.close();
        reject(new Error('No authorization code'));
        return;
      }

      try {
        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(
          tokenEndpoint,
          code,
          codeVerifier,
          oauthClientId,
          resourceIndicator
        );

        // The org binding is THE fact that decides which catalog every gateway
        // tool call resolves against — decode it once
        // and persist it alongside the tokens so /noblecloak-status can report
        // it without re-decoding.
        const claims = decodeJwtClaims(tokens.access_token) ?? {};
        const orgId = typeof claims.org_id === 'string' ? claims.org_id : undefined;
        const sub = typeof claims.sub === 'string' ? claims.sub : undefined;

        // Save auth state. This REPLACES auth.json wholesale on purpose: a re-login
        // may land on a different org, so per-resource tokens (`tokens`, e.g. govern)
        // bound to the old org are dropped and re-minted on next use.
        const authState = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
          tokenType: tokens.token_type || 'Bearer',
          scope: tokens.scope || SCOPES,
          authenticatedAt: new Date().toISOString(),
          ...(orgId ? { orgId } : {}),
          ...(sub ? { sub } : {}),
        };
        saveAuthState(authState);
        // A fresh sign-in ends any signed-out state (<state dir>/signed-out.json):
        // the hooks resume COO calls on the next tool call.
        clearSignedOut();

        // Register connection (best-effort, never silent — see registerConnection)
        if (orgId) {
          await registerConnection(authState.accessToken, orgId);
        }

        const orgLine = orgId
          ? `<p>Organization: <code>${orgId}</code><br>
             <small>All NobleCloak tool calls resolve against this workspace's catalog.
             If you meant a different workspace, change your default org and re-run /noblecloak-login.</small></p>`
          : `<p><strong>Warning:</strong> the session token carries no organization binding —
             tool calls may fail with "not found in catalog". Run /noblecloak-status in Claude Code
             for diagnosis.</p>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body>
          <h2>Connected to NobleCloak!</h2>
          ${orgLine}
          <p>Governance is active. You can close this window and return to Claude Code.</p>
        </body></html>`);

        server.close();
        resolve({ authState });
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Login Failed</h2><p>${err.message}</p></body></html>`);
        server.close();
        reject(err);
      }
    });

    // Bind to loopback only: the redirect_uri is localhost, so a listener on
    // the unspecified address would be needless local-network attack surface.
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const authUrl = new URL(authorizationEndpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', oauthClientId);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('scope', SCOPES);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      // RFC 8707 resource indicator. WITHOUT this, core's AS silently defaults
      // the bound audience (`code.resource ?? deps.resourceId`) — the token
      // still looks correctly bound, so the omission is invisible in every log
      // — and under AS_ENFORCE_RESOURCE_INDICATOR=true /authorize rejects the
      // request with `invalid_target`, breaking this login entirely. Omitted
      // only when it cannot be derived, which preserves today's behaviour
      // rather than failing the login over a bad .mcp.json.
      if (resourceIndicator) authUrl.searchParams.set('resource', resourceIndicator);

      console.log(FIRST_SIGN_IN_NOTE);
      console.log('Opening browser for NobleCloak authentication...');
      console.log(`If the browser doesn't open, visit: ${authUrl.toString()}`);

      open(authUrl.toString()).catch(() => {
        // If open fails, user can manually visit the URL
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Login timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

// ── Entry Point ─────────────────────────────────────────────────────────

try {
  // Before login, so a client.json registered by an earlier install is reused.
  const { message } = migrateLegacyState();
  if (message) console.log(message);
  const { authState } = await login();
  console.log('\nSuccess! NobleCloak governance is active.');
  if (authState.orgId) {
    console.log(`Signed in as: ${authState.sub ?? 'unknown'}`);
    console.log(`Organization: ${authState.orgId}`);
    console.log(
      'All NobleCloak tool calls resolve against this workspace’s catalog. The AS picks your ' +
        'default org automatically (no org picker yet) — if this is the wrong workspace, change ' +
        'your default org in the NobleCloak shell, then re-run /noblecloak-login AND reconnect the MCP ' +
        'server from /mcp (it holds its own token).'
    );
  } else {
    console.log(
      'Warning: the access token carries no org binding (org_id) — gateway calls may fail with ' +
        '"not found in catalog". Run /noblecloak-status for diagnosis.'
    );
  }
  console.log('The MCP connection is managed by Claude Code (native OAuth) — restart Claude Code, then see /mcp.');
  process.exit(0);
} catch (err) {
  console.error(`\nLogin failed: ${err.message}`);
  process.exit(1);
}
