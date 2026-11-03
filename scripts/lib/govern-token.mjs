/**
 * A govern-audience user token for the plugin's scripts (propose-tool, setup). Stored beside the gateway token in
 * auth.json (scripts/lib/governance.mjs); minted by a PKCE sign-in with a consent screen when missing.
 * The scope that sign-in asks for is `mcp offline_access` (pkce-flow.mjs), so this token never resolves approvals (D-A84).
 */
import { getTokenFor, refreshTokenFor, saveTokenFor, TokenRefreshError } from './governance.mjs';
import { authorizeForResource } from './pkce-flow.mjs';

export const EXPIRY_BUFFER_MS = 60_000;

/** A usable govern token, signing in (PKCE + consent) when there is none. Throws SignInError. */
export async function governToken(resource) {
  let entry = getTokenFor(resource);
  if (entry && Date.now() > entry.expiresAt - EXPIRY_BUFFER_MS) {
    if (!entry.refreshToken) {
      entry = null;
    } else {
      try {
        entry = await refreshTokenFor(resource);
      } catch (err) {
        // Only a REJECTED grant means the consent is gone and a fresh sign-in is the
        // fix. Transient (5xx/network) and discovery failures keep the refresh token
        // valid, so re-consenting would not help: surface them (exit 1) instead.
        if (!(err instanceof TokenRefreshError) || err.transient) throw err;
        entry = null;
      }
    }
  }
  if (entry) return entry.accessToken;
  const fresh = await authorizeForResource({ resource });
  await saveTokenFor(resource, fresh);
  return fresh.accessToken;
}
