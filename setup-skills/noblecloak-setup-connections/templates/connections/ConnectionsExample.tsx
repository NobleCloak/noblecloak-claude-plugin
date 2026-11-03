'use client';

import { Connections, useConnections } from '@noblecloak/react/connections';
import { AuthError, useAuthState } from '@noblecloak/react/auth';
import type { BrowserAuth } from '@noblecloak/react/auth';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { construct, logFault } from './auth';
import type { ExampleConfig } from './config';
import { ConfigProblem } from './ConfigProblem';

type Fetch = typeof globalThis.fetch;

export interface ConnectionsExampleProps {
  readonly config: ExampleConfig;
  /** Replaces the page's sign-in object (tests). */
  readonly auth?: BrowserAuth;
  /** Replaces `fetch` for the mock's token and the module's calls (tests). */
  readonly fetch?: Fetch;
}

const noopSubscribe = (): (() => void) => () => undefined;

/** False while the server renders and during hydration, true after. */
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

/**
 * The module. An OAuth consent leaves the page and comes back to it with `nc_connection`, `nc_result` and
 * `nc_error` in the address; the module reads them once and takes them out of the address.
 */
function Registrations({
  baseUrl,
  getToken,
  onSignIn,
  fetch,
}: {
  readonly baseUrl: string;
  readonly getToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  readonly onSignIn?: () => void;
  readonly fetch?: Fetch;
}) {
  const controller = useConnections({
    baseUrl,
    getToken,
    onFault: logFault,
    ...(fetch === undefined ? {} : { fetch }),
  });
  const mounted = useMounted();
  if (!mounted) return <p>Loading connections.</p>;
  return <Connections controller={controller} {...(onSignIn === undefined ? {} : { onSignIn })} />;
}

/** The administrator's token from the mock; a missing or empty one is named, not passed on as `undefined`. */
export async function fetchMockAdminToken(apiUrl: string, fetch?: Fetch): Promise<string> {
  const response = await (fetch ?? globalThis.fetch)(`${apiUrl}/__mock/tokens`);
  if (!response.ok) throw new AuthError('server_error', 'the mock did not give a token');
  const body = (await response.json().catch(() => undefined)) as { admin?: unknown } | undefined;
  if (typeof body?.admin !== 'string' || body.admin === '')
    throw new AuthError('server_error', 'the mock gave no administrator token');
  return body.admin;
}

/** Mock mode: the mock has no authorization server, so the page asks it for the administrator's token. */
function MockRegistrations({ apiUrl, fetch }: { readonly apiUrl: string; readonly fetch?: Fetch }) {
  const getToken = useCallback(() => fetchMockAdminToken(apiUrl, fetch), [apiUrl, fetch]);
  return (
    <>
      <p role="note" data-testid="mock-banner">
        Mock token: this page is using the administrator token of the mock at {apiUrl}. Nobody has
        signed in.
      </p>
      <Registrations
        baseUrl={apiUrl}
        getToken={getToken}
        {...(fetch === undefined ? {} : { fetch })}
      />
    </>
  );
}

function SignInPanel({
  state,
  onSignIn,
}: {
  readonly state: ReturnType<BrowserAuth['getSnapshot']>;
  readonly onSignIn: () => void;
}) {
  switch (state.status) {
    case 'redirecting':
    case 'completing':
      return <p role="status">Signing in.</p>;
    case 'denied':
      return (
        <div role="alert">
          <p>Access was not granted. You can try again.</p>
          <button type="button" onClick={onSignIn}>
            Try again
          </button>
        </div>
      );
    case 'error':
      return (
        <div role="alert">
          <p>Sign-in failed: {state.error.message}</p>
          <button type="button" onClick={onSignIn}>
            Try again
          </button>
        </div>
      );
    default:
      return (
        <div>
          {state.status === 'signed_out' && state.message !== undefined && (
            <p role="status">{state.message}</p>
          )}
          <p>Sign in to see the organisation&apos;s tool servers and link your own credentials.</p>
          <button type="button" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      );
  }
}

/** Real sign-in. Nothing here calls `signIn()` except a click: not on mount, and not after a denial. */
function SignedRegistrations({
  config,
  auth: given,
  fetch,
}: {
  readonly config: Extract<ExampleConfig, { mode: 'oidc' }>;
  readonly auth?: BrowserAuth;
  readonly fetch?: Fetch;
}) {
  const [created] = useState(() => construct(given, config, logFault));
  if (created.problem !== undefined) return <ConfigProblem problems={[created.problem]} />;
  return (
    <SignedRegistrationsBody
      config={config}
      auth={created.auth}
      {...(fetch === undefined ? {} : { fetch })}
    />
  );
}

function SignedRegistrationsBody({
  config,
  auth,
  fetch,
}: {
  readonly config: Extract<ExampleConfig, { mode: 'oidc' }>;
  readonly auth: BrowserAuth;
  readonly fetch?: Fetch;
}) {
  const state = useAuthState(auth);
  useEffect(() => {
    // One refresh from a stored token, without a redirect; a no-op when nothing is stored.
    void auth.restore();
  }, [auth]);
  const getToken = useCallback(
    (options?: { forceRefresh?: boolean }) => auth.getToken(options),
    [auth]
  );
  const signIn = useCallback(() => {
    void auth.signIn('/connections');
  }, [auth]);
  return state.status === 'signed_in' ? (
    <Registrations
      baseUrl={config.apiUrl}
      getToken={getToken}
      onSignIn={signIn}
      {...(fetch === undefined ? {} : { fetch })}
    />
  ) : (
    <SignInPanel state={state} onSignIn={signIn} />
  );
}

/** The connections page's client side: the mock's token, or a real sign-in, then the module. */
export function ConnectionsExample({ config, auth, fetch }: ConnectionsExampleProps) {
  return config.mode === 'mock' ? (
    <MockRegistrations apiUrl={config.apiUrl} {...(fetch === undefined ? {} : { fetch })} />
  ) : (
    <SignedRegistrations
      config={config}
      {...(auth === undefined ? {} : { auth })}
      {...(fetch === undefined ? {} : { fetch })}
    />
  );
}
