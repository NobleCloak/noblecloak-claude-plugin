/**
 * Authorization-code + PKCE flow for ONE resource, returning a per-resource
 * token entry (see getTokenFor/saveTokenFor in governance.mjs). Used by
 * propose-tool.mjs to mint the govern-audience token with the same DCR client
 * login.mjs registered; login.mjs keeps its own gateway flow unchanged.
 *
 * The browser is opened with `open`; NOBLECLOAK_NO_BROWSER=1 only prints the URL
 * (headless / tests). The redirect port is the registered one (19284);
 * NOBLECLOAK_REDIRECT_PORT overrides it for tests only.
 */

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import {
  AuthDiscoveryError,
  clientRegisteredAt,
  decodeJwtClaims,
  discoverAuthServer,
  ensureRegisteredClientId,
  loadRegisteredClient,
} from './governance.mjs';

const SCOPES = 'mcp offline_access';
const DEFAULT_REDIRECT_PORT = 19284;
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/** `notSignedIn`: the person declined or never completed consent (exit 3); otherwise an infrastructure, port or config failure (exit 1). */
export class SignInError extends Error {
  constructor(message, { notSignedIn = false } = {}) {
    super(message);
    this.name = 'SignInError';
    this.notSignedIn = notSignedIn;
  }
}

function page(title, body) {
  return `<html><body><h2>${title}</h2><p>${body}</p></body></html>`;
}

export async function authorizeForResource({ resource, env = process.env, log = console.log } = {}) {
  let doc;
  try {
    doc = await discoverAuthServer(env);
  } catch (err) {
    throw new SignInError(err instanceof AuthDiscoveryError ? err.message : `OAuth discovery failed — ${err.message}`);
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new SignInError('the authorization server does not advertise authorization_endpoint/token_endpoint');
  }
  const port = Number(env.NOBLECLOAK_REDIRECT_PORT) || DEFAULT_REDIRECT_PORT;
  const redirectUri = `http://localhost:${port}/callback`;
  // The gateway token was issued to the persisted DCR client; registering a second client here
  // would overwrite client.json and make the gateway token's next refresh present the wrong
  // client_id (invalid_grant). Never replace an existing registration from this flow.
  const persisted = env.NOBLECLOAK_CLIENT_ID ? null : loadRegisteredClient(env);
  if (persisted?.clientId && persisted.redirectUri !== redirectUri) {
    throw new SignInError(
      `the registered OAuth client uses ${persisted.redirectUri}, not ${redirectUri} — unset NOBLECLOAK_REDIRECT_PORT, or run /noblecloak-login first`
    );
  }
  // A client registered at another authorization server (or by plugin 0.1.x,
  // which did not record where): only /noblecloak-login replaces it.
  if (persisted?.clientId && !clientRegisteredAt(persisted, doc.registration_endpoint)) {
    throw new SignInError(
      'the registered OAuth client belongs to another authorization server — run /noblecloak-login first'
    );
  }
  const clientId = await ensureRegisteredClientId({
    registrationEndpoint: doc.registration_endpoint,
    redirectUri,
    env,
  });

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const code = await new Promise((resolve, reject) => {
    let timer;
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const finish = (fn, html) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        clearTimeout(timer);
        server.close();
        fn();
      };
      // A request that does not carry OUR state is not part of this sign-in: answer
      // 400 and keep waiting, so a stray local request cannot abort the flow.
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Ignored', 'This request does not belong to the current sign-in.'));
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        const description = url.searchParams.get('error_description') || error;
        return finish(() => reject(new SignInError(description, { notSignedIn: true })), page('Sign-in failed', 'You can close this window.'));
      }
      const authCode = url.searchParams.get('code');
      if (!authCode) {
        return finish(() => reject(new SignInError('no authorization code received')), page('Sign-in failed', 'No code.'));
      }
      finish(() => resolve(authCode), page('Signed in', 'You can close this window and return to Claude Code.'));
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(new SignInError(`cannot listen on the callback port ${port} — ${err.message}`));
    });
    // Loopback only: the redirect_uri is localhost.
    server.listen(port, '127.0.0.1', () => {
      const authUrl = new URL(doc.authorization_endpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', SCOPES);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      // One resource per request, one audience per token (RFC 8707).
      authUrl.searchParams.set('resource', resource);
      log('Opening browser to approve access to the NobleCloak approvals API (a consent screen is shown)...');
      log(`If the browser doesn't open, visit: ${authUrl.toString()}`);
      // `open` is imported lazily: only an interactive sign-in needs it.
      if (env.NOBLECLOAK_NO_BROWSER !== '1') {
        import('open').then(({ default: open }) => open(authUrl.toString())).catch(() => {});
      }
    });
    timer = setTimeout(() => {
      server.close();
      reject(new SignInError('sign-in timed out after 5 minutes', { notSignedIn: true }));
    }, FLOW_TIMEOUT_MS);
  });

  let response;
  try {
    response = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new SignInError(`token endpoint unreachable — ${err.message}`);
  }
  if (!response.ok) {
    throw new SignInError(`token exchange failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
  const tokens = await response.json().catch(() => null);
  if (!tokens?.access_token) throw new SignInError('token endpoint returned no access_token');
  const claims = decodeJwtClaims(tokens.access_token) ?? {};
  // One audience per token (RFC 8707): if the AS ignored or defaulted `resource`
  // the token is for another API (e.g. the gateway) and must not be stored as ours.
  const audiences = [].concat(claims.aud ?? []);
  if (!audiences.includes(resource)) {
    throw new SignInError(
      `the authorization server issued a token whose audience (${audiences.join(', ') || 'none'}) is not ${resource}`
    );
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    scope: tokens.scope || SCOPES,
    authenticatedAt: new Date().toISOString(),
    ...(typeof claims.org_id === 'string' ? { orgId: claims.org_id } : {}),
  };
}
