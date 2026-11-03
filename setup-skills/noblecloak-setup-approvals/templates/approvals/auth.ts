import { createBrowserAuth } from '@noblecloak/react/auth';
import type { BrowserAuth } from '@noblecloak/react/auth';

import type { ExampleConfig } from './config';

type SignInConfig = Extract<ExampleConfig, { mode: 'oidc' }>;

let shared: { readonly key: string; readonly auth: BrowserAuth } | undefined;

/**
 * The one sign-in object of the page: `/approvals` and `/approvals/callback` are separate routes of one
 * tab, and a second object over the same `sessionStorage` would be a second owner of one refresh token.
 * `resource` is the API's origin, so the access token's audience is the API.
 */
export function sharedAuth(config: SignInConfig, onFault?: (fault: unknown) => void): BrowserAuth {
  const key = JSON.stringify(config);
  if (shared?.key !== key) {
    shared = {
      key,
      auth: createBrowserAuth({
        issuer: config.issuer,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        resource: config.apiUrl,
        ...(onFault === undefined ? {} : { onFault }),
      }),
    };
  }
  return shared.auth;
}

/**
 * A sample `onFault` handler: a fault is a failure in a subscriber or in the host's store, off the call path.
 * It logs the fault's name and type only, never the object, which may carry a token or a response body.
 */
export function logFault(fault: unknown): void {
  const name = fault instanceof Error ? fault.name : 'non-Error';
  console.error(`noblecloak fault: ${name} (${typeof fault})`);
}

/** The page's sign-in object, or the message of the module's refusal (a throw is a configuration problem, not a crash). */
export function construct(
  given: BrowserAuth | undefined,
  config: Extract<ExampleConfig, { mode: 'oidc' }>,
  onFault: (fault: unknown) => void
):
  | { readonly auth: BrowserAuth; readonly problem?: undefined }
  | { readonly problem: string; readonly auth?: undefined } {
  if (given !== undefined) return { auth: given };
  try {
    return { auth: sharedAuth(config, onFault) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : 'sign-in could not be set up' };
  }
}
